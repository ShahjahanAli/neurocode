import * as vscode from 'vscode';
import { registerAskAgent } from './commands/askAgent';
import { registerPlanTask } from './commands/planTask';
import { registerIndexProject } from './commands/indexProject';
import { registerExplainShard } from './commands/explainShard';
import { registerReviewCode } from './commands/reviewCode';
import { registerDebugCause } from './commands/debugCause';
import { registerShowMemory } from './commands/showMemory';
import { registerToggleAirGap } from './commands/toggleAirGap';
import { registerStartPod } from './commands/startPod';
import { registerStopPod } from './commands/stopPod';
import { registerChangeReview } from './commands/changeReview';
import { registerShowCostReport } from './commands/showCostReport';
import { SidecarManager } from './sidecar/SidecarManager';
import type { HealthData } from './sidecar/types';
import { getConfig, getChatViewId } from './utils/config';
import { logger } from './utils/logger';
import { AttentionHeatmap } from './editor/AttentionHeatmap';
import { HubPanelProvider } from './panels/HubPanel';
import { ChatPanelProvider } from './panels/ChatPanel';
import { ShardVisualizerProvider } from './panels/ShardVisualizerPanel';
import { TaskQueueProvider } from './panels/TaskQueuePanel';
import { ReviewPanelProvider } from './panels/ReviewPanel';
import { MemoryPanelProvider } from './panels/MemoryPanel';
import { AnalyticsPanelProvider } from './panels/AnalyticsPanelProvider';
import { DebugPanelProvider } from './panels/DebugPanel';
import { AutoIndexer } from './services/AutoIndexer';

let sidecarManager: SidecarManager | undefined;
let sidecarReady = false;
let statusBarItem: vscode.StatusBarItem | undefined;
let healthPollTimer: ReturnType<typeof setInterval> | undefined;
let podPollTimer: ReturnType<typeof setInterval> | undefined;
let heatmap: AttentionHeatmap | undefined;
let hubProvider: HubPanelProvider | undefined;
let chatProvider: ChatPanelProvider | undefined;
let shardProvider: ShardVisualizerProvider | undefined;
let debugProvider: DebugPanelProvider | undefined;

