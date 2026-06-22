import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';
import type { AttentionHeatmap } from '../editor/AttentionHeatmap';
import { getWebviewHtml } from './webviewUtils';
import { applyEdit, parseCodeBlocks, resolveFileUri, showDiff } from '../utils/DiffApplier';
import type { AgentChatData, ChatIntent, ChatTurn } from '../sidecar/types';

/** Last agent response shared with shard visualizer. */
export let lastAgentResponse: AgentChatData | null = null;

/** Persisted chat message for UI restore. */
interface StoredChatMessage {
	role: 'user' | 'assistant';
	text: string;
	provider?: string;
	modelUsed?: string;
	intent?: ChatIntent;
	shards?: Array<{ file: string; reason: string; tokenCount: number }>;
	planId?: string;
	steps?: Array<{ id: string; description: string; status: string }>;
}

/**
 * NeuroCode Chat sidebar WebView provider.
 */
export class ChatPanelProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private podPollTimer?: ReturnType<typeof setInterval>;
	private conversationHistory: ChatTurn[] = [];
	private uiMessages: StoredChatMessage[] = [];

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
	) {}

	/**
	 * @param webviewView - VS Code webview view.
	 */
	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		this.loadPersistedChat();
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist')],
		};

		webviewView.webview.html = this.getHtml(webviewView.webview);
		this.startPodPolling();
		this.postRestoreChat();

		webviewView.webview.onDidReceiveMessage(async (msg: { type: string; [key: string]: unknown }) => {
			await this.handleMessage(msg);
		});

		webviewView.onDidDispose(() => {
			if (this.podPollTimer) {
				clearInterval(this.podPollTimer);
			}
		});
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
		this.post({ type: 'restoreChat', messages: this.uiMessages });
	}

	/** Opens or focuses the chat view. */
	static async reveal(): Promise<void> {
		await vscode.commands.executeCommand('neurocode.chatView.focus');
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
		return getWebviewHtml(webview, this.extensionUri, 'chat', scriptUri, styleUri);
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

	private async ensureIndexed(projectPath: string): Promise<void> {
		const health = await this.sidecar.client.health();
		if (health.data?.indexed && (health.data.fileCount ?? 0) > 0) {
			return;
		}

		this.post({ type: 'indexing', message: 'Indexing project so NeuroCode can read your code…' });

		const start = await this.sidecar.client.startIndex(projectPath);
		if (!start.success || !start.data?.jobId) {
			return;
		}

		const jobId = start.data.jobId;
		for (let i = 0; i < 120; i++) {
			await new Promise((r) => setTimeout(r, 1000));
			const status = await this.sidecar.client.indexStatus(jobId);
			if (status.data?.status === 'done') {
				this.post({ type: 'indexingDone', fileCount: status.data.filesProcessed });
				return;
			}
			if (status.data?.status === 'failed') {
				break;
			}
		}
	}

	/**
	 * @param msg - Message from webview.
	 */
	private async handleMessage(msg: {
		type: string;
		task?: string;
		text?: string;
		planId?: string;
		forceIntent?: ChatIntent;
	}): Promise<void> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder && msg.type === 'askAgent') {
			this.post({ type: 'error', message: 'Open a workspace folder first.' });
			return;
		}

		switch (msg.type) {
			case 'webviewReady':
				this.postRestoreChat();
				break;
			case 'askAgent': {
				this.heatmap.clear();
				const editor = vscode.window.activeTextEditor;
				const task = msg.task ?? '';
				this.appendStoredMessage({ role: 'user', text: task });
				this.post({ type: 'appendMessage', message: { role: 'user', text: task } });

				this.post({ type: 'streamStart' });

				try {
					await this.ensureIndexed(folder!.uri.fsPath);

					const data = await this.sidecar.client.chatStream(
						{
							task,
							activeFile: editor?.document.uri.fsPath,
							cursorLine: editor?.selection.active.line,
							projectPath: folder!.uri.fsPath,
							history: this.conversationHistory.slice(0, -1),
							forceIntent: msg.forceIntent,
						},
						(chunk) => {
							if (chunk.type === 'intent') {
								this.post({ type: 'streamIntent', intent: chunk.intent });
							}
							if (chunk.type === 'token' && chunk.content) {
								this.post({ type: 'streamToken', content: chunk.content });
							}
						},
					);

					this.appendStoredMessage({
						role: 'assistant',
						text: data.response,
						provider: data.provider,
						modelUsed: data.modelUsed,
						intent: data.intent,
						shards: data.shardsUsed,
						planId: data.planId,
						steps: data.steps,
					});

					lastAgentResponse = data;
					this.heatmap.apply(data.attentionMap, editor?.document.uri.fsPath);

					this.post({
						type: 'agentResponse',
						data,
					});

					void this.sidecar.client.post('/memory/record', {
						taskDescription: task,
						filesEdited: data.shardsUsed.map((s) => s.file),
						diffAccepted: false,
						latencyMs: data.latencyMs,
						modelUsed: data.modelUsed,
						provider: data.provider,
					});
				} catch (err) {
					const errText = err instanceof Error ? err.message : String(err);
					this.uiMessages.pop();
					this.persistChat();
					this.syncConversationHistory();
					this.appendStoredMessage({
						role: 'assistant',
						text: `**Error:** ${errText}`,
						intent: 'chat',
					});
					this.post({
						type: 'agentResponse',
						data: {
							response: `**Error:** ${errText}`,
							intent: 'chat',
							shardsUsed: [],
							tokensUsed: 0,
							budget: 0,
							modelUsed: '',
							provider: 'unknown',
							latencyMs: 0,
						},
					});
				}
				break;
			}
			case 'executePlanStep': {
				if (!msg.planId || !folder) {
					return;
				}
				const editor = vscode.window.activeTextEditor;
				this.post({ type: 'streamStart' });
				this.post({ type: 'streamIntent', intent: 'edit' });

				const res = await this.sidecar.client.post<{
					stepId: string | null;
					status: string;
					diff?: string;
					shardsUsed: Array<{ file: string; reason: string; tokenCount: number }>;
					tokensUsed?: number;
					provider?: string;
				}>(`/agent/plan/${msg.planId}/execute`, {
					projectPath: folder.uri.fsPath,
					activeFile: editor?.document.uri.fsPath,
				});

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
					this.post({
						type: 'agentResponse',
						data: {
							response: completeMsg.text,
							intent: 'chat',
							shardsUsed: [],
							tokensUsed: 0,
							budget: 0,
							modelUsed: '',
							provider: res.data.provider ?? 'unknown',
							latencyMs: 0,
						},
					});
					break;
				}

				const stepResponse = res.data.diff
					? `\`\`\`typescript\n${res.data.diff}\n\`\`\``
					: `Step **${res.data.stepId}** completed.`;
				const stepText = `Implemented **${res.data.stepId}**:\n\n${stepResponse}`;

				this.appendStoredMessage({
					role: 'assistant',
					text: stepText,
					intent: 'edit',
					provider: res.data.provider,
					shards: res.data.shardsUsed,
				});

				this.post({
					type: 'agentResponse',
					data: {
						response: stepText,
						intent: 'edit',
						diff: res.data.diff,
						shardsUsed: res.data.shardsUsed,
						tokensUsed: res.data.tokensUsed ?? 0,
						budget: 0,
						modelUsed: '',
						provider: res.data.provider ?? 'unknown',
						latencyMs: 0,
					},
				});
				break;
			}
			case 'clearChat':
				this.uiMessages = [];
				this.conversationHistory = [];
				void this.context.workspaceState.update(this.chatStorageKey(), []);
				this.post({ type: 'chatCleared' });
				break;
			case 'viewDiff': {
				const blocks = parseCodeBlocks(msg.text ?? '');
				const block = blocks[0];
				if (!block?.filename || !folder) {
					return;
				}
				const uri = resolveFileUri(block.filename, folder.uri.fsPath);
				if (uri) {
					await showDiff(uri, block.code, `NeuroCode: ${block.filename}`);
				}
				break;
			}
			case 'acceptDiff': {
				const blocks = parseCodeBlocks(msg.text ?? '');
				const block = blocks[0];
				if (!block?.filename || !folder) {
					return;
				}
				const uri = resolveFileUri(block.filename, folder.uri.fsPath);
				if (uri) {
					await applyEdit(uri, block.code);
					void this.sidecar.client.post('/memory/record', {
						taskDescription: msg.task ?? 'accepted edit',
						filesEdited: [block.filename],
						diffAccepted: true,
						provider: 'unknown',
					});
				}
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
}
