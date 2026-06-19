import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';

/**
 * Registers RunPod stop command.
 * @param context - Extension context.
 * @param sidecar - Sidecar manager instance.
 */
export function registerStopPod(
	context: vscode.ExtensionContext,
	sidecar: SidecarManager,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('neurocode.stopPod', async () => {
			const res = await sidecar.client.stopPod();
			if (!res.success) {
				void vscode.window.showErrorMessage(res.error ?? 'Failed to stop RunPod');
				return;
			}
			void vscode.window.showInformationMessage('NeuroCode: RunPod stopping...');
		}),
	);
}
