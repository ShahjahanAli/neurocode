import { randomUUID } from 'crypto';

const RUNPOD_GQL = 'https://api.runpod.io/graphql';

const GQL = {
	startPod: `mutation($id:String!){ podResume(input:{podId:$id}){ id desiredStatus } }`,
	stopPod: `mutation($id:String!){ podStop(input:{podId:$id}){ id desiredStatus } }`,
	getPod: `query($id:String!){ pod(input:{podId:$id}){ id desiredStatus costPerHr runtime{ uptimeInSeconds } } }`,
};

/**
 * Manages RunPod pod start/stop, warmup, and idle auto-stop.
 */
export class RunPodLifecycleManager {
	/**
	 * @param {object} opts
	 * @param {string} opts.podId
	 * @param {string} opts.apiKey
	 * @param {string} opts.vllmUrl
	 * @param {string} opts.vllmApiKey
	 * @param {number} [opts.idleTimeoutMs]
	 * @param {boolean} [opts.autoStop]
	 * @param {import('node:sqlite').DatabaseSync} opts.db
	 */
	constructor({
		podId,
		apiKey,
		vllmUrl,
		vllmApiKey,
		idleTimeoutMs = 1_800_000,
		autoStop = true,
		db,
	}) {
		this.podId = podId;
		this.apiKey = apiKey;
		this.vllmUrl = vllmUrl.replace(/\/$/, '');
		this.vllmApiKey = vllmApiKey;
		this.idleTimeoutMs = idleTimeoutMs;
		this.autoStop = autoStop;
		this.db = db;
		/** @type {'stopped'|'starting'|'running'|'warm'|'stopping'|'unknown'} */
		this.state = 'unknown';
		/** @type {ReturnType<typeof setTimeout> | null} */
		this.idleTimer = null;
		/** @type {string | null} */
		this.currentSessionId = null;
		/** @type {((state: string) => void) | null} */
		this._onStateChange = null;
		this._idleTimerStartedAt = null;
	}

	/**
	 * Register a callback for pod state changes.
	 * @param {(state: string) => void} fn
	 */
	onStateChange(fn) {
		this._onStateChange = fn;
	}

	/**
	 * @param {string} newState
	 */
	_setState(newState) {
		this.state = newState;
		console.log(`[RunPod] State: ${newState}`);
		if (this._onStateChange) {
			this._onStateChange(newState);
		}
	}

	/**
	 * @param {string} query
	 * @param {object} variables
	 */
	async _gql(query, variables) {
		const res = await fetch(RUNPOD_GQL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({ query, variables }),
		});
		const data = await res.json();
		if (data.errors) {
			throw new Error(data.errors[0].message);
		}
		return data.data;
	}

	/** Start pod and wait until vLLM responds. */
	async start() {
		if (this.state === 'running' || this.state === 'warm' || this.state === 'starting') {
			return;
		}

		this._setState('starting');
		await this._gql(GQL.startPod, { id: this.podId });

		const sessionId = randomUUID();
		this.currentSessionId = sessionId;
		this.db.prepare(
			'INSERT INTO runpod_sessions (id, pod_id, started_at) VALUES (?, ?, ?)',
		).run(sessionId, this.podId, Date.now());

		const deadline = Date.now() + 180_000;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 5000));
			try {
				const res = await fetch(`${this.vllmUrl}/models`, {
					headers: { Authorization: `Bearer ${this.vllmApiKey}` },
					signal: AbortSignal.timeout(5000),
				});
				if (res.ok) {
					this._setState('running');
					await this.warmup();
					return;
				}
			} catch {
				// not ready yet
			}
		}

		throw new Error('RunPod pod failed to start within 3 minutes');
	}

	/** Send minimal warmup call to load model into GPU memory. */
	async warmup() {
		const t = Date.now();
		try {
			const res = await fetch(`${this.vllmUrl}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.vllmApiKey}`,
				},
				body: JSON.stringify({
					model: process.env.NEUROCODE_VLLM_MODEL,
					messages: [{ role: 'user', content: 'ready' }],
					max_tokens: 5,
					temperature: 0,
				}),
				signal: AbortSignal.timeout(60_000),
			});
			if (res.ok) {
				this._setState('warm');
				this.resetIdleTimer();
				return { ready: true, latencyMs: Date.now() - t };
			}
		} catch {
			// warmup failed — stay in running state
		}
		return { ready: false, latencyMs: Date.now() - t };
	}

	/** Stop the pod via RunPod API. */
	async stop() {
		if (this.state === 'stopped' || this.state === 'stopping') {
			return;
		}
		this._setState('stopping');
		clearTimeout(this.idleTimer ?? undefined);
		this.idleTimer = null;

		await this._gql(GQL.stopPod, { id: this.podId });

		if (this.currentSessionId) {
			this.db.prepare(
				'UPDATE runpod_sessions SET stopped_at = ? WHERE id = ?',
			).run(Date.now(), this.currentSessionId);
			this.currentSessionId = null;
		}

		this._setState('stopped');
	}

	/** Reset idle countdown after LLM activity. */
	resetIdleTimer() {
		clearTimeout(this.idleTimer ?? undefined);
		if (!this.autoStop) {
			return;
		}

		this._idleTimerStartedAt = Date.now();
		this.idleTimer = setTimeout(async () => {
			console.log('[RunPod] Idle timeout reached — stopping pod');
			await this.stop();
		}, this.idleTimeoutMs);
	}

	/** Ensure pod is ready before an LLM request. */
	async ensureReady() {
		if (this.state === 'warm' || this.state === 'running') {
			this.resetIdleTimer();
			return;
		}
		if (this.state === 'stopped' || this.state === 'unknown') {
			await this.start();
			return;
		}
		if (this.state === 'starting') {
			await new Promise((resolve, reject) => {
				const check = setInterval(() => {
					if (this.state === 'warm' || this.state === 'running') {
						clearInterval(check);
						resolve();
					}
					if (this.state === 'unknown' || this.state === 'stopped') {
						clearInterval(check);
						reject(new Error('Pod failed to start'));
					}
				}, 2000);
				setTimeout(() => {
					clearInterval(check);
					reject(new Error('Pod start timeout'));
				}, 200_000);
			});
		}
	}

	/** @returns {Promise<object>} Full pod status for health and UI. */
	async getStatus() {
		let costPerHr = 0;
		let uptimeSec = 0;
		try {
			const data = await this._gql(GQL.getPod, { id: this.podId });
			costPerHr = data.pod.costPerHr || 0;
			uptimeSec = data.pod.runtime?.uptimeInSeconds || 0;
		} catch {
			// API unreachable
		}

		const idleRemainingMs = this.idleTimer && this._idleTimerStartedAt
			? Math.max(0, this.idleTimeoutMs - (Date.now() - this._idleTimerStartedAt))
			: null;

		return {
			podState: this.state,
			podId: this.podId,
			gpuType: 'L4 24GB',
			costPerHr,
			sessionMinutes: Math.round(uptimeSec / 60),
			estimatedCostUsd: (uptimeSec / 3600) * costPerHr,
			idleRemainingMs,
		};
	}

	/** Clear timers on shutdown. */
	destroy() {
		clearTimeout(this.idleTimer ?? undefined);
		this.idleTimer = null;
	}
}
