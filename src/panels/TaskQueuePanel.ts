import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';
import { getWebviewHtml } from './webviewUtils';

/**
 * Task Queue sidebar WebView provider.
 */
export class TaskQueueProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly sidecar: SidecarManager,
	) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist')],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async (msg: { type: string; task?: string; planId?: string }) => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				return;
			}

			if (msg.type === 'planTask' && msg.task) {
				const res = await this.sidecar.client.planTask(msg.task, folder.uri.fsPath);
				this.post({ type: 'planCreated', data: res.data });
			}

			if (msg.type === 'executeStep' && msg.planId) {
				const editor = vscode.window.activeTextEditor;
				const res = await this.sidecar.client.post(`/agent/plan/${msg.planId}/execute`, {
					projectPath: folder.uri.fsPath,
					activeFile: editor?.document.uri.fsPath,
				});
				this.post({ type: 'stepResult', data: res.data });
			}
		});
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'assets', 'index.js'),
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'assets', 'index.css'),
		);
		return getWebviewHtml(webview, this.extensionUri, 'tasks', scriptUri, styleUri);
	}

	post(message: unknown): void {
		this.view?.webview.postMessage(message);
	}
}
