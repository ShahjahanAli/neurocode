import { OpenAICompatibleAdapter } from '../adapters/OpenAICompatibleAdapter.js';
import { OllamaAdapter } from '../adapters/OllamaAdapter.js';

/** @type {OpenAICompatibleAdapter | OllamaAdapter | null} */
let _adapter = null;

/** @type {'gateway' | 'ollama' | null} */
let _adapterType = null;

/**
 * Routes LLM requests to an OpenAI-compatible gateway or local Ollama.
 */
export class LLMRouter {
	/**
	 * Returns the active LLM adapter.
	 * @param {object | null} config - Optional env-derived config override.
	 * @returns {Promise<OpenAICompatibleAdapter | OllamaAdapter>}
	 */
	static async getAdapter(config = null) {
		const cfg = config || LLMRouter._readEnvConfig();
		const airgap = process.env.NEUROCODE_AIRGAP === 'true';
		const mode = cfg.mode;

		if (!airgap && mode === 'gateway' && cfg.apiBaseUrl) {
			const gateway = new OpenAICompatibleAdapter({
				baseUrl: cfg.apiBaseUrl,
				apiKey: cfg.apiKey,
				model: cfg.model,
				label: cfg.gatewayLabel,
			});

			const available = await gateway.isAvailable().catch(() => false);
			if (available) {
				if (_adapterType !== 'gateway') {
					console.log(`[LLMRouter] Using gateway: ${cfg.model} @ ${cfg.apiBaseUrl}`);
					_adapterType = 'gateway';
				}
				_adapter = gateway;
				return gateway;
			}

			const allowFallback = process.env.NEUROCODE_LLM_FALLBACK === 'true';
			if (!allowFallback) {
				throw new Error(
					`LLM gateway is unreachable at ${cfg.apiBaseUrl}. ` +
					'Check neurocode.llm.apiBaseUrl and neurocode.llm.apiKey (URL must end with /v1). ' +
					'Set neurocode.llm.fallbackToOllama to true to use local Ollama as backup.',
				);
			}
			console.warn('[LLMRouter] Gateway unavailable — falling back to Ollama');
		} else if (airgap && mode === 'gateway') {
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

	/** @returns {'gateway' | 'ollama' | null} */
	static getActiveProvider() {
		return _adapterType;
	}

	/**
	 * Lists models from the configured gateway or local Ollama.
	 * @returns {Promise<Array<{ id: string, owned_by?: string }>>}
	 */
	static async listModels() {
		const cfg = LLMRouter._readEnvConfig();
		const airgap = process.env.NEUROCODE_AIRGAP === 'true';

		if (!airgap && cfg.mode === 'gateway' && cfg.apiBaseUrl) {
			const gateway = new OpenAICompatibleAdapter({
				baseUrl: cfg.apiBaseUrl,
				apiKey: cfg.apiKey,
				model: cfg.model,
			});
			const models = await gateway.listModels();
			// Gateway mode: never mix in Ollama models (misleading when chat still routes to gateway).
			return models;
		}

		const ollama = new OllamaAdapter({
			baseUrl: cfg.ollamaUrl,
			model: cfg.ollamaModel,
		});
		return ollama.listModels();
	}

	/**
	 * Applies a per-request model override on the active adapter.
	 * @param {OpenAICompatibleAdapter | OllamaAdapter} adapter
	 * @param {string} model
	 */
	static applyModel(adapter, model) {
		if (model && typeof adapter.setModel === 'function') {
			adapter.setModel(model);
		}
	}

	/** @returns {number} Max completion tokens for gateway/Ollama chat calls. */
	static getMaxOutputTokens() {
		const parsed = parseInt(process.env.NEUROCODE_LLM_MAX_OUTPUT_TOKENS || '2048', 10);
		return Number.isFinite(parsed) && parsed >= 64 ? parsed : 2048;
	}

	/** @returns {number} Higher cap for agent tool turns (write_file / search_replace). */
	static getAgentOutputTokens() {
		const base = LLMRouter.getMaxOutputTokens();
		return Math.min(8000, Math.max(base, 2048));
	}

	/** @returns {number} Dynamic shard token budget based on active backend. */
	static getTokenBudget() {
		const manual = parseInt(process.env.SHARD_MAX_TOKENS || '0', 10);
		if (manual > 0) {
			return manual;
		}
		return _adapterType === 'gateway' ? 6000 : 3500;
	}

	/**
	 * Normalizes legacy and new env vars into one config object.
	 * @returns {object}
	 */
	static _readEnvConfig() {
		const legacyProvider = process.env.NEUROCODE_LLM_PROVIDER || '';
		const mode = process.env.NEUROCODE_LLM_MODE
			|| (legacyProvider === 'ollama' ? 'ollama' : 'gateway');

		const apiBaseUrl = (
			process.env.NEUROCODE_LLM_API_URL
			|| process.env.NEUROCODE_VLLM_URL
			|| process.env.NEUROCODE_OPENAI_URL
			|| ''
		).trim();

		const apiKey = (
			process.env.NEUROCODE_LLM_API_KEY
			|| process.env.NEUROCODE_VLLM_KEY
			|| process.env.NEUROCODE_OPENAI_KEY
			|| ''
		).trim();

		const model = (
			process.env.NEUROCODE_LLM_MODEL
			|| process.env.NEUROCODE_VLLM_MODEL
			|| process.env.NEUROCODE_OPENAI_MODEL
			|| 'qwen2.5-coder:7b'
		).trim();

		return {
			mode,
			apiBaseUrl,
			apiKey,
			model,
			gatewayLabel: process.env.NEUROCODE_LLM_GATEWAY_LABEL || 'LLM gateway',
			ollamaUrl: process.env.NEUROCODE_OLLAMA_URL || 'http://localhost:11434',
			ollamaModel: process.env.NEUROCODE_OLLAMA_MODEL || 'qwen2.5-coder:7b',
		};
	}
}
