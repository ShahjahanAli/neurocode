const POD_STATE_CONFIG: Record<string, { color: string; icon: string; label: string }> = {
	stopped: { color: '#888', icon: '⊘', label: 'GPU pod stopped' },
	starting: { color: '#FFD700', icon: '⟳', label: 'Starting GPU pod…' },
	running: { color: '#4AFF9B', icon: '▶', label: 'GPU pod running' },
	warm: { color: '#FF6B35', icon: '🔥', label: 'GPU pod warm' },
	stopping: { color: '#FFD700', icon: '⟳', label: 'Stopping pod…' },
};

const CONNECTION_CONFIG: Record<string, { color: string; icon: string; label: string }> = {
	'gateway-connected': { color: '#4AFF9B', icon: '●', label: 'Gateway connected' },
	'local-ollama': { color: '#4A9EFF', icon: '◉', label: 'Local Ollama' },
	'not-configured': { color: '#888', icon: '—', label: 'LLM not configured' },
	unavailable: { color: '#FF9B4A', icon: '⚠', label: 'Gateway unreachable' },
};

interface Props {
	podState: string;
	provider?: string | null;
	modelName?: string | null;
	lifecycleConfigured?: boolean;
	idleRemainingMs?: number;
	onStart?: () => void;
	onStop?: () => void;
}

/**
 * Shows LLM gateway / Ollama connection status with optional GPU pod lifecycle controls.
 */
export function LlmConnectionBadge({
	podState,
	provider,
	modelName,
	lifecycleConfigured,
	idleRemainingMs,
	onStart,
	onStop,
}: Props) {
	const showPodControls = lifecycleConfigured && podState in POD_STATE_CONFIG;
	const connKey = provider === 'ollama'
		? 'local-ollama'
		: (CONNECTION_CONFIG[podState] ? podState : (provider === 'gateway' ? 'gateway-connected' : 'not-configured'));
	const conn = CONNECTION_CONFIG[connKey] ?? CONNECTION_CONFIG['not-configured'];
	const pod = POD_STATE_CONFIG[podState];
	const idleMin = idleRemainingMs ? Math.ceil(idleRemainingMs / 60_000) : null;
	const modelLabel = modelName ? ` · ${modelName}` : '';

	return (
		<div className="llm-connection-badge">
			<span style={{ color: conn.color, fontWeight: 600, fontSize: '0.85em' }}>
				{conn.icon} {conn.label}{modelLabel}
				{podState === 'warm' && idleMin !== null && ` · idle ${idleMin}m`}
			</span>
			{showPodControls && pod && (
				<span className="pod-substatus" style={{ color: pod.color, fontSize: '0.78em' }}>
					{pod.icon} {pod.label}
				</span>
			)}
			<div className="llm-connection-actions">
				{lifecycleConfigured && podState === 'stopped' && onStart && (
					<button className="secondary" type="button" onClick={onStart} title="Start GPU pod">▶</button>
				)}
				{lifecycleConfigured && (podState === 'running' || podState === 'warm') && onStop && (
					<button className="secondary" type="button" onClick={onStop} title="Stop GPU pod">■</button>
				)}
			</div>
		</div>
	);
}

/** @deprecated Use LlmConnectionBadge */
export const RunPodStatusBadge = LlmConnectionBadge;
