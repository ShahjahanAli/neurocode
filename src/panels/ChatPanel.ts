import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';
import type { AttentionHeatmap } from '../editor/AttentionHeatmap';
import { getWebviewHtml } from './webviewUtils';
import { applyEdit, applyAllCodeBlocks, parseCodeBlocks, resolveFileUri, showDiff, stripNeuroCodeAppendix, type ParseCodeBlocksOptions } from '../utils/DiffApplier';
import type { AgentChatData, ChatIntent, ChatTurn } from '../sidecar/types';
import { AutoIndexer } from '../services/AutoIndexer';
import { getConfig } from '../utils/config';

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
	filesApplied?: Array<{ file: string; action: 'created' | 'updated' }>;
	truncated?: boolean;
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
		this.triggerBackgroundIndex();

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
		const source = stripNeuroCodeAppendix(response);
		const fences = (source.match(/```/g) ?? []).length;
		return fences % 2 !== 0;
	}

	/** @returns Options for parsing code blocks from the active editor context. */
	private getApplyOptions(): ParseCodeBlocksOptions {
		const editor = vscode.window.activeTextEditor;
		const folder = vscode.workspace.workspaceFolders?.[0];
		const fallbackFilename =
			editor && folder
				? vscode.workspace.asRelativePath(editor.document.uri, false)
				: undefined;

		return {
			allowIncomplete: true,
			fallbackFilename,
		};
	}

	/**
	 * Runs a chat agent request with streaming.
	 * @param task - User task text.
	 * @param forceIntent - Optional intent override.
	 */
	private async runAgentTask(task: string, forceIntent?: ChatIntent): Promise<void> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			this.post({ type: 'error', message: 'Open a workspace folder first.' });
			return;
		}

		this.heatmap.clear();
		const editor = vscode.window.activeTextEditor;
		this.appendStoredMessage({ role: 'user', text: task });
		this.post({ type: 'appendMessage', message: { role: 'user', text: task } });
		this.post({ type: 'streamStart' });

		try {
			await this.ensureIndexed(folder.uri.fsPath);

			const data = await this.sidecar.client.chatStream(
				{
					task,
					activeFile: editor?.document.uri.fsPath,
					cursorLine: editor?.selection.active.line,
					projectPath: folder.uri.fsPath,
					history: this.conversationHistory.slice(0, -1),
					forceIntent,
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

			const finalData = await this.maybeAutoApplyEdits(data, folder.uri.fsPath);

			this.appendStoredMessage({
				role: 'assistant',
				text: finalData.response,
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

			this.post({
				type: 'agentResponse',
				data: finalData,
			});

			void this.sidecar.client.post('/memory/record', {
				taskDescription: task,
				filesEdited: finalData.filesApplied?.map((f) => f.file) ?? finalData.shardsUsed.map((s) => s.file),
				diffAccepted: (finalData.filesApplied?.length ?? 0) > 0,
				latencyMs: finalData.latencyMs,
				modelUsed: finalData.modelUsed,
				provider: finalData.provider,
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

		const applyOptions = this.getApplyOptions();
		const blocks = parseCodeBlocks(data.response, applyOptions).filter((b) => b.filename);
		if (blocks.length === 0) {
			return {
				...data,
				truncated: this.isTruncatedResponse(data.response),
				response: `${data.response}\n\n---\n**Note:** No files were written — code blocks need a path. Use \`// filename: src/path/to/file.ts\` as the first line inside each block, or click **Accept** while the target file is open.`,
			};
		}

		const result = await applyAllCodeBlocks(data.response, projectPath, applyOptions);
		const truncated = this.isTruncatedResponse(data.response);
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

		if (truncated && result.applied.length > 0) {
			response += '\n\n⚠️ **Response was cut off.** Click **Continue** (or say `continue`) to generate the rest.';
		} else if (truncated) {
			response += '\n\n⚠️ **Response was cut off.** Click **Accept** to apply partial code, then **Continue** for the rest.';
		}

		if (result.failed.length > 0) {
			response += `\n\n**Failed to write:** ${result.failed.join(', ')}`;
		}

		return {
			...data,
			response,
			filesApplied: result.applied,
			truncated,
		};
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
		truncated?: boolean;
		appliedFiles?: string[];
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
				await this.runAgentTask(msg.task ?? '', msg.forceIntent);
				break;
			}
			case 'continueGeneration': {
				const applied = msg.appliedFiles ?? [];
				const continueTask = applied.length > 0
					? `Continue the previous implementation. These files were already written: ${applied.join(', ')}. Output ONLY the remaining files or the COMPLETE remainder of any truncated file. Each block MUST start with // filename: relative/path`
					: 'Continue the previous implementation. Output the remaining complete files. Each block MUST start with // filename: relative/path';
				await this.runAgentTask(continueTask, 'edit');
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
				const rawText = stripNeuroCodeAppendix(msg.text ?? '');
				const blocks = parseCodeBlocks(rawText, this.getApplyOptions());
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
				const rawText = stripNeuroCodeAppendix(msg.text ?? '');
				const applyOptions = this.getApplyOptions();
				const parsed = parseCodeBlocks(rawText, applyOptions);
				const result = await applyAllCodeBlocks(rawText, folder.uri.fsPath, applyOptions);

				if (result.applied.length === 0) {
					void vscode.window.showWarningMessage(
						`NeuroCode: Applied 0 file(s). Found ${parsed.length} code block(s) — add // filename: src/path/file.ts as the first line inside each block.`,
					);
					break;
				}

				void vscode.window.showInformationMessage(
					`NeuroCode: Applied ${result.applied.length} file(s)`,
				);

				const truncated = msg.truncated ?? this.isTruncatedResponse(rawText);
				if (truncated) {
					const choice = await vscode.window.showInformationMessage(
						'Code was partially generated. Continue to finish the remaining files?',
						'Continue',
						'Not now',
					);
					if (choice === 'Continue') {
						await this.runAgentTask(
							`Continue the previous implementation. These files were already written: ${result.applied.map((f) => f.file).join(', ')}. Output ONLY the remaining files or the COMPLETE remainder of any truncated file. Each block MUST start with // filename: relative/path`,
							'edit',
						);
					}
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