/**
 * Activates the NeuroCode extension.
 * @param context - VS Code extension context.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	logger.log('NeuroCode activating...');

	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.text = '$(sync~spin) NeuroCode | Connecting...';
	statusBarItem.command = 'neurocode.askAgent';
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	heatmap = new AttentionHeatmap(context);
	context.subscriptions.push(heatmap);
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => heatmap?.reapplyIfNeeded()),
	);

	sidecarManager = new SidecarManager(context);
	context.subscriptions.push({ dispose: () => sidecarManager?.stop() });

	try {
		await sidecarManager.start();
		sidecarReady = true;
	} catch (err: unknown) {
		sidecarReady = false;
		const msg = err instanceof Error ? err.message : String(err);
		logger.error(msg);
		if (statusBarItem) {
			statusBarItem.text = '$(error) NeuroCode | Sidecar failed';
			statusBarItem.tooltip = msg;
		}
		void vscode.window.showErrorMessage(`NeuroCode: ${msg}`);
	}

	const restartSidecar = async (): Promise<void> => {
		if (!sidecarManager) {
			return;
		}
		sidecarManager.stop();
		sidecarManager = new SidecarManager(context);
		try {
			await sidecarManager.start();
			sidecarReady = true;
		} catch (err: unknown) {
			sidecarReady = false;
			const msg = err instanceof Error ? err.message : String(err);
			logger.error(`Sidecar restart failed: ${msg}`);
		}
	};

	hubProvider = new HubPanelProvider(context.extensionUri, sidecarManager, () => sidecarReady);
	let leftChatProvider: ChatPanelProvider | undefined;
	chatProvider = new ChatPanelProvider(
		context.extensionUri,
		sidecarManager,
		heatmap,
		context,
		() => sidecarReady,
	);
	leftChatProvider = new ChatPanelProvider(
		context.extensionUri,
		sidecarManager,
		heatmap,
		context,
		() => sidecarReady,
	);
	shardProvider = new ShardVisualizerProvider(context.extensionUri);
	debugProvider = new DebugPanelProvider(context.extensionUri);

	const syncChatLocationContext = (): void => {
		const location = getConfig().ui.chatLocation;
		void vscode.commands.executeCommand('setContext', 'neurocode.chatLocation', location);
	};
	syncChatLocationContext();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('neurocode.ui.chatLocation')) {
				syncChatLocationContext();
				void vscode.window.showInformationMessage(
					'NeuroCode: Reload the window (Developer: Reload Window) to apply chat panel location.',
				);
			}
		}),
	);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('neurocode.hubView', hubProvider),
		vscode.window.registerWebviewViewProvider('neurocode.rightPanel', chatProvider),
		vscode.window.registerWebviewViewProvider('neurocode.chatViewLeft', leftChatProvider),
		vscode.window.registerWebviewViewProvider('neurocode.shardsView', shardProvider),
		vscode.window.registerWebviewViewProvider('neurocode.tasksView', new TaskQueueProvider(context.extensionUri, sidecarManager)),
		vscode.window.registerWebviewViewProvider('neurocode.reviewView', new ReviewPanelProvider(context.extensionUri, sidecarManager)),
		vscode.window.registerWebviewViewProvider('neurocode.memoryView', new MemoryPanelProvider(context.extensionUri, sidecarManager)),
		vscode.window.registerWebviewViewProvider('neurocode.analyticsView', new AnalyticsPanelProvider(context.extensionUri, sidecarManager)),
		vscode.window.registerWebviewViewProvider('neurocode.debugView', debugProvider),
	);

	registerAskAgent(context, sidecarManager, chatProvider, shardProvider, heatmap);
	registerPlanTask(context, sidecarManager);
	registerIndexProject(context, sidecarManager);
	registerExplainShard(context, sidecarManager);
	registerReviewCode(context, sidecarManager);
	registerDebugCause(context, sidecarManager, debugProvider, heatmap, chatProvider);
	registerShowMemory(context, sidecarManager);
	registerToggleAirGap(context, sidecarManager, restartSidecar);
	registerStartPod(context, sidecarManager);
	registerStopPod(context, sidecarManager);
	registerShowCostReport(context, sidecarManager);
	registerChangeReview(context, chatProvider);

	void refreshHealthStatus();
	healthPollTimer = setInterval(() => { void refreshHealthStatus(); }, 30_000);
	podPollTimer = setInterval(() => { void refreshHealthStatus(); }, 10_000);
	context.subscriptions.push({
		dispose: () => {
			clearInterval(healthPollTimer);
			clearInterval(podPollTimer);
		},
	});

	await maybeAutoStartPod(sidecarManager);

	if (sidecarReady) {
		startAutoIndexing(sidecarManager, context);
	}

	logger.log('NeuroCode activated');
}

/**
 * Starts background indexing when a workspace opens or changes.
 * @param sidecar - Sidecar manager instance.
 * @param context - Extension context for workspace listeners.
 */
function startAutoIndexing(sidecar: SidecarManager, context: vscode.ExtensionContext): void {
	const onProgress = (progress: { filesProcessed: number; totalFiles: number } | null): void => {
		hubProvider?.setIndexingProgress(progress);
		chatProvider?.setIndexingProgress(progress);
		if (!statusBarItem) {
			return;
		}
		if (progress && progress.totalFiles > 0) {
			statusBarItem.text =
				`$(sync~spin) NeuroCode | Indexing ${progress.filesProcessed}/${progress.totalFiles}...`;
		} else {
			void refreshHealthStatus();
		}
	};

	AutoIndexer.scheduleWorkspaceAutoIndex(sidecar, onProgress, context);

	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			void (async () => {
				if (sidecarManager?.isRunning()) {
					await sidecarManager.restart();
					sidecarReady = true;
				}
				AutoIndexer.scheduleWorkspaceAutoIndex(sidecar, onProgress, context);
			})();
		}),
	);
}

