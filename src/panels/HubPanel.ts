import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';
import type { HealthData } from '../sidecar/types';
import { getChatViewId, getConfig } from '../utils/config';
import { ChatPanelProvider } from './ChatPanel';
import { getWebviewHtml } from './webviewUtils';

/** Panel id → webview view id for focus commands. */
const PANEL_VIEW_IDS: Record<string, string> = {
	tasks: 'neurocode.tasksView',
	shards: 'neurocode.shardsView',
	review: 'neurocode.reviewView',
	memory: 'neurocode.memoryView',
	debug: 'neurocode.debugView',
};

/**
 * NeuroCode Overview hub — system status and feature launcher.
 */
export class HubPanelProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private lastIndexing: { filesProcessed: number; totalFiles: number } | null = null;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly sidecar: SidecarManager,
		private readonly getSidecarReady: () => boolean,
	) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist')],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async (msg: { type: string; panel?: string; command?: string }) => {
			if (msg.type === 'requestStatus') {
				await this.pushStatus();
				return;
			}

			if (msg.type === 'openPanel' && msg.panel) {
				await this.focusPanel(msg.panel);
				return;
			}

			if (msg.type === 'runCommand' && msg.command) {
				await vscode.commands.executeCommand(msg.command);
			}
		});

		void this.pushStatus();
	}

	/**
	 * Updates indexing progress shown on the hub.
	 * @param progress - Current index job progress or null when idle.
	 */
	setIndexingProgress(progress: { filesProcessed: number; totalFiles: number } | null): void {
		this.lastIndexing = progress;
		void this.pushStatus();
	}

	/**
	 * Pushes fresh health and config to the hub webview.
	 * @param health - Optional pre-fetched health payload.
	 */
	async pushStatus(health?: HealthData): Promise<void> {
		if (!this.view) {
			return;
		}

		let healthData = health;
		if (!healthData && this.sidecar.isRunning()) {
			try {
				const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				const res = await this.sidecar.client.health(projectPath);
				if (res.success && res.data) {
					healthData = res.data;
				}
			} catch {
				// Hub shows unreachable state
			}
		}

		const cfg = getConfig();
		const workspace = vscode.workspace.workspaceFolders?.[0]?.name ?? null;

		this.post({
			type: 'hubStatus',
			sidecarReady: this.getSidecarReady(),
			workspace,
			health: healthData ?? null,
			indexing: this.lastIndexing,
			config: {
				chatLocation: cfg.ui.chatLocation,
				chatMode: cfg.chat.mode,
				autoApply: cfg.chat.autoApply,
				autoContinue: cfg.chat.autoContinue,
				fixOnCheck: cfg.chat.fixOnCheck,
				autoIndex: cfg.indexing.autoIndex,
				provider: cfg.llm.provider,
				tokenBudget: cfg.shard.maxTokens,
				airgap: cfg.airgap.enabled,
				heatmap: cfg.heatmap.enabled,
				memory: cfg.memory.enabled,
				drift: cfg.drift.enabled,
				genome: cfg.genome.enabled,
				crossrepo: cfg.crossrepo.enabled,
				runpodConfigured: Boolean(cfg.runpod.podId),
			},
		});
	}

	private async focusPanel(panel: string): Promise<void> {
		if (panel === 'chat') {
			const chatViewId = getChatViewId();
			if (getConfig().ui.chatLocation === 'right') {
				await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
				await vscode.commands.executeCommand(`${chatViewId}.focus`);
				ChatPanelProvider.instance?.switchTab('chat');
				return;
			}
			await vscode.commands.executeCommand('workbench.view.extension.neurocode-sidebar');
			await vscode.commands.executeCommand(`${chatViewId}.focus`);
			return;
		}

		if (getConfig().ui.chatLocation === 'right') {
			await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
			await vscode.commands.executeCommand('neurocode.rightPanel.focus');
			const tabMap: Record<string, string> = {
				tasks: 'tasks',
				shards: 'shards',
				review: 'review',
				memory: 'memory',
				debug: 'debug',
			};
			const tab = tabMap[panel];
			if (tab) {
				ChatPanelProvider.instance?.switchTab(tab);
			}
			return;
		}

		const viewId = PANEL_VIEW_IDS[panel];
		if (!viewId) {
			return;
		}
		await vscode.commands.executeCommand('workbench.view.extension.neurocode-sidebar');
		await vscode.commands.executeCommand(`${viewId}.focus`);
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'assets', 'index.js'),
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'assets', 'index.css'),
		);
		return getWebviewHtml(webview, this.extensionUri, 'hub', scriptUri, styleUri);
	}

	private post(message: unknown): void {
		this.view?.webview.postMessage(message);
	}
}
