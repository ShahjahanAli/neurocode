import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { SidecarManager } from '../sidecar/SidecarManager';
import type { AttentionHeatmap } from '../editor/AttentionHeatmap';
import { getWebviewHtml } from './webviewUtils';
import { applyEdit, applyAllCodeBlocks, parseCodeBlocks, resolveFileUri, showDiff, stripNeuroCodeAppendix, type ParseCodeBlocksOptions } from '../utils/DiffApplier';
import { buildContinuePrompt, isTruncatedResponse as isTruncatedLlmResponse, mergeContinuation } from '../utils/CodeBatchMerger';
import type { AgentChatData, ChatIntent, ChatMode, ChatTurn, HealthData } from '../sidecar/types';
import { AutoIndexer } from '../services/AutoIndexer';
import { getConfig, getChatViewId } from '../utils/config';

/** Last agent response shared with shard visualizer. */
export let lastAgentResponse: AgentChatData | null = null;

/** Persisted chat message for UI restore. */
interface StoredChatMessage {
	role: 'user' | 'assistant';
	text: string;
	messageId?: string;
	taskText?: string;
	tokensUsed?: number;
	latencyMs?: number;
	provider?: string;
	modelUsed?: string;
	intent?: ChatIntent;
	shards?: Array<{ file: string; reason: string; tokenCount: number }>;
	planId?: string;
	steps?: Array<{ id: string; description: string; status: string }>;
	filesApplied?: Array<{ file: string; action: 'created' | 'updated' }>;
	truncated?: boolean;
	feedbackRating?: 'positive' | 'negative';
	/** Raw LLM output before NeuroCode status footers (used for Apply). */
	sourceText?: string;
}

/**
 * NeuroCode Chat sidebar WebView provider.
 */
export class ChatPanelProvider implements vscode.WebviewViewProvider {
	static instance?: ChatPanelProvider;
	static rightPanel?: ChatPanelProvider;

	private view?: vscode.WebviewView;
	private viewType = 'neurocode.chatViewLeft';
	private podPollTimer?: ReturnType<typeof setInterval>;
	private conversationHistory: ChatTurn[] = [];
	private uiMessages: StoredChatMessage[] = [];
	private lastIndexing: { filesProcessed: number; totalFiles: number } | null = null;
	private getSidecarReady: () => boolean = () => false;

