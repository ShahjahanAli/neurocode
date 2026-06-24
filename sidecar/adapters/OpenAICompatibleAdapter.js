import axios from 'axios';
import { safeJsonPreview } from '../utils/safeJson.js';

/**
 * @param {unknown} data
 * @returns {Promise<string | null>}
 */
async function readStreamErrorBody(data) {
	if (!data || typeof data !== 'object' || typeof data.pipe !== 'function') {
		return null;
	}
	const chunks = [];
	try {
		for await (const chunk of data) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			if (chunks.reduce((n, c) => n + c.length, 0) > 4096) {
				break;
			}
		}
	} catch {
		return null;
	}
	const text = Buffer.concat(chunks).toString('utf8').trim();
	if (!text) {
		return null;
	}
	try {
		const parsed = JSON.parse(text);
		return String(parsed?.error?.message ?? parsed?.message ?? text);
	} catch {
		return text;
	}
}

/**
 * @param {unknown} err
 * @param {string} [streamDetail]
 * @returns {string}
 */
function formatAxiosError(err, streamDetail = '') {
	if (!axios.isAxiosError(err)) {
		return err instanceof Error ? err.message : String(err);
	}
	if (streamDetail) {
		return streamDetail.slice(0, 400);
	}
	if (err.code === 'ECONNABORTED') {
		return 'request timed out';
	}
	if (err.code === 'ECONNREFUSED') {
		return 'connection refused — is the gateway running?';
	}
	const status = err.response?.status ?? 'network';
	const data = err.response?.data;
	if (typeof data === 'string') {
		return data.slice(0, 400);
	}
	if (data && typeof data === 'object' && typeof data.pipe === 'function') {
		if (status === 402) {
			return 'insufficient credits or billing required on your LLM gateway';
		}
		return `HTTP ${status} (stream response)`;
	}
	if (data?.error?.message) {
		return String(data.error.message).slice(0, 400);
	}
	if (data && typeof data === 'object') {
		return safeJsonPreview(data, 400);
	}
	return `HTTP ${status}`;
}

/**
 * @param {import('axios').AxiosError} err
 * @param {'chat' | 'stream'} kind
 * @param {string} model
 * @param {string} [streamDetail]
 * @returns {Error}
 */
function toGatewayError(err, kind, model, streamDetail = '') {
	const status = err.response?.status ?? 'network';
	const detail = formatAxiosError(err, streamDetail);
	if (status === 401) {
		return new Error('LLM API key rejected — check neurocode.llm.apiKey');
	}
	if (status === 402) {
		return new Error(
			`LLM gateway payment required (402)${detail ? `: ${detail}` : ''}. `
			+ 'Add credits or fix billing on your gateway (e.g. OpenRouter dashboard).',
		);
	}
	if (status === 404) {
		return new Error(`Model not found on gateway: ${model}`);
	}
	if (err.code === 'ECONNABORTED') {
		return new Error('LLM gateway request timed out — try again or reduce context size');
	}
	const prefix = kind === 'stream' ? 'LLM gateway stream failed' : 'LLM gateway request failed';
	return new Error(`${prefix} (${status}): ${detail}`);
}

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
				throw toGatewayError(err, 'chat', this.model);
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
				const streamDetail = await readStreamErrorBody(err.response?.data);
				throw toGatewayError(err, 'stream', this.model, streamDetail ?? '');
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
