import axios from 'axios';

/**
 * OpenAI-compatible chat completions adapter (api.openai.com or compatible proxies).
 */
export class OpenAIAdapter {
	/**
	 * @param {object} config
	 * @param {string} config.baseUrl - API base URL with /v1 suffix.
	 * @param {string} config.apiKey - API key.
	 * @param {string} config.model - Model id.
	 */
	constructor({ baseUrl, apiKey, model }) {
		this.baseUrl = baseUrl.replace(/\/$/, '');
		this.apiKey = apiKey;
		this.model = model;
		this.headers = {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
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
			return response.data.choices[0].message.content;
		} catch (err) {
			if (axios.isAxiosError(err)) {
				if (err.response?.status === 401) {
					throw new Error('OpenAI API key invalid — check neurocode.llm.openaiApiKey');
				}
				throw new Error(`OpenAI request failed: ${err.response?.data?.error?.message ?? err.message}`);
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
		const response = await axios.post(
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
	}

	/**
	 * @returns {Promise<boolean>}
	 */
	async isAvailable() {
		try {
			await axios.get(`${this.baseUrl}/models`, {
				headers: this.headers,
				timeout: 10_000,
			});
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * @returns {Promise<{name: string, provider: string, gpu: string}>}
	 */
	async getModelInfo() {
		return { name: this.model, provider: 'openai', gpu: 'cloud' };
	}
}
