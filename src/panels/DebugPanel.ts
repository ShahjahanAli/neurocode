import * as vscode from 'vscode';
import { getWebviewHtml } from './webviewUtils';

/** Debug / causal chain sidebar provider. */
export class DebugPanelProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;

	constructor(private readonly extensionUri: vscode.Uri) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist')],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);
	}

	/** Shows causal debug result in the panel. */
	showResult(data: unknown): void {
		this.post({ type: 'debugResult', data });
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'assets', 'index.js'),
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'assets', 'index.css'),
		);
		return getWebviewHtml(webview, this.extensionUri, 'debug', scriptUri, styleUri);
	}

	post(message: unknown): void {
		this.view?.webview.postMessage(message);
	}
}
