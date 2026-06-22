import { getVsCodeApi } from '../vscodeApi';
import { useMemo } from 'react';

/** Returns the VS Code webview API singleton. */
export function useVsCodeApi() {
	return useMemo(() => getVsCodeApi(), []);
}
