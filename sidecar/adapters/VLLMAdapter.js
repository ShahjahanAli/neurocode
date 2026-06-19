import axios from 'axios';

/**
 * OpenAI-compatible vLLM adapter for RunPod-hosted models.
 */
export class VLLMAdapter {
	/**
	 * @param {object} config
	 * @param {string} config.baseUrl - RunPod proxy URL with /v1 suffix.
	 * @param {string} config.apiKey - RunPod API key.
	 * @param {string} config.model - Full model name on vLLM.
	 */
	constructor({ baseUrl, apiKey, model }) {
		this.baseUrl = baseUrl.replace(/\/$/, '');
		this.apiKey = apiKey;
		this.model = model;
		this.isQwen = model.toLowerCase().includes('qwen');
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
					throw new Error('RunPod API key invalid — check neurocode.llm.vllmApiKey');
				}
				if (err.response?.status === 404) {
					throw new Error(`Model not found on vLLM: ${this.model}`);
				}
			}
			throw err;
		}
	}

	/**
	 * Streaming chat — yields tokens as they arrive via SSE.
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
				if (!line.startsWith('data: ')) {
					continue;
				}
				const data = line.slice(6).trim();
				if (data === '[DONE]') {
					return;
				}
				try {
					const token = JSON.parse(data).choices?.[0]?.delta?.content;
					if (token) {
						yield token;
					}
				} catch {
					// malformed chunk — skip
				}
			}
		}
	}

	/**
	 * Check if vLLM is reachable and the model is loaded.
	 * @returns {Promise<boolean>}
	 */
	async isAvailable() {
		try {
			const res = await axios.get(`${this.baseUrl}/models`, {
				headers: this.headers,
				timeout: 10_000,
			});
			return res.data.data.some((m) => m.id === this.model);
		} catch {
			return false;
		}
	}

	/**
	 * @returns {Promise<{name: string, provider: string, gpu: string}>}
	 */
	async getModelInfo() {
		try {
			const res = await axios.get(`${this.baseUrl}/models`, {
				headers: this.headers,
				timeout: 10_000,
			});
			const m = res.data.data.find((x) => x.id === this.model);
			return { name: m?.id ?? this.model, provider: 'vllm-runpod', gpu: 'L4 24GB' };
		} catch {
			return { name: this.model, provider: 'vllm-runpod', gpu: 'L4 24GB' };
		}
	}
}
