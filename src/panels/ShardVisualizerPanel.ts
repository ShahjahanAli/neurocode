import * as vscode from 'vscode';
import { getWebviewHtml } from './webviewUtils';
import { lastAgentResponse } from './ChatPanel';

/**
 * Shard Visualizer sidebar WebView provider.
 */
export class ShardVisualizerProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;

	/**
	 * @param extensionUri - Extension root URI.
	 */
	constructor(private readonly extensionUri: vscode.Uri) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist')],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);
		this.pushLatest();
	}

	/** Pushes latest shard data from last agent call. */
	pushLatest(): void {
		if (!lastAgentResponse) {
			return;
		}
		this.post({
			type: 'shards',
			data: {
				shards: lastAgentResponse.shardsUsed,
				totalTokens: lastAgentResponse.tokensUsed,
				budget: lastAgentResponse.budget,
				provider: lastAgentResponse.provider,
				modelUsed: lastAgentResponse.modelUsed,
			},
		});
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'assets', 'index.js'),
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'assets', 'index.css'),
		);
		return getWebviewHtml(webview, this.extensionUri, 'shards', scriptUri, styleUri);
	}

	post(message: unknown): void {
		this.view?.webview.postMessage(message);
	}
}
