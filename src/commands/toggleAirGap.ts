import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';

/**
 * Registers the air-gap mode toggle command.
 * @param context - Extension context.
 * @param sidecar - Sidecar manager for restart after config change.
 * @param onRestart - Callback to restart sidecar with new env.
 */
export function registerToggleAirGap(
	context: vscode.ExtensionContext,
	sidecar: SidecarManager,
	onRestart: () => Promise<void>,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('neurocode.toggleAirGap', async () => {
			const cfg = vscode.workspace.getConfiguration('neurocode');
			const current = cfg.get<boolean>('airgap.enabled', false);
			const next = !current;

			await cfg.update('airgap.enabled', next, vscode.ConfigurationTarget.Global);
			void vscode.window.showInformationMessage(
				`NeuroCode air-gap mode ${next ? 'enabled' : 'disabled'} — restarting sidecar...`,
			);

			sidecar.stop();
			await onRestart();
		}),
	);
}
