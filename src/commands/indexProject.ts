import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';

/**
 * Registers the Index Project command.
 * @param context - Extension context.
 * @param sidecar - Sidecar manager instance.
 */
export function registerIndexProject(
	context: vscode.ExtensionContext,
	sidecar: SidecarManager,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('neurocode.indexProject', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showErrorMessage('NeuroCode: Open a workspace folder first.');
				return;
			}

			try {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'NeuroCode: Indexing...' },
					async () => {
						const start = await sidecar.client.startIndex(folder.uri.fsPath);
						if (!start.success || !start.data) {
							throw new Error(start.error ?? 'Failed to start indexing');
						}

						const jobId = start.data.jobId;
						for (;;) {
							await new Promise((r) => setTimeout(r, 1000));
							const status = await sidecar.client.indexStatus(jobId);
							if (!status.success || !status.data) {
								throw new Error(status.error ?? 'Index status failed');
							}
							if (status.data.status === 'done') {
								void vscode.window.showInformationMessage(
									`Indexed ${status.data.filesProcessed} files`,
								);
								return;
							}
							if (status.data.status === 'failed') {
								throw new Error('Indexing failed');
							}
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
