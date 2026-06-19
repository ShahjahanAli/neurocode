import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';
import { ChatPanelProvider } from '../panels/ChatPanel';
import type { ShardVisualizerProvider } from '../panels/ShardVisualizerPanel';
import type { AttentionHeatmap } from '../editor/AttentionHeatmap';

/**
 * Registers Ask Agent — opens chat panel and delegates to WebView.
 * @param context - Extension context.
 * @param sidecar - Sidecar manager.
 * @param chat - Chat panel provider.
 * @param shards - Shard visualizer provider.
 * @param heatmap - Attention heatmap.
 */
export function registerAskAgent(
	context: vscode.ExtensionContext,
	sidecar: SidecarManager,
	chat: ChatPanelProvider,
	shards: ShardVisualizerProvider,
	heatmap: AttentionHeatmap,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('neurocode.askAgent', async () => {
			await ChatPanelProvider.reveal();
			// Quick ask via input if no chat message pending
			const task = await vscode.window.showInputBox({
				prompt: 'What should the agent do?',
				placeHolder: 'Add input validation to createUser...',
			});
			if (!task) {
				return;
			}

			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showErrorMessage('NeuroCode: Open a workspace folder first.');
				return;
			}

			heatmap.clear();
			const editor = vscode.window.activeTextEditor;
			const res = await sidecar.client.askAgent({
				task,
				activeFile: editor?.document.uri.fsPath,
				cursorLine: editor?.selection.active.line,
				projectPath: folder.uri.fsPath,
			});

			if (!res.success || !res.data) {
				void vscode.window.showErrorMessage(res.error ?? 'Agent request failed');
				return;
			}

			heatmap.apply(res.data.attentionMap, editor?.document.uri.fsPath);
			chat.post({ type: 'agentResponse', data: res.data });
			shards.post({ type: 'shards', data: {
				shards: res.data.shardsUsed,
				totalTokens: res.data.tokensUsed,
				budget: res.data.budget,
				provider: res.data.provider,
				modelUsed: res.data.modelUsed,
			}});
		}),
	);
}
