import { useVsCodeApi } from '../hooks/useVSCodeApi';
import { useEffect, useState } from 'react';

interface HubHealth {
	status: string;
	airgap: boolean;
	provider: string | null;
	model: { name: string; provider: string; gpu: string } | null;
	tokenBudget: number;
	podState: string;
	idleRemainingMs: number | null;
	indexed: boolean;
	fileCount: number;
}

interface HubConfig {
	chatLocation: 'right' | 'left';
	chatMode: string;
	autoApply: boolean;
	autoContinue: boolean;
	fixOnCheck: boolean;
	autoIndex: boolean;
	provider: string;
	tokenBudget: number;
	airgap: boolean;
	heatmap: boolean;
	memory: boolean;
	drift: boolean;
	genome: boolean;
	crossrepo: boolean;
	runpodConfigured: boolean;
}

interface HubStatus {
	sidecarReady: boolean;
	workspace: string | null;
	health: HubHealth | null;
	indexing: { filesProcessed: number; totalFiles: number } | null;
	config: HubConfig;
}

interface FeatureCard {
	id: string;
	title: string;
	description: string;
	panel?: string;
	command?: string;
	shortcut?: string;
	tag?: string;
}

const FEATURE_SECTIONS: Array<{ title: string; items: FeatureCard[] }> = [
	{
		title: 'Chat & agents',
		items: [
			{
				id: 'chat',
				title: 'Chat',
				description: 'Cursor-style assistant with Auto, Ask, Plan, Edit, and Agent modes. Streams responses and can write files.',
				panel: 'chat',
				shortcut: 'Ctrl+Shift+A',
				tag: 'Primary',
			},
			{
				id: 'tasks',
				title: 'Task Queue',
				description: 'Multi-step plans with DAG execution. Create a plan, then run steps one by one.',
				panel: 'tasks',
				command: 'neurocode.planTask',
			},
			{
				id: 'shards',
				title: 'Shard Visualizer',
				description: 'See which files were pulled into context, why, and token budget usage after each ask.',
				panel: 'shards',
			},
		],
	},
	{
		title: 'Quality & debugging',
		items: [
			{
				id: 'review',
				title: 'Code Review',
				description: 'Parallel review agents (architect, security, performance, tests) on selected code.',
				panel: 'review',
				command: 'neurocode.reviewCode',
				shortcut: 'Ctrl+Shift+R',
			},
			{
				id: 'debug',
				title: 'Causal Debug',
				description: 'Trace errors and stack traces back through the dependency graph.',
				panel: 'debug',
				command: 'neurocode.debugCause',
				shortcut: 'Ctrl+Shift+D',
			},
			{
				id: 'memory',
				title: 'Project Memory',
				description: 'Long-term facts the agent remembers about this codebase across sessions.',
				panel: 'memory',
				command: 'neurocode.showMemory',
			},
		],
	},
	{
		title: 'Indexing & context',
		items: [
			{
				id: 'index',
				title: 'Index Project',
				description: 'Scan workspace files, build dependency graph, and embed symbols for shard assembly.',
				command: 'neurocode.indexProject',
			},
			{
				id: 'heatmap',
				title: 'Attention Heatmap',
				description: 'Editor gutter highlights for files/lines the model focused on or missed.',
				tag: 'Editor',
			},
			{
				id: 'drift',
				title: 'Semantic Drift',
				description: 'Detect when code meaning diverges from indexed embeddings after commits.',
				panel: 'drift',
				tag: 'Background',
			},
			{
				id: 'genome',
				title: 'Edit Genome',
				description: 'Anonymized edit telemetry stats and export for training signals.',
				panel: 'genome',
			},
		],
	},
	{
		title: 'Infrastructure',
		items: [
			{
				id: 'runpod',
				title: 'GPU Pod (optional)',
				description: 'Optional RunPod lifecycle: start/stop a GPU pod. Your LLM URL is set separately in neurocode.llm.apiBaseUrl.',
				command: 'neurocode.startPod',
			},
			{
				id: 'analytics',
				title: 'Analytics',
				description: 'Token usage, latency, LLM calls, and feedback summary for this project.',
				panel: 'analytics',
			},
			{
				id: 'cost',
				title: 'Cost Report',
				description: 'Session minutes, LLM calls, and estimated RunPod spend.',
				command: 'neurocode.showCostReport',
			},
			{
				id: 'airgap',
				title: 'Air-gap Mode',
				description: 'Block all outbound network from sidecar except localhost.',
				command: 'neurocode.toggleAirGap',
			},
		],
	},
];

