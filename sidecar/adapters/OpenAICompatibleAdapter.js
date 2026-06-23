import axios from 'axios';

/**
 * Generic OpenAI-compatible chat completions adapter.
 * Works with LiteLLM, vLLM, OpenAI, RunPod proxies, and custom AI gateways.
 */
export class OpenAICompatibleAdapter {
	/**
	 * @param {object} config
	 * @param {string} config.baseUrl - API base URL with /v1 suffix.
	 * @param {string} config.apiKey - Bearer token (empty string if gateway has no auth).
	 * @param {string} config.model - Model id routed by the gateway.
	 * @param {string} [config.label] - Human-readable endpoint label for logs/UI.
	 */
	constructor({ baseUrl, apiKey, model, label }) {
		this.baseUrl = baseUrl.replace(/\/$/, '');
		this.apiKey = apiKey ?? '';
		this.model = model;
		this.label = label || 'LLM gateway';
		this.headers = {
			'Content-Type': 'application/json',
			...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
		};
	}

	/**
	 * Non-streaming chat completion.
	 * @param {Array<{role: string, content: string}>} messages
	 * @param {{temperature?: number, max_tokens?: number}} options
	 * @returns {Promise<string>}
	 */
	async chat(messages, options = {}) {
		try {
			const response = await axios.post(
				`${this.baseUrl}/chat/completions`,
				{
					model: this.model,
					messages,
					max_tokens: options.max_tokens ?? 1500,
					temperature: options.temperature ?? 0.1,
					stream: false,
				},
				{ headers: this.headers, timeout: 120_000 },
			);
			return response.data.choices?.[0]?.message?.content ?? (() => {
				const err = response.data?.error?.message ?? JSON.stringify(response.data ?? {}).slice(0, 300);
				throw new Error(`LLM gateway returned no choices: ${err}`);
			})();
		} catch (err) {
			if (axios.isAxiosError(err)) {
				if (err.response?.status === 401) {
					throw new Error('LLM API key rejected — check neurocode.llm.apiKey');
				}
				if (err.response?.status === 404) {
					throw new Error(`Model not found on gateway: ${this.model}`);
				}
				const detail = err.response?.data?.error?.message
					?? (typeof err.response?.data === 'string' ? err.response.data : JSON.stringify(err.response?.data ?? {}));
				throw new Error(`LLM gateway request failed (${err.response?.status ?? 'network'}): ${String(detail).slice(0, 300)}`);
			}
			throw err;
		}
	}

	/**
	 * Streaming chat completion via SSE.
	 * @param {Array<{role: string, content: string}>} messages
	 * @param {{temperature?: number, max_tokens?: number}} options
	 * @yields {string}
	 */
	async *stream(messages, options = {}) {
		let response;
		try {
			response = await axios.post(
				`${this.baseUrl}/chat/completions`,
				{
					model: this.model,
					messages,
					max_tokens: options.max_tokens ?? 1500,
					temperature: options.temperature ?? 0.1,
					stream: true,
				},
				{ headers: this.headers, responseType: 'stream', timeout: 120_000 },
			);
		} catch (err) {
			if (axios.isAxiosError(err)) {
				if (err.response?.status === 401) {
					throw new Error('LLM API key rejected — check neurocode.llm.apiKey');
				}
				if (err.code === 'ECONNABORTED') {
					throw new Error('LLM gateway request timed out — try again or reduce context size');
				}
				const body = err.response?.data;
				const detail = typeof body === 'string' ? body : JSON.stringify(body ?? {});
				throw new Error(`LLM gateway stream failed (${err.response?.status ?? 'network'}): ${detail.slice(0, 300)}`);
			}
			throw err;
		}

		let buffer = '';
		for await (const chunk of response.data) {
			buffer += chunk.toString();
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith('data:')) {
					continue;
				}
				const payload = trimmed.slice(5).trim();
				if (payload === '[DONE]') {
					return;
				}
				try {
					const parsed = JSON.parse(payload);
					const token = parsed.choices?.[0]?.delta?.content;
					if (token) {
						yield token;
					}
				} catch {
					// skip malformed SSE chunk
				}
			}
		}

		if (buffer.trim()) {
			const trimmed = buffer.trim();
			const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
			if (payload && payload !== '[DONE]') {
				try {
					const parsed = JSON.parse(payload);
					const token = parsed.choices?.[0]?.delta?.content;
					if (token) {
						yield token;
					}
				} catch {
					// skip trailing partial chunk
				}
			}
		}
	}

	/**
	 * Lists models exposed by the gateway.
	 * @returns {Promise<Array<{ id: string, owned_by?: string }>>}
	 */
	async listModels() {
		if (!this.baseUrl) {
			return [];
		}
		try {
			const res = await axios.get(`${this.baseUrl}/models`, {
				headers: this.headers,
				timeout: 15_000,
			});
			const raw = res.data?.data ?? res.data?.models ?? [];
			if (!Array.isArray(raw)) {
				return this.model ? [{ id: this.model }] : [];
			}
			return raw
				.map((m) => ({
					id: String(m.id ?? m.name ?? '').trim(),
					owned_by: m.owned_by,
				}))
				.filter((m) => m.id && !/embed/i.test(m.id));
		} catch {
			return this.model ? [{ id: this.model }] : [];
		}
	}

	/**
	 * @param {string} model
	 */
	setModel(model) {
		this.model = model;
	}

	/**
	 * @returns {Promise<boolean>} True when the gateway responds to GET /v1/models.
	 * Does not validate neurocode.llm.model — use chat/completions for model-specific errors.
	 */
	async isAvailable() {
		if (!this.baseUrl) {
			return false;
		}
		try {
			const res = await axios.get(`${this.baseUrl}/models`, {
				headers: this.headers,
				timeout: 10_000,
			});
			return res.status >= 200 && res.status < 300;
		} catch {
			return false;
		}
	}

	/**
	 * @returns {Promise<{name: string, provider: string, gpu: string, endpoint?: string}>}
	 */
	async getModelInfo() {
		try {
			const res = await axios.get(`${this.baseUrl}/models`, {
				headers: this.headers,
				timeout: 10_000,
			});
			const models = res.data?.data ?? [];
			const match = models.find((m) => m.id === this.model);
			return {
				name: match?.id ?? this.model,
				provider: 'gateway',
				gpu: 'remote',
				endpoint: this.baseUrl,
			};
		} catch {
			return {
				name: this.model,
				provider: 'gateway',
				gpu: 'remote',
				endpoint: this.baseUrl,
			};
		}
	}
}
