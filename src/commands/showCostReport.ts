import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';

interface SessionRow {
	id: string;
	started_at: number;
	stopped_at: number | null;
	durationMin: number;
	estimatedCostUsd: number;
	llm_calls: number;
}

/**
 * Registers RunPod cost report command (Prompt 16).
 * @param context - Extension context.
 * @param sidecar - Sidecar manager.
 */
export function registerShowCostReport(
	context: vscode.ExtensionContext,
	sidecar: SidecarManager,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('neurocode.showCostReport', async () => {
			const res = await sidecar.client.get<{ sessions: SessionRow[] }>('/runpod/sessions');
			const sessions = res.data?.sessions ?? [];

			const panel = vscode.window.createWebviewPanel(
				'neurocodeCostReport',
				'RunPod Cost Report',
				vscode.ViewColumn.One,
				{ enableScripts: false },
			);

			const totalCost = sessions.reduce((s, r) => s + (r.estimatedCostUsd ?? 0), 0);
			const totalMin = sessions.reduce((s, r) => s + (r.durationMin ?? 0), 0);
			const monthlyEst = totalMin > 0 ? (totalCost / totalMin) * 60 * 24 * 30 : 0;

			const rows = sessions.map((s) => {
				const date = new Date(s.started_at).toLocaleDateString();
				return `<tr><td>${date}</td><td>${s.durationMin} min</td><td>$${s.estimatedCostUsd.toFixed(2)}</td><td>${s.llm_calls}</td></tr>`;
			}).join('');

			panel.webview.html = `<!DOCTYPE html><html><head><style>
				body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
				table { border-collapse: collapse; width: 100%; }
				th, td { border: 1px solid var(--vscode-panel-border); padding: 8px; text-align: left; }
				th { background: var(--vscode-sideBar-background); }
			</style></head><body>
				<h2>RunPod Session Cost Report</h2>
				<table>
					<tr><th>Session</th><th>Duration</th><th>Est. Cost</th><th>LLM Calls</th></tr>
					${rows}
					<tr><td><strong>Total</strong></td><td>${totalMin} min</td><td><strong>$${totalCost.toFixed(2)}</strong></td><td></td></tr>
				</table>
				<p>At this rate, monthly estimate: ~$${monthlyEst.toFixed(2)}</p>
			</body></html>`;
		}),
	);
}
