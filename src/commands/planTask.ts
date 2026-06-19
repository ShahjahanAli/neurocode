import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';

/**
 * Registers the Plan Multi-Step Task command.
 * @param context - Extension context.
 * @param sidecar - Sidecar manager instance.
 */
export function registerPlanTask(
	context: vscode.ExtensionContext,
	sidecar: SidecarManager,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('neurocode.planTask', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showErrorMessage('NeuroCode: Open a workspace folder first.');
				return;
			}

			const task = await vscode.window.showInputBox({
				prompt: 'Describe the multi-step task to plan',
			});
			if (!task) {
				return;
			}

			const res = await sidecar.client.planTask(task, folder.uri.fsPath);
			if (!res.success || !res.data) {
				void vscode.window.showErrorMessage(res.error ?? 'Planning failed');
				return;
			}

			void vscode.window.showInformationMessage(
				`Plan created: ${res.data.steps.length} steps (Task Queue UI in Prompt 10+)`,
			);
		}),
	);
}
