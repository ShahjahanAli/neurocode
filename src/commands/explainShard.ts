import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';

/**
 * Registers the Explain Context Shards command.
 * @param context - Extension context.
 * @param sidecar - Sidecar manager instance.
 */
export function registerExplainShard(
	context: vscode.ExtensionContext,
	sidecar: SidecarManager,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('neurocode.explainShard', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showErrorMessage('NeuroCode: Open a workspace folder first.');
				return;
			}

			const task = await vscode.window.showInputBox({
				prompt: 'Task to preview shards for',
				value: 'Explain this file',
			});
			if (!task) {
				return;
			}

			const editor = vscode.window.activeTextEditor;
			const res = await sidecar.client.shardPreview({
				task,
				activeFile: editor?.document.uri.fsPath,
				projectPath: folder.uri.fsPath,
			});

			if (!res.success || !res.data) {
				void vscode.window.showErrorMessage(res.error ?? 'Shard preview failed');
				return;
			}

			const lines = res.data.shards.map(
				(s) => `• ${s.file} — ${s.reason} (${s.tokenCount} tokens)`,
			);
			const doc = await vscode.workspace.openTextDocument({
				content: [
					`# Shard Preview`,
					`Budget: ${res.data.totalTokens}/${res.data.budget} (${res.data.provider})`,
					'',
					...lines,
				].join('\n'),
				language: 'markdown',
			});
			await vscode.window.showTextDocument(doc);
		}),
	);
}
