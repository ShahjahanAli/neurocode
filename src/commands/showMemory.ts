import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';

/**
 * Registers the Project Memory viewer command (stub until Prompt 13+).
 * @param context - Extension context.
 * @param sidecar - Sidecar manager instance.
 */
export function registerShowMemory(
	context: vscode.ExtensionContext,
	sidecar: SidecarManager,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('neurocode.showMemory', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showErrorMessage('NeuroCode: Open a workspace folder first.');
				return;
			}

			const res = await sidecar.client.get(
				`/memory/top?projectPath=${encodeURIComponent(folder.uri.fsPath)}&limit=20`,
			);

			if (!res.success) {
				void vscode.window.showWarningMessage(
					res.error ?? 'Project memory not yet implemented — see CURSOR_PROMPTS Prompt 13',
				);
			}
		}),
	);
}
