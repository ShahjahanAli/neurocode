import { HubPanel } from './panels/HubPanel';
import { ChatPanel } from './panels/ChatPanel';
import { ShardVisualizerPanel } from './panels/ShardVisualizerPanel';
import { TaskQueuePanel } from './panels/TaskQueuePanel';
import { ReviewPanel } from './panels/ReviewPanel';
import { MemoryPanel } from './panels/MemoryPanel';
import { DebugPanel } from './panels/DebugPanel';

const VIEWS: Record<string, () => JSX.Element> = {
	hub: HubPanel,
	chat: ChatPanel,
	shards: ShardVisualizerPanel,
	tasks: TaskQueuePanel,
	review: ReviewPanel,
	memory: MemoryPanel,
	debug: DebugPanel,
};

export function App() {
	const viewId = window.__NEUROCODE_VIEW__ ?? 'chat';
	const View = VIEWS[viewId] ?? ChatPanel;
	return <View />;
}
