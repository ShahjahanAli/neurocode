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
	indexed?: boolean;
	fileCount?: number;
}

/** Chat intent modes routed by the orchestrator. */
export type ChatIntent = 'chat' | 'plan' | 'edit';

/** Conversation turn for multi-turn chat. */
export interface ChatTurn {
	role: 'user' | 'assistant';
	content: string;
}

/** Unified chat request (Cursor-like). */
export interface AgentChatRequest {
	task: string;
	activeFile?: string;
	cursorLine?: number;
	projectPath: string;
	history?: ChatTurn[];
	forceIntent?: ChatIntent;
}

/** Unified chat response data. */
export interface AgentChatData extends AgentAskData {
	intent: ChatIntent;
	planId?: string;
	steps?: Array<{
		id: string;
		description: string;
		dependsOn: string[];
		status: string;
	}>;
	indexed?: boolean;
	fileCount?: number;
	filesApplied?: Array<{ file: string; action: 'created' | 'updated' }>;
	truncated?: boolean;
}

/** SSE chunk from POST /agent/chat/stream. */
export interface AgentChatStreamChunk {
	type: 'intent' | 'token' | 'done' | 'error';
	intent?: ChatIntent;
	content?: string;
	data?: AgentChatData;
	message?: string;
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
