import { VLLMAdapter } from '../adapters/VLLMAdapter.js';
import { OllamaAdapter } from '../adapters/OllamaAdapter.js';
import { OpenAIAdapter } from '../adapters/OpenAIAdapter.js';

/** @type {import('../adapters/VLLMAdapter.js').VLLMAdapter | import('../adapters/OllamaAdapter.js').OllamaAdapter | import('../adapters/OpenAIAdapter.js').OpenAIAdapter | null} */
let _adapter = null;

/** @type {'vllm' | 'ollama' | 'openai' | null} */
let _adapterType = null;

/**
 * Routes LLM requests to vLLM (RunPod), OpenAI, or Ollama with optional fallback.
 */
export class LLMRouter {
	/**
	 * Returns the best available adapter.
	 * @param {object | null} config - Optional env-derived config override.
	 * @returns {Promise<import('../adapters/VLLMAdapter.js').VLLMAdapter | import('../adapters/OllamaAdapter.js').OllamaAdapter | import('../adapters/OpenAIAdapter.js').OpenAIAdapter>}
	 */
	static async getAdapter(config = null) {
		const cfg = config || LLMRouter._readEnvConfig();
		const airgap = process.env.NEUROCODE_AIRGAP === 'true';

		if (!airgap && cfg.provider === 'openai' && cfg.openaiApiKey) {
			const openai = new OpenAIAdapter({
				baseUrl: cfg.openaiUrl || 'https://api.openai.com/v1',
				apiKey: cfg.openaiApiKey,
				model: cfg.openaiModel || 'gpt-4o-mini',
			});

			const available = await openai.isAvailable().catch(() => false);
			if (available) {
				if (_adapterType !== 'openai') {
					console.log(`[LLMRouter] Using OpenAI: ${cfg.openaiModel}`);
					_adapterType = 'openai';
				}
				_adapter = openai;
				return openai;
			}

			const allowFallback = process.env.NEUROCODE_LLM_FALLBACK === 'true';
			if (!allowFallback) {
				throw new Error(
					'OpenAI is unreachable. Check neurocode.llm.openaiUrl and neurocode.llm.openaiApiKey. ' +
					'Set neurocode.llm.fallbackToOllama to true to use local Ollama as backup.',
				);
			}
			console.warn('[LLMRouter] OpenAI unavailable — falling back to Ollama');
		}

		if (!airgap && cfg.provider === 'vllm' && cfg.vllmUrl) {
			const vllm = new VLLMAdapter({
				baseUrl: cfg.vllmUrl,
				apiKey: cfg.vllmApiKey,
				model: cfg.vllmModel,
			});

			const available = await vllm.isAvailable().catch(() => false);
			if (available) {
				if (_adapterType !== 'vllm') {
					console.log(`[LLMRouter] Using vLLM: ${cfg.vllmModel} on RunPod`);
					_adapterType = 'vllm';
				}
				_adapter = vllm;
				return vllm;
			}

			const allowFallback = process.env.NEUROCODE_LLM_FALLBACK === 'true';
			if (!allowFallback) {
				throw new Error(
					'RunPod vLLM is unreachable. Check neurocode.llm.vllmUrl and neurocode.llm.vllmApiKey. ' +
					'Set neurocode.llm.fallbackToOllama to true to use local Ollama as backup.',
				);
			}

			console.warn('[LLMRouter] vLLM unavailable — falling back to Ollama');
		} else if (airgap) {
			console.log('[LLMRouter] Air-gap mode — Ollama only');
		}

		const ollama = new OllamaAdapter({
			baseUrl: cfg.ollamaUrl || 'http://localhost:11434',
			model: cfg.ollamaModel || 'qwen2.5-coder:7b',
		});
		if (_adapterType !== 'ollama') {
			console.log(`[LLMRouter] Using Ollama: ${cfg.ollamaModel}`);
			_adapterType = 'ollama';
		}
		_adapter = ollama;
		return ollama;
	}

	/** @returns {'vllm' | 'ollama' | 'openai' | null} */
	static getActiveProvider() {
		return _adapterType;
	}

	/** @returns {number} Dynamic shard token budget based on active provider. */
	static getTokenBudget() {
		const manual = parseInt(process.env.SHARD_MAX_TOKENS || '0', 10);
		if (manual > 0) {
			return manual;
		}
		if (_adapterType === 'vllm' || _adapterType === 'openai') {
			return 6000;
		}
		return 3500;
	}

	/** @returns {object} Environment-derived LLM configuration. */
	static _readEnvConfig() {
		return {
			provider: process.env.NEUROCODE_LLM_PROVIDER || 'vllm',
			vllmUrl: process.env.NEUROCODE_VLLM_URL || '',
			vllmApiKey: process.env.NEUROCODE_VLLM_KEY || '',
			vllmModel: process.env.NEUROCODE_VLLM_MODEL || 'Qwen/Qwen2.5-Coder-32B-Instruct-AWQ',
			openaiUrl: process.env.NEUROCODE_OPENAI_URL || 'https://api.openai.com/v1',
			openaiApiKey: process.env.NEUROCODE_OPENAI_KEY || '',
			openaiModel: process.env.NEUROCODE_OPENAI_MODEL || 'gpt-4o-mini',
			ollamaUrl: process.env.NEUROCODE_OLLAMA_URL || 'http://localhost:11434',
			ollamaModel: process.env.NEUROCODE_OLLAMA_MODEL || 'qwen2.5-coder:7b',
		};
	}
}
