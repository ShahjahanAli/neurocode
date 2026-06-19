import * as vscode from 'vscode';

/**
 * Generates a cryptographically random nonce for CSP.
 * @returns 32-character hex nonce string.
 */
export function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}

/**
 * Builds CSP-safe WebView HTML shell loading the NeuroCode UI bundle.
 * @param webview - VS Code webview instance.
 * @param extensionUri - Extension root URI.
 * @param viewId - Panel identifier passed to React app.
 * @param scriptUri - URI of the bundled script.
 * @param styleUri - URI of the bundled stylesheet.
 * @returns HTML document string.
 */
export function getWebviewHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	viewId: string,
	scriptUri: vscode.Uri,
	styleUri: vscode.Uri,
): string {
	const nonce = getNonce();

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="
		default-src 'none';
		script-src 'nonce-${nonce}' ${webview.cspSource};
		style-src ${webview.cspSource} 'unsafe-inline';
		img-src ${webview.cspSource} https:;
		font-src ${webview.cspSource};
	">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${styleUri}">
	<title>NeuroCode</title>
</head>
<body>
	<div id="root" data-view="${viewId}"></div>
	<script nonce="${nonce}">
		window.__NEUROCODE_VIEW__ = "${viewId}";
	</script>
	<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
