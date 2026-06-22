import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';
import type { DebugPanelProvider } from '../panels/DebugPanel';
import { AttentionHeatmap } from '../editor/AttentionHeatmap';

import { ChatPanelProvider } from '../panels/ChatPanel';
import { getConfig } from '../utils/config';

/**
 * Registers causal debug command (Ctrl+Shift+D).
 * @param context - Extension context.
 * @param sidecar - Sidecar manager.
 * @param debugPanel - Debug panel provider.
 * @param _heatmap - Attention heatmap for root cause highlight.
 * @param chat - Chat / right panel provider for tabbed layout.
 */
export function registerDebugCause(
	context: vscode.ExtensionContext,
	sidecar: SidecarManager,
	debugPanel: DebugPanelProvider,
	_heatmap: AttentionHeatmap,
	chat: ChatPanelProvider,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('neurocode.debugCause', async () => {
			const editor = vscode.window.activeTextEditor;
			const stackTrace = editor?.document.getText(editor.selection)
				|| await vscode.window.showInputBox({
					prompt: 'Paste stack trace',
					placeHolder: 'Error: ...\n    at foo (file.ts:10:5)',
				});

			if (!stackTrace) {
				return;
			}

			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showErrorMessage('NeuroCode: Open a workspace folder first.');
				return;
			}

			const res = await sidecar.client.post<{
				rootCauseFile: string;
				rootCauseLine: number;
				explanation: string;
				causalChain: unknown[];
			}>('/debug/cause', {
				stackTrace,
				projectPath: folder.uri.fsPath,
			});

			if (!res.success || !res.data) {
				void vscode.window.showErrorMessage(res.error ?? 'Debug analysis failed');
				return;
			}

			if (res.data.rootCauseFile && res.data.rootCauseLine) {
				AttentionHeatmap.highlightRootCause(res.data.rootCauseFile, res.data.rootCauseLine);
			}

			if (getConfig().ui.chatLocation === 'right') {
				chat.post({ type: 'debugResult', data: res.data });
				await ChatPanelProvider.reveal();
				chat.switchTab('debug');
			} else {
				debugPanel.showResult(res.data);
				await vscode.commands.executeCommand('neurocode.debugView.focus');
			}
		}),
	);
}