	/**
	 * @param extensionUri - Extension root URI.
	 * @param sidecar - Sidecar manager.
	 * @param heatmap - Attention heatmap instance.
	 * @param context - Extension context for globalState.
	 */
	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly sidecar: SidecarManager,
		private readonly heatmap: AttentionHeatmap,
		private readonly context: vscode.ExtensionContext,
		getSidecarReady?: () => boolean,
	) {
		if (getSidecarReady) {
			this.getSidecarReady = getSidecarReady;
		}
	}

	/** @returns Whether this provider hosts the tabbed right sidebar. */
	isRightPanel(): boolean {
		return this.viewType === 'neurocode.rightPanel';
	}

	/**
	 * Switches the active tab in the right sidebar webview.
	 * @param tab - Tab id to show.
	 */
	switchTab(tab: string): void {
		this.post({ type: 'switchTab', tab });
	}

	/**
	 * Updates indexing progress for the Overview tab.
	 * @param progress - Index job progress or null when idle.
	 */
	setIndexingProgress(progress: { filesProcessed: number; totalFiles: number } | null): void {
		if (!this.isRightPanel()) {
			return;
		}
		this.lastIndexing = progress;
		void this.pushHubStatus();
	}

	/**
	 * Pushes hub status to the Overview tab on the right panel.
	 * @param health - Optional pre-fetched health payload.
	 */
	async pushHubStatus(health?: HealthData): Promise<void> {
		if (!this.isRightPanel() || !this.view) {
			return;
		}

		let healthData = health;
		if (!healthData && this.sidecar.isRunning()) {
			try {
				const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				const res = await this.sidecar.client.health(projectPath);
				if (res.success && res.data) {
					healthData = res.data;
				}
			} catch {
				// Hub shows unreachable state
			}
		}

		const cfg = getConfig();
		const workspace = vscode.workspace.workspaceFolders?.[0]?.name ?? null;

		this.post({
			type: 'hubStatus',
			sidecarReady: this.getSidecarReady(),
			workspace,
			health: healthData ?? null,
			indexing: this.lastIndexing,
			config: {
				chatLocation: cfg.ui.chatLocation,
				chatMode: cfg.chat.mode,
				autoApply: cfg.chat.autoApply,
				autoContinue: cfg.chat.autoContinue,
				fixOnCheck: cfg.chat.fixOnCheck,
				autoIndex: cfg.indexing.autoIndex,
				provider: cfg.llm.provider,
				tokenBudget: cfg.shard.maxTokens,
				airgap: cfg.airgap.enabled,
				heatmap: cfg.heatmap.enabled,
				memory: cfg.memory.enabled,
				drift: cfg.drift.enabled,
				genome: cfg.genome.enabled,
				crossrepo: cfg.crossrepo.enabled,
				runpodConfigured: Boolean(cfg.runpod.podId),
			},
		});
	}

	/**
	 * @param webviewView - VS Code webview view.
	 */
	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		this.viewType = webviewView.viewType;
		ChatPanelProvider.instance = this;
		if (webviewView.viewType === 'neurocode.rightPanel') {
			ChatPanelProvider.rightPanel = this;
		}
		this.loadPersistedChat();
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist')],
		};

		webviewView.webview.html = this.getHtml(webviewView.webview);
		this.startPodPolling();
		this.postRestoreChat();
		this.triggerBackgroundIndex();

		webviewView.webview.onDidReceiveMessage(async (msg: { type: string; [key: string]: unknown }) => {
			await this.handleMessage(msg);
		});

		webviewView.onDidDispose(() => {
			if (this.podPollTimer) {
				clearInterval(this.podPollTimer);
			}
		});

		if (this.isRightPanel()) {
			void this.pushHubStatus();
		}
	}

	/** @returns Workspace-scoped key for chat persistence. */
	private chatStorageKey(): string {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'no-workspace';
		return `neurocode.chat.${root}`;
	}

	/** Loads chat history from workspace state. */
	private loadPersistedChat(): void {
		this.uiMessages = this.context.workspaceState.get<StoredChatMessage[]>(this.chatStorageKey(), []) ?? [];
		this.syncConversationHistory();
	}

	/** Persists chat history to workspace state. */
	private persistChat(): void {
		void this.context.workspaceState.update(this.chatStorageKey(), this.uiMessages);
	}

	/** Syncs LLM API history from stored UI messages. */
	private syncConversationHistory(): void {
		this.conversationHistory = this.uiMessages
			.filter((m) => m.role === 'user' || m.role === 'assistant')
			.map((m) => ({ role: m.role, content: m.text }));
	}

	/**
	 * @param message - Message to append and persist.
	 */
	private appendStoredMessage(message: StoredChatMessage): void {
		this.uiMessages.push(message);
		if (this.uiMessages.length > 40) {
			this.uiMessages = this.uiMessages.slice(-40);
		}
		this.persistChat();
		this.syncConversationHistory();
	}

	/** Sends stored messages to the webview. */
	private postRestoreChat(): void {
		this.post({
			type: 'restoreChat',
			messages: this.uiMessages.map((m) => ({
				role: m.role,
				text: m.text,
				sourceText: m.sourceText,
				messageId: m.messageId,
				taskText: m.taskText,
				tokensUsed: m.tokensUsed,
				latencyMs: m.latencyMs,
				provider: m.provider,
				modelUsed: m.modelUsed,
				intent: m.intent,
				shards: m.shards,
				planId: m.planId,
				steps: m.steps,
				filesApplied: m.filesApplied,
				truncated: m.truncated,
				feedbackRating: m.feedbackRating,
			})),
		});
	}

	/** Opens or focuses the chat view (right secondary sidebar by default, Cursor-style). */
	static async reveal(): Promise<void> {
		if (getConfig().ui.chatLocation === 'right') {
			try {
				await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
			} catch {
				try {
					await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
				} catch {
					// VS Code builds without auxiliary bar — view still focuses if visible
				}
			}
		}

		await vscode.commands.executeCommand(`${getChatViewId()}.focus`);
		if (getConfig().ui.chatLocation === 'right') {
			ChatPanelProvider.rightPanel?.switchTab('chat');
		}
	}

	/**
	 * @param webview - Webview instance.
	 * @returns HTML content.
	 */
	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'assets', 'index.js'),
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'assets', 'index.css'),
		);
		return getWebviewHtml(
			webview,
			this.extensionUri,
			this.viewType === 'neurocode.rightPanel' ? 'right' : 'chat',
			scriptUri,
			styleUri,
		);
	}

	private startPodPolling(): void {
		if (this.podPollTimer) {
			clearInterval(this.podPollTimer);
		}
		void this.postPodStatus();
		this.podPollTimer = setInterval(() => {
			void this.postPodStatus();
		}, 10_000);
	}

	private async postPodStatus(): Promise<void> {
		const res = await this.sidecar.client.runpodStatus();
		const cost = await this.sidecar.client.get<{ sessionMinutes?: number; estimatedCostUsd?: number; llmCalls?: number }>('/runpod/cost');
		this.post({
			type: 'podStatus',
			data: {
				...(res.data ?? { podState: 'not-configured' }),
				cost: cost.data,
			},
		});
	}

	private triggerBackgroundIndex(): void {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return;
		}

		void AutoIndexer.ensureIndexed(this.sidecar, folder.uri.fsPath, { silent: true });
	}

	private async ensureIndexed(projectPath: string): Promise<void> {
		const count = await AutoIndexer.getProjectFileCount(this.sidecar, projectPath);
		if (count > 0) {
			return;
		}

		this.post({ type: 'indexing', message: 'Indexing project so NeuroCode can read your code…' });

		try {
			const indexed = await AutoIndexer.ensureIndexed(this.sidecar, projectPath, {
				silent: true,
				onProgress: (p) => {
					this.post({
						type: 'indexing',
						message: `Indexing ${p.filesProcessed}/${p.totalFiles} files…`,
					});
				},
			});
			this.post({ type: 'indexingDone', fileCount: indexed });
		} catch {
			this.post({ type: 'indexingDone', fileCount: 0 });
		}
	}

	/** @param response - LLM response text. */
	private isTruncatedResponse(response: string): boolean {
		return isTruncatedLlmResponse(response);
	}

	/** @returns Options for parsing code blocks from the active editor context. */
	private getApplyOptions(shards?: Array<{ file: string }>): ParseCodeBlocksOptions {
		const editor = vscode.window.activeTextEditor;
		const folder = vscode.workspace.workspaceFolders?.[0];
		const fallbackFilename =
			editor && folder
				? vscode.workspace.asRelativePath(editor.document.uri, false)
				: undefined;

		return {
			allowIncomplete: true,
			fallbackFilename,
			workspaceRoot: folder?.uri.fsPath,
			hintFilenames: shards?.map((s) => s.file) ?? [],
		};
	}

	/**
	 * Runs implement generation with optional auto-continuation (Cursor-style batch).
	 * @param originalTask - User's implement request.
	 * @param folder - Workspace folder.
	 * @param editor - Active editor, if any.
	 * @param forceIntent - Optional intent override for round 1.
	 * @param options - Batch options for manual continue.
	 * @returns Merged agent response after all continuation rounds.
	 */
	private async runImplementBatch(
		originalTask: string,
		folder: vscode.WorkspaceFolder,
		editor: vscode.TextEditor | undefined,
		forceIntent?: ChatIntent,
		options?: {
			seedAccumulated?: string;
			isManualContinue?: boolean;
			chatMode?: ChatMode;
		},
	): Promise<AgentChatData> {
		const cfg = getConfig();
		const chatMode = options?.chatMode ?? cfg.chat.mode;
		const maxRounds = cfg.chat.autoContinue ? cfg.chat.maxContinueRounds : 1;
		let accumulated = options?.seedAccumulated ?? '';
		let batchResult: AgentChatData | null = null;
		const startRound = accumulated ? 1 : 0;

		for (let round = startRound; round < maxRounds; round++) {
			if (round > startRound || (round === 1 && accumulated)) {
				this.post({
					type: 'batchProgress',
					round: round + 1,
					message: `Generating part ${round + 1}…`,
				});
			}

			const isContinueRound = round > 0 || Boolean(accumulated);
			const roundTask = isContinueRound ? buildContinuePrompt(accumulated) : originalTask;

			const history: ChatTurn[] = isContinueRound
				? (options?.isManualContinue
					? this.conversationHistory.slice(0, -1)
					: [
						...this.conversationHistory.slice(0, -1),
						{ role: 'user', content: originalTask },
						{ role: 'assistant', content: accumulated },
					])
				: this.conversationHistory.slice(0, -1);

			let roundText = '';
			const data = await this.sidecar.client.chatStream(
				{
					task: roundTask,
					activeFile: editor?.document.uri.fsPath,
					cursorLine: editor?.selection.active.line,
					projectPath: folder.uri.fsPath,
					history,
					forceIntent: isContinueRound ? 'edit' : forceIntent,
					chatMode: isContinueRound ? 'implement' : chatMode,
					fixOnCheck: cfg.chat.fixOnCheck,
				},
				(chunk) => {
					if (chunk.type === 'intent' && !isContinueRound) {
						this.post({
							type: 'streamIntent',
							intent: chunk.intent,
							agentic: chunk.agentic,
						});
					}
					if (chunk.type === 'token' && chunk.content) {
						roundText += chunk.content;
						if (!isContinueRound) {
							this.post({ type: 'streamToken', content: chunk.content });
						} else {
							const display = mergeContinuation(accumulated, roundText);
							this.post({ type: 'streamSetText', text: display });
						}
					}
				},
			);

			accumulated = isContinueRound
				? mergeContinuation(accumulated, data.response)
				: data.response;

			if (isContinueRound) {
				this.post({ type: 'streamSetText', text: accumulated });
			}

			batchResult = this.mergeBatchRound(batchResult, data, accumulated);

			const shouldContinue =
				cfg.chat.autoContinue &&
				batchResult.intent === 'edit' &&
				this.isTruncatedResponse(accumulated);

			if (!shouldContinue) {
				break;
			}
		}

		this.post({ type: 'batchProgress', round: 0 });
		if (!batchResult) {
			throw new Error('No response from agent');
		}
		return batchResult;
	}

	/**
	 * Merges a single LLM round into the running batch result.
	 * @param previous - Prior batch state, if any.
	 * @param round - Latest round response from the sidecar.
	 * @param accumulated - Combined text across all rounds so far.
	 * @returns Updated batch state.
	 */
	private mergeBatchRound(
		previous: AgentChatData | null,
		round: AgentChatData,
		accumulated: string,
	): AgentChatData {
		return {
			...round,
			response: accumulated,
			intent: round.intent ?? previous?.intent ?? 'edit',
			shardsUsed: round.shardsUsed?.length ? round.shardsUsed : previous?.shardsUsed ?? [],
			tokensUsed: (previous?.tokensUsed ?? 0) + (round.tokensUsed ?? 0),
			latencyMs: (previous?.latencyMs ?? 0) + (round.latencyMs ?? 0),
		};
	}

	/** @param text - User message. */
	private isSocialAcknowledgment(text: string): boolean {
		return /^(thanks?|thank you|thx|ty|cheers|appreciated|much appreciated|got it|cool|nice|perfect|great|awesome)\b[!. ]*$/i.test(
			text.trim(),
		);
	}

	/**
	 * Runs a chat agent request with streaming.
	 * @param task - User task text.
	 * @param forceIntent - Optional intent override.
	 * @param options - Batch options for manual continue.
	 */
	private async runAgentTask(
		task: string,
		forceIntent?: ChatIntent,
		options?: {
			seedAccumulated?: string;
			isManualContinue?: boolean;
			chatMode?: ChatMode;
		},
	): Promise<void> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			this.post({ type: 'error', message: 'Open a workspace folder first.' });
			return;
		}

		this.heatmap.clear();
		const editor = vscode.window.activeTextEditor;

		if (!options?.isManualContinue) {
			this.appendStoredMessage({ role: 'user', text: task });
			this.post({ type: 'appendMessage', message: { role: 'user', text: task } });
		}

		this.post({ type: 'streamStart' });

		try {
			await this.ensureIndexed(folder.uri.fsPath);

			const effectiveOptions = this.isSocialAcknowledgment(task)
				? { ...options, chatMode: 'explain' as ChatMode }
				: options;

			const cfg = getConfig();
			const activeMode = effectiveOptions?.chatMode ?? cfg.chat.mode;

			let rawData: AgentChatData;
			if (activeMode === 'agent' && !options?.isManualContinue) {
				rawData = await this.runToolAgentLoop(task, folder, editor);
			} else {
				rawData = await this.runImplementBatch(
					task,
					folder,
					editor,
					forceIntent,
					effectiveOptions,
				);
			}

			let finalData = await this.maybeApplyOrphanCode(
				await this.maybeAutoApplyEdits(rawData, folder.uri.fsPath),
				folder.uri.fsPath,
			);

			if (this.isSocialAcknowledgment(task)) {
				finalData = { ...finalData, intent: 'chat', filesApplied: undefined };
			}

			const shouldRunPlanAgent =
				activeMode !== 'agent' &&
				finalData.planId &&
				finalData.agentic;

			if (shouldRunPlanAgent && finalData.planId) {
				finalData = await this.runAgenticPlanLoop(
					finalData,
					folder,
					editor,
				);
			}

			const messageId = randomUUID();
			this.appendStoredMessage({
				role: 'assistant',
				text: finalData.response,
				sourceText: rawData.response,
				messageId,
				taskText: task,
				tokensUsed: finalData.tokensUsed,
				latencyMs: finalData.latencyMs,
				provider: finalData.provider,
				modelUsed: finalData.modelUsed,
				intent: finalData.intent,
				shards: finalData.shardsUsed,
				planId: finalData.planId,
				steps: finalData.steps,
				filesApplied: finalData.filesApplied,
				truncated: finalData.truncated,
			});

			lastAgentResponse = finalData;
			this.heatmap.apply(finalData.attentionMap, editor?.document.uri.fsPath);
			this.broadcastShards(finalData);

			this.postAgentResponse(finalData, rawData.response, messageId);

			void this.sidecar.client.post('/memory/record', {
				taskDescription: task,
				filesEdited: finalData.filesApplied?.map((f) => f.file) ?? finalData.shardsUsed.map((s) => s.file),
				diffAccepted: (finalData.filesApplied?.length ?? 0) > 0,
				latencyMs: finalData.latencyMs,
				modelUsed: finalData.modelUsed,
				provider: finalData.provider,
			});
		} catch (err) {
			this.post({ type: 'batchProgress', round: 0 });
			const errText = err instanceof Error ? err.message : String(err);
			if (!options?.isManualContinue) {
				this.uiMessages.pop();
				this.persistChat();
				this.syncConversationHistory();
			}
			this.appendStoredMessage({
				role: 'assistant',
				text: `**Error:** ${errText}`,
				intent: 'chat',
			});
			this.postAgentResponse({
					response: `**Error:** ${errText}`,
					intent: 'chat',
					shardsUsed: [],
					tokensUsed: 0,
					budget: 0,
					modelUsed: '',
					provider: 'unknown',
					latencyMs: 0,
				});
		}
	}

	/**
	 * Runs the Cursor-style agent tool loop (read → search → write → reply).
	 * @param task - User task.
	 * @param folder - Workspace folder.
	 * @param editor - Active editor, if any.
	 */
	private async runToolAgentLoop(
		task: string,
		folder: vscode.WorkspaceFolder,
		editor: vscode.TextEditor | undefined,
	): Promise<AgentChatData> {
		const cfg = getConfig();

		const data = await this.sidecar.client.agentLoopStream(
			{
				task,
				activeFile: editor?.document.uri.fsPath,
				cursorLine: editor?.selection.active.line,
				projectPath: folder.uri.fsPath,
				history: this.conversationHistory.slice(0, -1),
				maxSteps: cfg.chat.agentToolMaxSteps,
			},
			(chunk) => {
				if (chunk.type === 'intent') {
					this.post({
						type: 'streamIntent',
						intent: chunk.intent,
						agentic: true,
					});
				}
				if (chunk.type === 'step') {
					this.post({
						type: 'batchProgress',
						round: chunk.step ?? 1,
						message: `Agent step ${chunk.step}/${chunk.maxSteps}…`,
					});
				}
				if (chunk.type === 'tool_start' && chunk.tool) {
					this.post({
						type: 'batchProgress',
						round: 1,
						message: `Tool: ${chunk.tool}…`,
					});
				}
				if (chunk.type === 'token' && chunk.content) {
					this.post({ type: 'streamToken', content: chunk.content });
				}
			},
		);

		this.post({ type: 'batchProgress', round: 0 });

		if (!cfg.chat.autoApply || !data.pendingWrites?.length) {
			return data;
		}

		const applied = await this.applyPendingWrites(data.pendingWrites, folder.uri.fsPath);
		if (applied.length === 0) {
			return data;
		}

		void vscode.window.showInformationMessage(
			`NeuroCode Agent: Applied ${applied.length} file(s)`,
		);

		const summary = applied
			.map((f) => `- \`${f.file}\` (${f.action})`)
			.join('\n');

		return {
			...data,
			intent: 'edit',
			agentic: true,
			filesApplied: applied,
			response: `${data.response}\n\n---\n**Applied to your project:**\n${summary}`,
		};
	}

	/**
	 * Writes staged agent tool outputs to the workspace.
	 * @param writes - Pending write_file tool results.
	 * @param projectPath - Workspace root.
	 */
	private async applyPendingWrites(
		writes: Array<{ path: string; content: string }>,
		projectPath: string,
	): Promise<Array<{ file: string; action: 'created' | 'updated' }>> {
		const applied: Array<{ file: string; action: 'created' | 'updated' }> = [];

		for (const write of writes) {
			const uri = resolveFileUri(write.path, projectPath);
			if (!uri) {
				continue;
			}

			let existed = false;
			try {
				await vscode.workspace.fs.stat(uri);
				existed = true;
			} catch {
				existed = false;
			}

			await vscode.workspace.fs.writeFile(uri, Buffer.from(write.content, 'utf8'));
			applied.push({
				file: write.path.replace(/\\/g, '/'),
				action: existed ? 'updated' : 'created',
			});
		}

		return applied;
	}

	/**
	 * Auto-executes plan steps in Agent mode (Cursor / Antigravity style).
	 * @param planData - Initial plan response with planId.
	 * @param folder - Workspace folder.
	 * @param editor - Active editor, if any.
	 */
	private async runAgenticPlanLoop(
		planData: AgentChatData,
		folder: vscode.WorkspaceFolder,
		editor: vscode.TextEditor | undefined,
	): Promise<AgentChatData> {
		const cfg = getConfig();
		if (!planData.planId || !cfg.chat.autoApply) {
			return planData;
		}

		let response = planData.response;
		const filesApplied = [...(planData.filesApplied ?? [])];
		let stepNum = 0;

		while (stepNum < cfg.chat.agentMaxSteps) {
			stepNum += 1;
			this.post({
				type: 'batchProgress',
				round: stepNum,
				message: `Agent executing step ${stepNum}…`,
			});

			const res = await this.sidecar.client.executePlanStep(
				planData.planId,
				folder.uri.fsPath,
				editor?.document.uri.fsPath,
			);

			if (!res.success || !res.data) {
				response += `\n\n**Agent stopped:** ${res.error ?? 'step execution failed'}`;
				break;
			}

			if (res.data.status === 'complete' || !res.data.stepId) {
				response += '\n\n---\n**Agent complete** — all plan steps finished.';
				break;
			}

			const stepText = res.data.response ?? res.data.diff ?? '';
			if (!stepText.trim()) {
				continue;
			}

			const applyOptions = {
				...this.getApplyOptions(res.data.shardsUsed),
				allowIncomplete: false,
			};
			const applyResult = await applyAllCodeBlocks(stepText, folder.uri.fsPath, applyOptions);
			filesApplied.push(...applyResult.applied);

			const appliedSummary = applyResult.applied.length
				? applyResult.applied.map((f) => `\`${f.file}\` (${f.action})`).join(', ')
				: '(no files written — review output)';

			response += `\n\n### Step ${stepNum}: ${res.data.stepId}\n**Applied:** ${appliedSummary}`;
			this.post({ type: 'streamSetText', text: response });
		}

		this.post({ type: 'batchProgress', round: 0 });

		if (filesApplied.length > 0) {
			void vscode.window.showInformationMessage(
				`NeuroCode Agent: Applied ${filesApplied.length} file change(s) across plan steps`,
			);
		}

		return {
			...planData,
			response,
			intent: 'edit',
			agentic: true,
			filesApplied,
			truncated: false,
		};
	}

	/**
	 * Auto-applies code blocks when implement mode is active.
	 * @param data - Agent chat response.
	 * @param projectPath - Workspace root.
	 */
	private async maybeAutoApplyEdits(
		data: AgentChatData,
		projectPath: string,
	): Promise<AgentChatData> {
		if (data.intent !== 'edit' || !getConfig().chat.autoApply) {
			return data;
		}

		const truncated = this.isTruncatedResponse(data.response);
		const applyOptions = {
			...this.getApplyOptions(data.shardsUsed),
			allowIncomplete: false,
		};

		if (truncated) {
			return {
				...data,
				truncated: true,
				filesApplied: [],
				response: `${data.response}\n\n---\n**Generation incomplete** — hit the continuation limit before all code was produced. Say **continue** to resume; no files were written to avoid partial saves.`,
			};
		}

		const blocks = parseCodeBlocks(data.response, applyOptions).filter((b) => b.filename && b.code.trim());
		if (blocks.length === 0) {
			return {
				...data,
				truncated: false,
				response: `${data.response}\n\n---\n**Note:** No files were written — code blocks need a path. Use \`// filename: src/path/to/file.ts\` as the first line inside each block.`,
			};
		}

		const result = await applyAllCodeBlocks(data.response, projectPath, applyOptions);
		let response = data.response;

		if (result.applied.length > 0) {
			const summary = result.applied
				.map((f) => `- \`${f.file}\` (${f.action})`)
				.join('\n');
			response = `${data.response}\n\n---\n**Applied to your project:**\n${summary}`;
			void vscode.window.showInformationMessage(
				`NeuroCode: Applied ${result.applied.length} file(s)`,
			);
			void this.sidecar.client.post('/memory/record', {
				taskDescription: 'auto-applied edit',
				filesEdited: result.applied.map((f) => f.file),
				diffAccepted: true,
				provider: data.provider,
			});
		}

		if (result.failed.length > 0) {
			response += `\n\n**Failed to write:** ${result.failed.join(', ')}`;
		}

		return {
			...data,
			response,
			filesApplied: result.applied,
			truncated: false,
		};
	}

	/**
	 * Applies code embedded in an Explain response when the model ignored review rules.
	 * @param data - Agent chat response.
	 * @param projectPath - Workspace root.
	 */
	private async maybeApplyOrphanCode(
		data: AgentChatData,
		projectPath: string,
	): Promise<AgentChatData> {
		if (data.intent !== 'chat' || !getConfig().chat.fixOnCheck || !getConfig().chat.autoApply) {
			return data;
		}
		if ((data.filesApplied?.length ?? 0) > 0) {
			return data;
		}

		const applyOptions = {
			...this.getApplyOptions(data.shardsUsed),
			allowIncomplete: false,
		};
		const blocks = parseCodeBlocks(data.response, applyOptions).filter(
			(b) => b.filename && b.code.trim().length > 40,
		);
		if (blocks.length === 0) {
			return data;
		}

		const result = await applyAllCodeBlocks(data.response, projectPath, applyOptions);
		if (result.applied.length === 0) {
			return data;
		}

		const summary = result.applied
			.map((f) => `- \`${f.file}\` (${f.action})`)
			.join('\n');

		void vscode.window.showInformationMessage(
			`NeuroCode: Applied ${result.applied.length} file(s) from review response`,
		);

		return {
			...data,
			intent: 'edit',
			filesApplied: result.applied,
			response: `${data.response}\n\n---\n**Applied to your project:**\n${summary}`,
		};
	}

	/**
	 * Posts a completed assistant response with analytics metadata and feedback id.
	 * @param data - Agent response payload.
	 * @param sourceText - Raw model output before footers.
	 * @param messageId - Stable id for feedback (generated if omitted).
	 */
	private postAgentResponse(data: AgentChatData, sourceText?: string, messageId?: string): void {
		const lastUser = [...this.uiMessages].reverse().find((m) => m.role === 'user');
		const id = messageId ?? randomUUID();
		this.post({
			type: 'agentResponse',
			messageId: id,
			taskText: lastUser?.text,
			data,
			sourceText: sourceText ?? data.response,
		});
		this.post({ type: 'analyticsRefresh' });
	}

	/**
	 * Posts shard visualizer data to this webview (right panel Shards tab).
	 * @param data - Agent response containing shard metadata.
	 */
	private broadcastShards(data: AgentChatData): void {
		if (!this.isRightPanel()) {
			return;
		}
		this.post({
			type: 'shards',
			data: {
				shards: data.shardsUsed,
				totalTokens: data.tokensUsed,
				budget: data.budget,
				provider: data.provider,
				modelUsed: data.modelUsed,
			},
		});
	}

	/**
	 * @param msg - Message from webview.
	 */
	private async handleMessage(msg: {
		type: string;
		task?: string;
		text?: string;
		sourceText?: string;
		planId?: string;
		forceIntent?: ChatIntent;
		chatMode?: ChatMode;
		truncated?: boolean;
		appliedFiles?: string[];
		shardFiles?: string[];
	}): Promise<void> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder && msg.type === 'askAgent') {
			this.post({ type: 'error', message: 'Open a workspace folder first.' });
			return;
		}

		switch (msg.type) {
			case 'requestAnalytics': {
				const hours = (msg as { hours?: number }).hours ?? 24;
				const [summaryRes, recentRes] = await Promise.all([
					this.sidecar.client.get(`/analytics/summary?hours=${hours}`),
					this.sidecar.client.get('/analytics/recent?limit=25'),
				]);
				this.post({
					type: 'analyticsData',
					summary: summaryRes.data,
					events: (recentRes.data as { events?: unknown[] } | undefined)?.events ?? [],
				});
				break;
			}
			case 'submitFeedback': {
				if (!getConfig().feedback.enabled) {
					break;
				}
				const body = msg as {
					messageId?: string;
					rating?: string;
					comment?: string;
					taskPreview?: string;
					responsePreview?: string;
					intent?: string;
					provider?: string;
					modelUsed?: string;
					tokensUsed?: number;
					latencyMs?: number;
					diagnostics?: unknown;
				};
				if (!body.rating || !['positive', 'negative'].includes(body.rating)) {
					break;
				}
				await this.sidecar.client.post('/analytics/feedback', body);
				if (body.messageId) {
					const stored = this.uiMessages.find((m) => m.messageId === body.messageId);
					if (stored) {
						stored.feedbackRating = body.rating as 'positive' | 'negative';
						this.persistChat();
					}
					this.post({
						type: 'feedbackSaved',
						messageId: body.messageId,
						rating: body.rating,
					});
				}
				void vscode.window.setStatusBarMessage(
					'NeuroCode: Thanks for your feedback',
					3000,
				);
				break;
			}
			case 'requestStatus':
				await this.pushHubStatus();
				break;
			case 'openPanel': {
				const panel = (msg as { panel?: string }).panel;
				if (!panel) {
					break;
				}
				if (this.isRightPanel()) {
					const tabMap: Record<string, string> = {
						chat: 'chat',
						tasks: 'tasks',
						shards: 'shards',
						review: 'review',
						memory: 'memory',
						debug: 'debug',
						analytics: 'analytics',
					};
					const tab = tabMap[panel];
					if (tab) {
						this.switchTab(tab);
					}
					break;
				}
				await vscode.commands.executeCommand('workbench.view.extension.neurocode-sidebar');
				const viewIds: Record<string, string> = {
					chat: getChatViewId(),
					tasks: 'neurocode.tasksView',
					shards: 'neurocode.shardsView',
					review: 'neurocode.reviewView',
					memory: 'neurocode.memoryView',
					debug: 'neurocode.debugView',
				};
				const viewId = viewIds[panel];
				if (viewId) {
					await vscode.commands.executeCommand(`${viewId}.focus`);
				}
				break;
			}
			case 'runCommand': {
				const command = (msg as { command?: string }).command;
				if (command) {
					await vscode.commands.executeCommand(command);
				}
				break;
			}
			case 'planTask': {
				const task = (msg as { task?: string }).task;
				if (!task || !folder) {
					break;
				}
				const res = await this.sidecar.client.planTask(task, folder.uri.fsPath);
				this.post({ type: 'planCreated', data: res.data });
				break;
			}
			case 'executeStep': {
				const planId = (msg as { planId?: string }).planId;
				if (!planId || !folder) {
					break;
				}
				const editor = vscode.window.activeTextEditor;
				const res = await this.sidecar.client.post(`/agent/plan/${planId}/execute`, {
					projectPath: folder.uri.fsPath,
					activeFile: editor?.document.uri.fsPath,
				});
				this.post({ type: 'stepResult', data: res.data });
				break;
			}
			case 'startReview': {
				const editor = vscode.window.activeTextEditor;
				if (!folder || !editor) {
					break;
				}
				this.post({ type: 'reviewRunning' });
				const res = await this.sidecar.client.post('/review/start', {
					activeFile: editor.document.uri.fsPath,
					cursorLine: editor.selection.active.line,
					projectPath: folder.uri.fsPath,
				});
				this.post({ type: 'reviewResults', data: res.data });
				break;
			}
			case 'refreshMemories':
			case 'refresh':
				await this.loadMemoriesForPanel();
				break;
			case 'delete': {
				const memoryId = (msg as { memoryId?: string }).memoryId;
				if (memoryId) {
					await this.sidecar.client.delete(`/memory/${memoryId}`);
					await this.loadMemoriesForPanel();
				}
				break;
			}
			case 'webviewReady':
				this.postRestoreChat();
				break;
			case 'askAgent': {
				const task = msg.task ?? '';
				const lastAssistant = [...this.uiMessages].reverse().find((m) => m.role === 'assistant');
				const isContinue = /^continue\b/i.test(task.trim());
				const seed = lastAssistant
					? stripNeuroCodeAppendix(lastAssistant.sourceText ?? lastAssistant.text)
					: '';

				if (isContinue && seed && (lastAssistant?.truncated || isTruncatedLlmResponse(seed))) {
					this.appendStoredMessage({ role: 'user', text: task });
					this.post({ type: 'appendMessage', message: { role: 'user', text: task } });
					await this.runAgentTask(task, 'edit', {
						seedAccumulated: seed,
						isManualContinue: true,
					});
				} else {
					await this.runAgentTask(task, msg.forceIntent, { chatMode: msg.chatMode });
				}
				break;
			}
			case 'continueGeneration': {
				const lastAssistant = [...this.uiMessages].reverse().find((m) => m.role === 'assistant');
				const seed = stripNeuroCodeAppendix(lastAssistant?.sourceText ?? lastAssistant?.text ?? '');
				if (!seed) {
					return;
				}
				await this.runAgentTask(buildContinuePrompt(seed), 'edit', {
					seedAccumulated: seed,
					isManualContinue: true,
				});
				break;
			}
			case 'executePlanStep': {
				if (!msg.planId || !folder) {
					return;
				}
				const editor = vscode.window.activeTextEditor;
				this.post({ type: 'streamStart' });
				this.post({ type: 'streamIntent', intent: 'edit' });

				const res = await this.sidecar.client.executePlanStep(
					msg.planId,
					folder.uri.fsPath,
					editor?.document.uri.fsPath,
				);

				if (!res.success || !res.data) {
					this.post({ type: 'error', message: res.error ?? 'Step execution failed' });
					return;
				}

				if (res.data.status === 'complete') {
					const completeMsg: StoredChatMessage = {
						role: 'assistant',
						text: 'All plan steps are complete.',
						intent: 'chat',
						provider: res.data.provider,
					};
					this.appendStoredMessage(completeMsg);
					this.postAgentResponse({
						response: completeMsg.text,
						intent: 'chat',
						shardsUsed: [],
						tokensUsed: 0,
						budget: 0,
						modelUsed: '',
						provider: res.data.provider ?? 'unknown',
						latencyMs: 0,
					});
					break;
				}

				const stepResponse = res.data.response
					?? (res.data.diff
						? `\`\`\`typescript\n${res.data.diff}\n\`\`\``
						: `Step **${res.data.stepId}** completed.`);
				const stepText = `Implemented **${res.data.stepId}**:\n\n${stepResponse}`;

				const stepMessageId = randomUUID();
				this.appendStoredMessage({
					role: 'assistant',
					text: stepText,
					intent: 'edit',
					provider: res.data.provider,
					shards: res.data.shardsUsed,
					messageId: stepMessageId,
					tokensUsed: res.data.tokensUsed ?? 0,
				});

				const stepData: AgentChatData = {
					response: stepText,
					intent: 'edit',
					diff: res.data.diff,
					shardsUsed: res.data.shardsUsed,
					tokensUsed: res.data.tokensUsed ?? 0,
					budget: 0,
					modelUsed: '',
					provider: res.data.provider ?? 'unknown',
					latencyMs: 0,
				};
				lastAgentResponse = stepData;
				this.broadcastShards(stepData);

				this.postAgentResponse(stepData, stepText, stepMessageId);
				break;
			}
			case 'clearChat':
				this.uiMessages = [];
				this.conversationHistory = [];
				void this.context.workspaceState.update(this.chatStorageKey(), []);
				this.post({ type: 'chatCleared' });
				break;
			case 'viewDiff': {
				const rawText = stripNeuroCodeAppendix(msg.text ?? '');
				const shards = msg.shardFiles?.map((file) => ({ file }));
				const blocks = parseCodeBlocks(rawText, this.getApplyOptions(shards));
				const block = blocks[0];
				if (!block?.filename || !folder) {
					void vscode.window.showWarningMessage(
						'NeuroCode: No file path found in code block. Add // filename: path as the first line.',
					);
					return;
				}
				const uri = resolveFileUri(block.filename, folder.uri.fsPath);
				if (uri) {
					await showDiff(uri, block.code, `NeuroCode: ${block.filename}`);
				}
				break;
			}
			case 'acceptDiff': {
				if (!folder) {
					return;
				}
				const rawText = stripNeuroCodeAppendix(msg.sourceText ?? msg.text ?? '');
				const shards = msg.shardFiles?.map((file) => ({ file }));
				const applyOptions = this.getApplyOptions(shards);
				const parsed = parseCodeBlocks(rawText, applyOptions);
				const result = await applyAllCodeBlocks(rawText, folder.uri.fsPath, applyOptions);

				if (result.applied.length === 0) {
					const withPath = parsed.filter((b) => b.filename).length;
					void vscode.window.showWarningMessage(
						`NeuroCode: Applied 0 file(s). Parsed ${parsed.length} block(s), ${withPath} with paths. Open the target file in the editor and try again, or ensure blocks include // filename: src/path/file.ts`,
					);
					break;
				}

				void vscode.window.showInformationMessage(
					`NeuroCode: Applied ${result.applied.length} file(s)`,
				);
				break;
			}
			case 'startPod':
				await this.sidecar.client.startPod();
				break;
			case 'stopPod':
				await this.sidecar.client.stopPod();
				break;
			case 'genomeConsent': {
				await this.sidecar.client.post('/genome/consent', { accepted: true });
				await this.context.globalState.update('neurocode.genomeConsent', true);
				this.post({ type: 'genomeConsent', accepted: true });
				break;
			}
			case 'getGenomeConsent': {
				const genome = await this.sidecar.client.get<{ enabled: boolean }>('/genome/status');
				const accepted = this.context.globalState.get<boolean>('neurocode.genomeConsent', false);
				this.post({ type: 'genomeConsent', accepted: accepted || genome.data?.enabled });
				break;
			}
		}
	}

	/**
	 * @param message - Message to post to webview.
	 */
	post(message: unknown): void {
		this.view?.webview.postMessage(message);
	}

	/** Loads project memories into the Memory tab. */
	private async loadMemoriesForPanel(): Promise<void> {
		if (!vscode.workspace.workspaceFolders?.[0]) {
			return;
		}
		const res = await this.sidecar.client.get('/memory/top?limit=20');
		this.post({ type: 'memories', data: res.data });
	}
}
