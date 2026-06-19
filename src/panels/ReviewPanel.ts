import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';
import { getWebviewHtml } from './webviewUtils';

/** Code Review sidebar provider. */
export class ReviewPanelProvider implements vscode.WebviewViewProvider {
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

		webviewView.webview.onDidReceiveMessage(async (msg: { type: string }) => {
			if (msg.type !== 'startReview') {
				return;
			}
			const folder = vscode.workspace.workspaceFolders?.[0];
			const editor = vscode.window.activeTextEditor;
			if (!folder || !editor) {
				return;
			}

			this.post({ type: 'reviewRunning' });
			const res = await this.sidecar.client.post('/review/start', {
				activeFile: editor.document.uri.fsPath,
				cursorLine: editor.selection.active.line,
				projectPath: folder.uri.fsPath,
			});
			this.post({ type: 'reviewResults', data: res.data });
		});
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'assets', 'index.js'),
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'assets', 'index.css'),
		);
		return getWebviewHtml(webview, this.extensionUri, 'review', scriptUri, styleUri);
	}

	post(message: unknown): void {
		this.view?.webview.postMessage(message);
	}
}
