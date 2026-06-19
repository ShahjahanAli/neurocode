import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';

/**
 * Registers RunPod start command.
 * @param context - Extension context.
 * @param sidecar - Sidecar manager instance.
 */
export function registerStartPod(
	context: vscode.ExtensionContext,
	sidecar: SidecarManager,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('neurocode.startPod', async () => {
			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'NeuroCode: Starting RunPod L4...',
						cancellable: false,
					},
					async () => {
						const res = await sidecar.client.startPod();
						if (!res.success) {
							throw new Error(res.error ?? 'Failed to start RunPod');
						}
					},
				);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				void vscode.window.showErrorMessage(`NeuroCode: ${msg}`);
			}
		}),
	);
}
