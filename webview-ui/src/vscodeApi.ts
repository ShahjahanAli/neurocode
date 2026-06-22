/** Singleton VS Code webview API — acquireVsCodeApi() may only be called once per webview. */
let vscodeApi: ReturnType<typeof acquireVsCodeApi> | undefined;

/**
 * @returns Shared VS Code webview API instance for this panel.
 */
export function getVsCodeApi(): ReturnType<typeof acquireVsCodeApi> {
	if (!vscodeApi) {
		vscodeApi = acquireVsCodeApi();
	}
	return vscodeApi;
}
