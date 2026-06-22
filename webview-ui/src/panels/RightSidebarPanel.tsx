import { HubPanel } from './HubPanel';
import { ChatPanel } from './ChatPanel';
import { TaskQueuePanel } from './TaskQueuePanel';
import { ShardVisualizerPanel } from './ShardVisualizerPanel';
import { ReviewPanel } from './ReviewPanel';
import { MemoryPanel } from './MemoryPanel';
import { DebugPanel } from './DebugPanel';
import { AnalyticsPanel } from './AnalyticsPanel';
import { useVsCodeApi } from '../hooks/useVSCodeApi';
import { useCallback, useEffect, useState } from 'react';

export type RightTab = 'overview' | 'chat' | 'tasks' | 'shards' | 'review' | 'memory' | 'debug' | 'analytics';

const TABS: Array<{ id: RightTab; label: string; primary?: boolean }> = [
	{ id: 'overview', label: 'Overview', primary: true },
	{ id: 'chat', label: 'Chat', primary: true },
	{ id: 'analytics', label: 'Analytics', primary: true },
	{ id: 'tasks', label: 'Tasks', primary: true },
	{ id: 'shards', label: 'Shards', primary: true },
	{ id: 'review', label: 'Review', primary: true },
	{ id: 'memory', label: 'Memory' },
	{ id: 'debug', label: 'Debug' },
];

const PANEL_TO_TAB: Record<string, RightTab> = {
	chat: 'chat',
	tasks: 'tasks',
	shards: 'shards',
	review: 'review',
	memory: 'memory',
	debug: 'debug',
	analytics: 'analytics',
};

/**
 * Tabbed NeuroCode panel for the right secondary sidebar (Cursor-style).
 */
export function RightSidebarPanel() {
	const vscode = useVsCodeApi();
	const [tab, setTab] = useState<RightTab>('chat');

	useEffect(() => {
		document.body.classList.add('right-sidebar-layout');
		return () => document.body.classList.remove('right-sidebar-layout');
	}, []);

	const selectTab = useCallback((next: RightTab) => {
		setTab(next);
		if (next === 'overview') {
			vscode.postMessage({ type: 'requestStatus' });
		}
		if (next === 'memory') {
			vscode.postMessage({ type: 'refreshMemories' });
		}
		if (next === 'analytics') {
			vscode.postMessage({ type: 'requestAnalytics', hours: 24 });
		}
	}, [vscode]);

	const navigateFromHub = useCallback((panel: string) => {
		const mapped = PANEL_TO_TAB[panel];
		if (mapped) {
			selectTab(mapped);
		}
	}, [selectTab]);

	useEffect(() => {
		const handler = (e: MessageEvent) => {
			if (e.data.type === 'switchTab' && typeof e.data.tab === 'string') {
				const next = e.data.tab as RightTab;
				if (TABS.some((t) => t.id === next)) {
					selectTab(next);
				}
			}
		};
		window.addEventListener('message', handler);
		vscode.postMessage({ type: 'webviewReady' });
		return () => window.removeEventListener('message', handler);
	}, [vscode, selectTab]);

	return (
		<div className="right-sidebar">
			<nav className="right-tabs" aria-label="NeuroCode features">
				{TABS.map((t) => (
					<button
						key={t.id}
						type="button"
						className={`right-tab${tab === t.id ? ' active' : ''}${t.primary ? ' primary' : ''}`}
						onClick={() => selectTab(t.id)}
						aria-selected={tab === t.id}
					>
						{t.label}
					</button>
				))}
			</nav>
			<div className="right-tab-content">
				{tab === 'overview' && (
					<HubPanel embedded onNavigate={navigateFromHub} />
				)}
				{tab === 'chat' && <ChatPanel embedded />}
				{tab === 'tasks' && <TaskQueuePanel embedded />}
				{tab === 'shards' && <ShardVisualizerPanel embedded />}
				{tab === 'review' && <ReviewPanel embedded />}
				{tab === 'memory' && <MemoryPanel embedded />}
				{tab === 'debug' && <DebugPanel embedded />}
				{tab === 'analytics' && <AnalyticsPanel embedded />}
			</div>
		</div>
	);
}
