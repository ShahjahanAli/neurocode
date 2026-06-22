import type {
	AgentAskData,
	AgentAskRequest,
	AgentChatData,
	AgentChatRequest,
	AgentChatStreamChunk,
	HealthData,
	IndexStartData,
	IndexStatusData,
	PlanData,
	PlanExecuteData,
	RunpodStatus,
	ShardPreviewData,
	SidecarResponse,
} from './types';

/** SSE stream chunk handler. */
export type StreamHandler = (chunk: unknown) => void;

/**
 * Typed HTTP client for the NeuroCode sidecar REST + SSE API.
 */
export class SidecarClient {
	/**
	 * @param baseUrl - Sidecar base URL, e.g. http://127.0.0.1:39291
	 */
	constructor(private readonly baseUrl: string) {}

	/**
	 * Performs a GET request against the sidecar.
	 * @param path - API path starting with /
	 * @returns Parsed response envelope.
	 */
	async get<T>(path: string): Promise<SidecarResponse<T>> {
		const res = await fetch(`${this.baseUrl}${path}`, {
			method: 'GET',
			headers: { Accept: 'application/json' },
		});
		return this.parseResponse<T>(res);
	}

	/**
	 * Performs a POST request against the sidecar.
	 * @param path - API path starting with /
	 * @param body - JSON-serializable request body.
	 * @returns Parsed response envelope.
	 */
	async post<T>(path: string, body?: unknown): Promise<SidecarResponse<T>> {
		const res = await fetch(`${this.baseUrl}${path}`, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		return this.parseResponse<T>(res);
	}

	/**
	 * Opens an SSE stream from the sidecar.
	 * @param path - API path starting with /
	 * @param onChunk - Callback for each parsed SSE data payload.
	 * @param body - Optional POST body for stream initiation.
	 */
	async stream(path: string, onChunk: StreamHandler, body?: unknown): Promise<void> {
		const res = await fetch(`${this.baseUrl}${path}`, {
			method: body !== undefined ? 'POST' : 'GET',
			headers: {
				Accept: 'text/event-stream',
				'Content-Type': 'application/json',
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});

		if (!res.ok || !res.body) {
			throw new Error(`SSE request failed: ${res.status}`);
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				if (!line.startsWith('data: ')) {
					continue;
				}
				const data = line.slice(6).trim();
				if (!data || data === '[DONE]') {
					continue;
				}
				try {
					onChunk(JSON.parse(data) as unknown);
				} catch {
					onChunk(data);
				}
			}
		}
	}

	/**
	 * Performs a DELETE request against the sidecar.
	 * @param path - API path starting with /
	 * @returns Parsed response envelope.
	 */
	async delete<T>(path: string): Promise<SidecarResponse<T>> {
		const res = await fetch(`${this.baseUrl}${path}`, { method: 'DELETE' });
		return this.parseResponse<T>(res);
	}

	/** @returns Sidecar health and provider status. */
	health(): Promise<SidecarResponse<HealthData>> {
		return this.get<HealthData>('/health');
	}

	/** @param projectPath - Absolute workspace root to index. */
	startIndex(projectPath: string): Promise<SidecarResponse<IndexStartData>> {
		return this.post<IndexStartData>('/index', { projectPath });
	}

	/**
	 * @param jobId - Indexing job identifier.
	 * @returns Current indexing progress.
	 */
	indexStatus(jobId: string): Promise<SidecarResponse<IndexStatusData>> {
		return this.get<IndexStatusData>(`/index/status/${jobId}`);
	}

	/** @param request - Agent ask parameters. */
	askAgent(request: AgentAskRequest): Promise<SidecarResponse<AgentAskData>> {
		return this.post<AgentAskData>('/agent/ask', request);
	}

	/** @param request - Unified chat with intent routing and history. */
	chatAgent(request: AgentChatRequest): Promise<SidecarResponse<AgentChatData>> {
		return this.post<AgentChatData>('/agent/chat', request);
	}

	/**
	 * Streams a chat response via SSE.
	 * @param request - Chat request with optional conversation history.
	 * @param onChunk - Handler for intent, token, done, and error events.
	 * @returns Final assembled chat response from the done event.
	 */
	async chatStream(
		request: AgentChatRequest,
		onChunk: (chunk: AgentChatStreamChunk) => void,
	): Promise<AgentChatData> {
		let result: AgentChatData | undefined;

		await this.stream('/agent/chat/stream', (raw) => {
			const chunk = raw as AgentChatStreamChunk;
			onChunk(chunk);
			if (chunk.type === 'done' && chunk.data) {
				result = chunk.data;
			}
			if (chunk.type === 'error') {
				throw new Error(chunk.message ?? 'Chat stream failed');
			}
		}, request);

		if (!result) {
			throw new Error('Chat stream ended without a response');
		}
		return result;
	}

	/**
	 * @param task - High-level task description.
	 * @param projectPath - Absolute project path.
	 */
	planTask(task: string, projectPath: string): Promise<SidecarResponse<PlanData>> {
		return this.post<PlanData>('/agent/plan', { task, projectPath });
	}

	/**
	 * @param planId - Plan identifier.
	 * @returns Next step execution result.
	 */
	executePlanStep(planId: string): Promise<SidecarResponse<PlanExecuteData>> {
		return this.post<PlanExecuteData>(`/agent/plan/${planId}/execute`);
	}

	/**
	 * @param params - Shard preview query parameters.
	 */
	shardPreview(params: {
		task: string;
		activeFile?: string;
		projectPath: string;
	}): Promise<SidecarResponse<ShardPreviewData>> {
		const qs = new URLSearchParams({
			task: params.task,
			projectPath: params.projectPath,
		});
		if (params.activeFile) {
			qs.set('activeFile', params.activeFile);
		}
		return this.get<ShardPreviewData>(`/shards/preview?${qs.toString()}`);
	}

	/** @returns RunPod pod lifecycle status. */
	runpodStatus(): Promise<SidecarResponse<RunpodStatus>> {
		return this.get<RunpodStatus>('/runpod/status');
	}

	/** Starts the RunPod pod via sidecar lifecycle manager. */
	startPod(): Promise<SidecarResponse<{ podState: string }>> {
		return this.post<{ podState: string }>('/runpod/start');
	}

	/** Stops the RunPod pod via sidecar lifecycle manager. */
	stopPod(): Promise<SidecarResponse<{ podState: string }>> {
		return this.post<{ podState: string }>('/runpod/stop');
	}

	/**
	 * @param res - Fetch response to parse.
	 * @returns Typed sidecar envelope.
	 */
	private async parseResponse<T>(res: Response): Promise<SidecarResponse<T>> {
		const text = await res.text();
		if (!text) {
			if (!res.ok) {
				throw new Error(`Sidecar error: ${res.status}`);
			}
			return { success: true };
		}

		let parsed: SidecarResponse<T>;
		try {
			parsed = JSON.parse(text) as SidecarResponse<T>;
		} catch {
			throw new Error(`Invalid sidecar response: ${text.slice(0, 200)}`);
		}

		if (!res.ok && !parsed.error) {
			parsed.error = `HTTP ${res.status}`;
			parsed.success = false;
		}

		return parsed;
	}
}
