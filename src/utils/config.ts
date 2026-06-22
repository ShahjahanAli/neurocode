import * as vscode from 'vscode';

/** LLM provider configuration. */
export interface LlmConfig {
	provider: 'ollama' | 'vllm' | 'openai';
	ollamaUrl: string;
	ollamaModel: string;
	vllmUrl: string;
	vllmApiKey: string;
	vllmModel: string;
	fallbackToOllama: boolean;
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

/** RunPod pod lifecycle configuration. */
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
	chat: { autoApply: boolean };
}

/**
 * Reads all neurocode.* settings from VS Code configuration.
 * @returns Typed configuration object for extension and sidecar env vars.
 */
export function getConfig(): NeuroCodeConfig {
	const cfg = vscode.workspace.getConfiguration('neurocode');

	return {
		llm: {
			provider: cfg.get<'ollama' | 'vllm' | 'openai'>('llm.provider', 'ollama'),
			ollamaUrl: cfg.get<string>('llm.ollamaUrl', 'http://localhost:11434'),
			ollamaModel: cfg.get<string>('llm.ollamaModel', 'qwen2.5-coder:7b'),
			vllmUrl: cfg.get<string>('llm.vllmUrl', ''),
			vllmApiKey: cfg.get<string>('llm.vllmApiKey', ''),
			vllmModel: cfg.get<string>('llm.vllmModel', 'Qwen/Qwen2.5-Coder-7B-Instruct'),
			fallbackToOllama: cfg.get<boolean>('llm.fallbackToOllama', false),
		},
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
		chat: {
			autoApply: cfg.get<boolean>('chat.autoApply', true),
		},
	};
}
