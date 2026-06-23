import axios from 'axios';

/**
 * Ollama local LLM adapter.
 */
export class OllamaAdapter {
	/**
	 * @param {object} config
	 * @param {string} config.baseUrl - Ollama base URL.
	 * @param {string} config.model - Model tag.
	 */
	constructor({ baseUrl, model }) {
		this.baseUrl = baseUrl.replace(/\/$/, '');
		this.model = model;
	}

	/**
	 * Non-streaming chat via Ollama /api/chat.
	 * @param {Array<{role: string, content: string}>} messages
	 * @param {{temperature?: number, max_tokens?: number}} options
	 * @returns {Promise<string>}
	 */
	async chat(messages, options = {}) {
		const response = await axios.post(
			`${this.baseUrl}/api/chat`,
			{
				model: this.model,
				messages,
				stream: false,
				options: {
					temperature: options.temperature ?? 0.1,
					num_predict: options.max_tokens ?? 1500,
				},
			},
			{ timeout: 60_000 },
		);
		return response.data.message.content;
	}

	/**
	 * Streaming chat via Ollama NDJSON stream.
	 * @param {Array<{role: string, content: string}>} messages
	 * @param {{temperature?: number, max_tokens?: number}} options
	 * @yields {string}
	 */
	async *stream(messages, options = {}) {
		const response = await axios.post(
			`${this.baseUrl}/api/chat`,
			{
				model: this.model,
				messages,
				stream: true,
				options: {
					temperature: options.temperature ?? 0.1,
					num_predict: options.max_tokens ?? 1500,
				},
			},
			{ responseType: 'stream', timeout: 120_000 },
		);

		let buffer = '';
		for await (const chunk of response.data) {
			buffer += chunk.toString();
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				if (!line.trim()) {
					continue;
				}
				try {
					const parsed = JSON.parse(line);
					const token = parsed.message?.content;
					if (token) {
						yield token;
					}
				} catch {
					// skip malformed line
				}
			}
		}
	}

	/**
	 * Lists locally installed Ollama models.
	 * @returns {Promise<Array<{ id: string }>>}
	 */
	async listModels() {
		try {
			const res = await axios.get(`${this.baseUrl}/api/tags`, { timeout: 10_000 });
			const models = res.data?.models ?? [];
			return models
				.map((m) => ({ id: String(m.name ?? '').replace(/:latest$/, '') }))
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
	 * @returns {Promise<boolean>}
	 */
	async isAvailable() {
		try {
			const res = await axios.get(`${this.baseUrl}/api/tags`, { timeout: 10_000 });
			return res.data.models?.some((m) => m.name === this.model || m.name.startsWith(`${this.model}:`));
		} catch {
			return false;
		}
	}

	/**
	 * @returns {Promise<{name: string, provider: string, gpu: string}>}
	 */
	async getModelInfo() {
		return { name: this.model, provider: 'ollama', gpu: 'local' };
	}
}
