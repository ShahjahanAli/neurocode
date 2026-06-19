/** Standard sidecar API envelope. */
export interface SidecarResponse<T> {
	success: boolean;
	data?: T;
	error?: string;
}

/** Health endpoint payload from GET /health. */
export interface HealthData {
	status: string;
	airgap: boolean;
	provider: 'vllm' | 'ollama' | null;
	model: { name: string; provider: string; gpu: string } | null;
	tokenBudget: number;
	podState: string;
	idleRemainingMs: number | null;
	indexed: boolean;
	fileCount: number;
}

/** RunPod status from GET /runpod/status. */
export interface RunpodStatus {
	podState: string;
	podId?: string;
	gpuType?: string;
	costPerHr?: number;
	sessionMinutes?: number;
	estimatedCostUsd?: number;
	idleRemainingMs?: number | null;
}

/** Index job start response. */
export interface IndexStartData {
	jobId: string;
}

/** Index job progress. */
export interface IndexStatusData {
	status: 'running' | 'done' | 'failed';
	filesProcessed: number;
	totalFiles: number;
}

/** Agent ask request body. */
export interface AgentAskRequest {
	task: string;
	activeFile?: string;
	cursorLine?: number;
	projectPath: string;
	warmup?: boolean;
}

/** Agent ask response data. */
export interface AgentAskData {
	response: string;
	diff?: string;
	shardsUsed: Array<{ file: string; reason: string; tokenCount: number }>;
	attentionMap?: {
		inContext: Array<{ file: string; lineStart: number; lineEnd: number }>;
		cited: Array<{ file: string; lineStart: number; lineEnd: number }>;
		missed: Array<{ file: string; lineStart: number; lineEnd: number }>;
	};
	tokensUsed: number;
	budget: number;
	modelUsed: string;
	provider: string;
	latencyMs: number;
}

/** Plan creation response. */
export interface PlanData {
	planId: string;
	steps: Array<{
		id: string;
		description: string;
		dependsOn: string[];
		status: string;
	}>;
}

/** Plan step execution result. */
export interface PlanExecuteData {
	stepId: string;
	status: string;
	diff?: string;
	shardsUsed: Array<{ file: string; reason: string; tokenCount: number }>;
}

/** Shard preview response. */
export interface ShardPreviewData {
	shards: Array<{ file: string; reason: string; tokenCount: number }>;
	totalTokens: number;
	budget: number;
	provider: string;
}
