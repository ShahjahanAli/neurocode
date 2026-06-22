import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';
import { getWebviewHtml } from './webviewUtils';

/**
 * Analytics sidebar WebView provider (left activity bar).
 */
export class AnalyticsPanelProvider implements vscode.WebviewViewProvider {
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

		webviewView.webview.onDidReceiveMessage(async (msg: { type: string; hours?: number }) => {
			if (msg.type !== 'requestAnalytics') {
				return;
			}
			const hours = msg.hours ?? 24;
			try {
				const [summaryRes, recentRes] = await Promise.all([
					this.sidecar.client.get(`/analytics/summary?hours=${hours}`),
					this.sidecar.client.get('/analytics/recent?limit=25'),
				]);
				if (!summaryRes.success) {
					this.post({
						type: 'analyticsData',
						summary: null,
						events: [],
						error: summaryRes.error ?? 'Analytics unavailable',
					});
					return;
				}
				this.post({
					type: 'analyticsData',
					summary: summaryRes.data,
					events: (recentRes.data as { events?: unknown[] } | undefined)?.events ?? [],
				});
			} catch (err) {
				const errText = err instanceof Error ? err.message : String(err);
				this.post({
					type: 'analyticsData',
					summary: null,
					events: [],
					error: errText,
				});
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
		return getWebviewHtml(webview, this.extensionUri, 'analytics', scriptUri, styleUri);
	}

	private post(message: unknown): void {
		this.view?.webview.postMessage(message);
	}
}
