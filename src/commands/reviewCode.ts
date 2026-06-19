import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';

/**
 * Registers the multi-agent code review command (stub until Prompt 14+).
 * @param context - Extension context.
 * @param sidecar - Sidecar manager instance.
 */
export function registerReviewCode(
	context: vscode.ExtensionContext,
	sidecar: SidecarManager,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('neurocode.reviewCode', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showErrorMessage('NeuroCode: Open a workspace folder first.');
				return;
			}

			const res = await sidecar.client.post('/review/start', {
				activeFile: vscode.window.activeTextEditor?.document.uri.fsPath,
				cursorLine: vscode.window.activeTextEditor?.selection.active.line,
				projectPath: folder.uri.fsPath,
			});

			if (!res.success) {
				void vscode.window.showWarningMessage(
					res.error ?? 'Code review not yet implemented — see CURSOR_PROMPTS Prompt 14',
				);
			}
		}),
	);
}
