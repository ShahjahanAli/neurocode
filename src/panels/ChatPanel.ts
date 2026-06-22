import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';
import type { AttentionHeatmap } from '../editor/AttentionHeatmap';
import { getWebviewHtml } from './webviewUtils';
import { applyEdit, parseCodeBlocks, resolveFileUri, showDiff } from '../utils/DiffApplier';
import type { AgentChatData, ChatIntent, ChatTurn } from '../sidecar/types';

/** Last agent response shared with shard visualizer. */
export let lastAgentResponse: AgentChatData | null = null;

/**
 * NeuroCode Chat sidebar WebView provider.
 */
export class ChatPanelProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private podPollTimer?: ReturnType<typeof setInterval>;
	private conversationHistory: ChatTurn[] = [];

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
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist')],
		};

		webviewView.webview.html = this.getHtml(webviewView.webview);
		this.startPodPolling();

		webviewView.webview.onDidReceiveMessage(async (msg: { type: string; [key: string]: unknown }) => {
			await this.handleMessage(msg);
		});

		webviewView.onDidDispose(() => {
			if (this.podPollTimer) {
				clearInterval(this.podPollTimer);
			}
		});
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
			case 'askAgent': {
				this.heatmap.clear();
				const editor = vscode.window.activeTextEditor;
				const task = msg.task ?? '';
				this.conversationHistory.push({ role: 'user', content: task });

				this.post({ type: 'streamStart' });

				try {
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

					this.conversationHistory.push({ role: 'assistant', content: data.response });
					if (this.conversationHistory.length > 16) {
						this.conversationHistory = this.conversationHistory.slice(-16);
					}

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
					this.conversationHistory.pop();
					this.post({
						type: 'error',
						message: err instanceof Error ? err.message : String(err),
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
					this.post({
						type: 'agentResponse',
						data: {
							response: 'All plan steps are complete.',
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

				this.post({
					type: 'agentResponse',
					data: {
						response: `Implemented **${res.data.stepId}**:\n\n${stepResponse}`,
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
				this.conversationHistory = [];
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
