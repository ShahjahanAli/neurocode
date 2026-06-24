import * as vscode from 'vscode';
import type { ChatMode } from '../sidecar/types';

/** LLM backend mode. */
export type LlmMode = 'gateway' | 'ollama';

/** LLM configuration — gateway is any OpenAI-compatible API endpoint. */
export interface LlmConfig {
	mode: LlmMode;
	/** OpenAI-compatible base URL (e.g. LiteLLM, vLLM, RunPod proxy, OpenAI). */
	apiBaseUrl: string;
	apiKey: string;
	model: string;
	/** Optional display label for the gateway in logs/UI. */
	gatewayLabel: string;
	modelSelection: 'auto' | 'manual';
	selectedModel: string;
	/** Local Ollama — used for ollama mode, embeddings, and optional fallback. */
	ollamaUrl: string;
	ollamaModel: string;
	fallbackToOllama: boolean;
	/** Cap on max_tokens sent to the gateway per request. */
	maxOutputTokens: number;
}

/** Shard assembly limits. */
export interface ShardConfig {
	maxTokens: number;
	maxFiles: number;
}

/** Indexing configuration. */
export interface IndexingConfig {
	excludePatterns: string[];
	autoIndex: boolean;
}

/** Sidecar process configuration. */
export interface SidecarConfig {
	port: number;
}

/** Optional RunPod pod lifecycle (independent of LLM gateway URL). */
export interface RunpodConfig {
	apiKey: string;
	podId: string;
	autoStart: boolean;
	autoStop: boolean;
	idleTimeoutMinutes: number;
}

/** Air-gap mode configuration. */
export interface AirgapConfig {
	enabled: boolean;
	auditLog: boolean;
}

/** Full NeuroCode extension configuration. */
export interface NeuroCodeConfig {
	llm: LlmConfig;
	shard: ShardConfig;
	indexing: IndexingConfig;
	sidecar: SidecarConfig;
	runpod: RunpodConfig;
	airgap: AirgapConfig;
	heatmap: { enabled: boolean; style: 'gutter' | 'inline' | 'both' };
	genome: { enabled: boolean; cloudSync: boolean };
	memory: { enabled: boolean; maxRecords: number };
	review: { parallelAgents: number; agents: string[] };
	drift: { enabled: boolean; threshold: number };
	crossrepo: { enabled: boolean; sharedIndexPath: string };
	ui: { chatLocation: 'right' | 'left' };
	chat: {
		mode: ChatMode;
		autoApply: boolean;
		autoSave: boolean;
		autoContinue: boolean;
		maxContinueRounds: number;
		fixOnCheck: boolean;
		agentMaxSteps: number;
		agentToolMaxSteps: number;
		maxAttachments: number;
		intentRouter: 'heuristic' | 'hybrid' | 'llm';
		investigateMaxSteps: number;
	};
	feedback: { enabled: boolean };
}

/**
 * Resolves LLM settings with backward compatibility for legacy vllm/openai keys.
 * @param cfg - VS Code configuration namespace.
 * @returns Normalized LLM config.
 */
function resolveLlmConfig(cfg: vscode.WorkspaceConfiguration): LlmConfig {
	const legacyProvider = cfg.get<string>('llm.provider', '');
	const mode: LlmMode = cfg.get<LlmMode>('llm.mode')
		?? (legacyProvider === 'ollama' ? 'ollama' : 'gateway');

	const apiBaseUrl = (
		cfg.get<string>('llm.apiBaseUrl', '')
		|| cfg.get<string>('llm.vllmUrl', '')
		|| cfg.get<string>('llm.openaiUrl', '')
	).trim();

	const apiKey = (
		cfg.get<string>('llm.apiKey', '')
		|| cfg.get<string>('llm.vllmApiKey', '')
		|| cfg.get<string>('llm.openaiApiKey', '')
	).trim();

	const model = (
		cfg.get<string>('llm.model', '')
		|| cfg.get<string>('llm.vllmModel', '')
		|| cfg.get<string>('llm.openaiModel', '')
		|| 'qwen2.5-coder:7b'
	).trim();

	return {
		mode,
		apiBaseUrl,
		apiKey,
		model,
		gatewayLabel: cfg.get<string>('llm.gatewayLabel', 'LLM gateway'),
		modelSelection: cfg.get<'auto' | 'manual'>('llm.modelSelection', 'auto'),
		selectedModel: cfg.get<string>('llm.selectedModel', '').trim(),
		ollamaUrl: cfg.get<string>('llm.ollamaUrl', 'http://localhost:11434'),
		ollamaModel: cfg.get<string>('llm.ollamaModel', 'qwen2.5-coder:7b'),
		fallbackToOllama: cfg.get<boolean>('llm.fallbackToOllama', false),
		maxOutputTokens: cfg.get<number>('llm.maxOutputTokens', 1024),
	};
}