/**
 * Auto-starts RunPod when configured (Prompt 15).
 * @param sidecar - Sidecar manager instance.
 */
async function maybeAutoStartPod(sidecar: SidecarManager): Promise<void> {
	const cfg = getConfig();
	if (!cfg.runpod.podId || !cfg.runpod.autoStart || cfg.airgap.enabled) {
		return;
	}

	void vscode.window.setStatusBarMessage('$(sync~spin) NeuroCode: Starting RunPod L4...', 30_000);

	try {
		await sidecar.client.startPod();
		const deadline = Date.now() + 180_000;
		const poll = setInterval(async () => {
			const status = await sidecar.client.runpodStatus();
			const state = status.data?.podState;
			if (state === 'warm' || state === 'running') {
				clearInterval(poll);
				void vscode.window.showInformationMessage(
					'NeuroCode: RunPod L4 ready! Qwen3-Coder loaded. Budget: 6000 tokens.',
				);
			}
			if (Date.now() > deadline) {
				clearInterval(poll);
			}
		}, 5000);
	} catch {
		// RunPod optional
	}
}

/** Polls sidecar /health and updates status bar. */
async function refreshHealthStatus(): Promise<void> {
	if (!sidecarManager || !statusBarItem) {
		return;
	}

	try {
		const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const res = await sidecarManager.client.health(projectPath);
		if (res.success && res.data) {
			updateStatusBar(res.data);
			void hubProvider?.pushStatus(res.data);
			void chatProvider?.pushHubStatus(res.data);
		}
	} catch {
		statusBarItem.text = '$(error) NeuroCode | Sidecar unreachable';
	}
}

/**
 * Updates status bar from health payload.
 * @param health - Health endpoint data.
 */
function updateStatusBar(health: HealthData): void {
	if (!statusBarItem) {
		return;
	}

	const modelName = health.model?.name ?? 'no model';
	const fileCount = health.fileCount;

	if (health.airgap) {
		statusBarItem.text = `$(shield) NeuroCode [AIR-GAP] | ${modelName} | ${fileCount} files`;
		statusBarItem.tooltip = `Token budget: ${health.tokenBudget} | Air-gap mode active`;
		return;
	}

	switch (health.podState) {
		case 'stopped':
			statusBarItem.text = '$(circle-slash) NeuroCode | RunPod stopped | fallback: Ollama';
			break;
		case 'starting':
			statusBarItem.text = '$(sync~spin) NeuroCode | Starting RunPod L4...';
			break;
		case 'running':
			statusBarItem.text = `$(remote-explorer) NeuroCode | Qwen3 on RunPod L4 | ${fileCount} files`;
			break;
		case 'warm':
			statusBarItem.text = `$(rocket) NeuroCode | Qwen3 warm | ${fileCount} files`;
			break;
		case 'stopping':
			statusBarItem.text = '$(sync~spin) NeuroCode | RunPod stopping...';
			break;
		case 'not-configured':
			statusBarItem.text = health.provider === 'vllm'
				? `$(remote-explorer) NeuroCode | ${modelName} | ${fileCount} files`
				: `$(chip) NeuroCode | ${modelName} | ${fileCount} files`;
			break;
		case 'direct-vllm':
			statusBarItem.text = `$(remote-explorer) NeuroCode | ${modelName} | ${fileCount} files`;
			break;
		default:
			statusBarItem.text = `$(info) NeuroCode | ${modelName} | ${fileCount} files`;
	}

	statusBarItem.tooltip = `Provider: ${health.provider ?? 'none'} | Token budget: ${health.tokenBudget} | Click to ask agent`;
}

/** Deactivates extension and stops sidecar. */
export function deactivate(): void {
	clearInterval(healthPollTimer);
	clearInterval(podPollTimer);
	heatmap?.dispose();
	sidecarManager?.stop();
	sidecarManager = undefined;
}