function podLabel(state: string): string {
	switch (state) {
		case 'warm': return 'GPU pod warm';
		case 'running': return 'GPU pod running';
		case 'starting': return 'Starting pod…';
		case 'stopping': return 'Stopping pod…';
		case 'stopped': return 'Pod stopped';
		case 'gateway-connected':
		case 'direct-vllm': return 'Gateway connected';
		case 'not-configured': return 'Not configured';
		default: return state;
	}
}

function modeLabel(mode: string): string {
	const labels: Record<string, string> = {
		auto: 'Auto',
		explain: 'Ask',
		plan: 'Plan',
		implement: 'Edit',
		agent: 'Agent',
	};
	return labels[mode] ?? mode;
}

export function HubPanel({
	embedded = false,
	onNavigate,
}: {
	embedded?: boolean;
	onNavigate?: (panel: string) => void;
} = {}) {
	const vscode = useVsCodeApi();
	const [status, setStatus] = useState<HubStatus | null>(null);

	useEffect(() => {
		const handler = (e: MessageEvent) => {
			if (e.data.type === 'hubStatus') {
				setStatus(e.data as HubStatus);
			}
		};
		window.addEventListener('message', handler);
		vscode.postMessage({ type: 'requestStatus' });
		const timer = setInterval(() => vscode.postMessage({ type: 'requestStatus' }), 15000);
		return () => {
			window.removeEventListener('message', handler);
			clearInterval(timer);
		};
	}, [vscode]);

	const openPanel = (panel: string): void => {
		if (embedded && onNavigate) {
			onNavigate(panel);
			return;
		}
		vscode.postMessage({ type: 'openPanel', panel });
	};

	const runCommand = (command: string): void => {
		vscode.postMessage({ type: 'runCommand', command });
	};

	const health = status?.health;
	const cfg = status?.config;
	const indexing = status?.indexing;
	const sidecarOk = status?.sidecarReady && health?.status === 'ok';

	return (
		<div className={`panel hub-panel${embedded ? ' hub-panel-embedded' : ''}`}>
			<header className="hub-header">
				<h2 className="hub-title">NeuroCode</h2>
				<p className="hub-subtitle">Agentic coding with smart context shards</p>
			</header>

			<section className="hub-status-card">
				<div className="hub-status-row">
					<span className={`hub-dot ${sidecarOk ? 'ok' : 'err'}`} />
					<span>{sidecarOk ? 'Sidecar connected' : 'Sidecar unavailable'}</span>
				</div>
				{status?.workspace && (
					<div className="hub-status-row muted">Workspace: {status.workspace}</div>
				)}
				{health && (
					<div className="hub-status-grid">
						<div className="hub-stat">
							<span className="hub-stat-label">Model</span>
							<span className="hub-stat-value">{health.model?.name ?? '—'}</span>
						</div>
						<div className="hub-stat">
							<span className="hub-stat-label">Provider</span>
							<span className="hub-stat-value">{health.provider ?? '—'}</span>
						</div>
						<div className="hub-stat">
							<span className="hub-stat-label">Indexed</span>
							<span className="hub-stat-value">{health.fileCount} files</span>
						</div>
						<div className="hub-stat">
							<span className="hub-stat-label">Token budget</span>
							<span className="hub-stat-value">{health.tokenBudget}</span>
						</div>
						<div className="hub-stat">
							<span className="hub-stat-label">GPU / pod</span>
							<span className="hub-stat-value">{podLabel(health.podState)}</span>
						</div>
						{cfg && (
							<div className="hub-stat">
								<span className="hub-stat-label">Chat mode</span>
								<span className="hub-stat-value">{modeLabel(cfg.chatMode)}</span>
							</div>
						)}
					</div>
				)}
				{indexing && indexing.totalFiles > 0 && (
					<div className="indexing-banner hub-indexing">
						Indexing {indexing.filesProcessed} / {indexing.totalFiles} files…
					</div>
				)}
				{cfg?.airgap && (
					<div className="hub-airgap-badge">Air-gap mode active</div>
				)}
			</section>

			{cfg && (
				<section className="hub-activity">
					<h3 className="hub-section-title">What&apos;s on</h3>
					<ul className="hub-activity-list">
						{!embedded && (
							<li>Chat panel: <strong>{cfg.chatLocation === 'right' ? 'Right sidebar' : 'This sidebar'}</strong></li>
						)}
						{embedded && (
							<li>Switch tabs above for Chat, Tasks, Shards, and more</li>
						)}
						<li>Auto-index on open: <strong>{cfg.autoIndex ? 'Yes' : 'No'}</strong></li>
						<li>Auto-apply edits: <strong>{cfg.autoApply ? 'Yes' : 'No'}</strong></li>
						<li>Auto-continue codegen: <strong>{cfg.autoContinue ? 'Yes' : 'No'}</strong></li>
						<li>Fix incomplete files on check: <strong>{cfg.fixOnCheck ? 'Yes' : 'No'}</strong></li>
						<li>Attention heatmap: <strong>{cfg.heatmap ? 'On' : 'Off'}</strong></li>
						<li>Project memory: <strong>{cfg.memory ? 'On' : 'Off'}</strong></li>
						<li>Semantic drift: <strong>{cfg.drift ? 'On' : 'Off'}</strong></li>
						{cfg.genome && <li>Edit genome learning: <strong>On</strong></li>}
						{cfg.crossrepo && <li>Cross-repo index: <strong>On</strong></li>}
					</ul>
				</section>
			)}

			<section className="hub-quick-actions">
				<h3 className="hub-section-title">Quick start</h3>
				<div className="hub-action-row">
					<button type="button" className="hub-btn primary" onClick={() => openPanel('chat')}>
						Open Chat
					</button>
					<button type="button" className="hub-btn" onClick={() => runCommand('neurocode.indexProject')}>
						Index project
					</button>
					<button type="button" className="hub-btn" onClick={() => runCommand('neurocode.askAgent')}>
						Ask agent
					</button>
				</div>
			</section>

			{FEATURE_SECTIONS.map((section) => (
				<section key={section.title} className="hub-feature-section">
					<h3 className="hub-section-title">{section.title}</h3>
					<div className="hub-feature-grid">
						{section.items.map((item) => {
							const enabled =
								item.id !== 'heatmap' ? true
								: cfg?.heatmap;
							const showDrift = item.id !== 'drift' || cfg?.drift;
							const showGenome = item.id !== 'genome';
							if (item.id === 'drift' && !showDrift) return null;
							if (item.id === 'heatmap' && !enabled) {
								return (
									<article key={item.id} className="hub-feature-card muted-card">
										<div className="hub-feature-head">
											<span className="hub-feature-title">{item.title}</span>
											<span className="hub-feature-tag off">Off</span>
										</div>
										<p className="hub-feature-desc">{item.description}</p>
									</article>
								);
							}
							if (!showGenome && item.id === 'genome') return null;

							return (
								<article key={item.id} className="hub-feature-card">
									<div className="hub-feature-head">
										<span className="hub-feature-title">{item.title}</span>
										{item.tag && <span className="hub-feature-tag">{item.tag}</span>}
										{item.shortcut && <span className="hub-feature-shortcut">{item.shortcut}</span>}
									</div>
									<p className="hub-feature-desc">{item.description}</p>
									<div className="hub-feature-actions">
										{item.panel && (
											<button type="button" className="hub-btn sm" onClick={() => openPanel(item.panel!)}>
												Open panel
											</button>
										)}
										{item.command && (
											<button type="button" className="hub-btn sm secondary" onClick={() => runCommand(item.command!)}>
												Run
											</button>
										)}
									</div>
								</article>
							);
						})}
					</div>
				</section>
			))}

			{!embedded && (
			<footer className="hub-footer">
				<p>Status bar shows live model, index count, and pod state. Use sidebar sections below for each panel.</p>
			</footer>
			)}
		</div>
	);
}