/**
 * @returns Webview view id for the chat panel based on UI settings.
 */
export function getChatViewId(): string {
	return getConfig().ui.chatLocation === 'left'
		? 'neurocode.chatViewLeft'
		: 'neurocode.rightPanel';
}

/**
 * Reads all neurocode.* settings from VS Code configuration.
 * @returns Typed configuration object for extension and sidecar env vars.
 */
export function getConfig(): NeuroCodeConfig {
	const cfg = vscode.workspace.getConfiguration('neurocode');

	return {
		llm: resolveLlmConfig(cfg),
		shard: {
			maxTokens: cfg.get<number>('shard.maxTokens', 0),
			maxFiles: cfg.get<number>('shard.maxFiles', 8),
		},
		indexing: {
			excludePatterns: cfg.get<string[]>('indexing.excludePatterns', [
				'node_modules', '.git', 'dist', 'build', '.next',
			]),
			autoIndex: cfg.get<boolean>('indexing.autoIndex', true),
		},
		sidecar: {
			port: cfg.get<number>('sidecar.port', 39291),
		},
		runpod: {
			apiKey: cfg.get<string>('runpod.apiKey', ''),
			podId: cfg.get<string>('runpod.podId', ''),
			autoStart: cfg.get<boolean>('runpod.autoStart', false),
			autoStop: cfg.get<boolean>('runpod.autoStop', true),
			idleTimeoutMinutes: cfg.get<number>('runpod.idleTimeoutMinutes', 30),
		},
		airgap: {
			enabled: cfg.get<boolean>('airgap.enabled', false),
			auditLog: cfg.get<boolean>('airgap.auditLog', true),
		},
		heatmap: {
			enabled: cfg.get<boolean>('heatmap.enabled', true),
			style: cfg.get<'gutter' | 'inline' | 'both'>('heatmap.style', 'gutter'),
		},
		genome: {
			enabled: cfg.get<boolean>('genome.enabled', false),
			cloudSync: cfg.get<boolean>('genome.cloudSync', false),
		},
		memory: {
			enabled: cfg.get<boolean>('memory.enabled', true),
			maxRecords: cfg.get<number>('memory.maxRecords', 5000),
		},
		review: {
			parallelAgents: cfg.get<number>('review.parallelAgents', 4),
			agents: cfg.get<string[]>('review.agents', [
				'architect', 'security', 'performance', 'test',
			]),
		},
		drift: {
			enabled: cfg.get<boolean>('drift.enabled', true),
			threshold: cfg.get<number>('drift.threshold', 0.15),
		},
		crossrepo: {
			enabled: cfg.get<boolean>('crossrepo.enabled', false),
			sharedIndexPath: cfg.get<string>('crossrepo.sharedIndexPath', ''),
		},
		ui: {
			chatLocation: cfg.get<'right' | 'left'>('ui.chatLocation', 'right'),
		},
		chat: {
			mode: cfg.get<ChatMode>('chat.mode', 'auto'),
			autoApply: cfg.get<boolean>('chat.autoApply', true),
			autoSave: cfg.get<boolean>('chat.autoSave', true),
			autoContinue: cfg.get<boolean>('chat.autoContinue', true),
			maxContinueRounds: cfg.get<number>('chat.maxContinueRounds', 8),
			fixOnCheck: cfg.get<boolean>('chat.fixOnCheck', true),
			agentMaxSteps: cfg.get<number>('chat.agentMaxSteps', 8),
			agentToolMaxSteps: cfg.get<number>('chat.agentToolMaxSteps', 10),
			maxAttachments: cfg.get<number>('chat.maxAttachments', 5),
			intentRouter: cfg.get<'heuristic' | 'hybrid' | 'llm'>('chat.intentRouter', 'llm'),
			investigateMaxSteps: cfg.get<number>('chat.investigateMaxSteps', 8),
		},
		feedback: {
			enabled: cfg.get<boolean>('feedback.enabled', true),
		},
	};
}
