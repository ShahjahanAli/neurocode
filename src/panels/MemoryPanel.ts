import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';
import { getWebviewHtml } from './webviewUtils';

/** Project Memory sidebar provider. */
export class MemoryPanelProvider implements vscode.WebviewViewProvider {
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
		void this.loadMemories();

		webviewView.webview.onDidReceiveMessage(async (msg: { type: string; memoryId?: string }) => {
			if (msg.type === 'refresh') {
				await this.loadMemories();
			}
			if (msg.type === 'delete' && msg.memoryId) {
				await this.sidecar.client.delete(`/memory/${msg.memoryId}`);
				await this.loadMemories();
			}
		});
	}

	private async loadMemories(): Promise<void> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return;
		}
		const res = await this.sidecar.client.get(
			`/memory/top?limit=20`,
		);
		this.post({ type: 'memories', data: res.data });
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'assets', 'index.js'),
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'assets', 'index.css'),
		);
		return getWebviewHtml(webview, this.extensionUri, 'memory', scriptUri, styleUri);
	}

	post(message: unknown): void {
		this.view?.webview.postMessage(message);
	}
}
