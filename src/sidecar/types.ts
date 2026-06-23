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
	provider: 'gateway' | 'ollama' | null;
	model: { name: string; provider: string; gpu: string } | null;
	tokenBudget: number;
	podState: string;
	idleRemainingMs: number | null;
	indexed: boolean;
	fileCount: number;
}

/** RunPod / connection status from GET /runpod/status. */
export interface RunpodStatus {
	podState: string;
	podId?: string;
	gpuType?: string;
	costPerHr?: number;
	sessionMinutes?: number;
	estimatedCostUsd?: number;
	idleRemainingMs?: number | null;
	provider?: 'gateway' | 'ollama' | null;
	model?: string;
	lifecycleConfigured?: boolean;
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

/** How NeuroCode interprets messages (Cursor-style modes). */
export type ChatMode = 'auto' | 'explain' | 'plan' | 'implement' | 'agent';

/** User-attached file or selection for chat context. */
export interface ChatAttachment {
	path: string;
	name: string;
	kind: 'file' | 'selection';
	preview?: string;
	content?: string;
	lineStart?: number;
	lineEnd?: number;
}

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
	chatMode?: ChatMode;
	fixOnCheck?: boolean;
	maxSteps?: number;
	attachments?: ChatAttachment[];
	modelSelection?: 'auto' | 'manual';
	selectedModel?: string;
}

/** Unified chat response data. */
export interface AgentChatData extends AgentAskData {
	intent: ChatIntent;
	agentic?: boolean;
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
	readOnly?: boolean;
	allowWrites?: boolean;
	investigate?: boolean;
	routingReason?: string;
	pendingWrites?: Array<{ path: string; content: string }>;
	toolLog?: Array<{ tool: string; args?: unknown; result?: unknown }>;
	mode?: string;
}

/** SSE chunk from POST /agent/chat/stream or /agent/loop/stream. */
export interface AgentChatStreamChunk {
	type: 'intent' | 'token' | 'done' | 'error' | 'step' | 'tool_start' | 'tool_result';
	intent?: ChatIntent;
	investigate?: boolean;
	readOnly?: boolean;
	agentic?: boolean;
	model?: string;
	mode?: string;
	step?: number;
	maxSteps?: number;
	tool?: string;
	args?: unknown;
	result?: unknown;
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
	stepId: string | null;
	status: string;
	response?: string;
	diff?: string;
	shardsUsed: Array<{ file: string; reason: string; tokenCount: number }>;
	tokensUsed?: number;
	provider?: string;
}

/** Shard preview response. */
export interface ShardPreviewData {
	shards: Array<{ file: string; reason: string; tokenCount: number }>;
	totalTokens: number;
	budget: number;
	provider: string;
}
