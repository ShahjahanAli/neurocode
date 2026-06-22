import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';
import { AutoIndexer } from '../services/AutoIndexer';

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
					{
						location: vscode.ProgressLocation.Notification,
						title: 'NeuroCode: Indexing...',
						cancellable: false,
					},
					async (progress) => {
						await AutoIndexer.runIndex(sidecar, folder.uri.fsPath, {
							silent: false,
							onProgress: (p) => {
								progress.report({
									message: `${p.filesProcessed}/${p.totalFiles} files`,
								});
							},
						});
					},
				);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				void vscode.window.showErrorMessage(`NeuroCode: ${msg}`);
			}
		}),
	);
}
