/// <reference types="vite/client" />

interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

declare global {
	interface Window {
		__NEUROCODE_VIEW__?: string;
	}
}

export {};
