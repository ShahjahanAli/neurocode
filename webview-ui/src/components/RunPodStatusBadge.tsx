const STATE_CONFIG: Record<string, { color: string; icon: string; label: string }> = {
	stopped: { color: '#888', icon: '⊘', label: 'RunPod stopped' },
	starting: { color: '#FFD700', icon: '⟳', label: 'Starting RunPod L4...' },
	running: { color: '#4AFF9B', icon: '▶', label: 'RunPod L4 · Qwen3' },
	warm: { color: '#FF6B35', icon: '🔥', label: 'Qwen3 warm' },
	stopping: { color: '#FFD700', icon: '⟳', label: 'Stopping...' },
	unknown: { color: '#888', icon: '?', label: 'Unknown state' },
	'not-configured': { color: '#555', icon: '—', label: 'LLM not connected' },
	'direct-vllm': { color: '#4AFF9B', icon: '●', label: 'vLLM connected' },
};

interface Props {
	podState: keyof typeof STATE_CONFIG;
	idleRemainingMs?: number;
	onStart?: () => void;
	onStop?: () => void;
}

export function RunPodStatusBadge({ podState, idleRemainingMs, onStart, onStop }: Props) {
	const cfg = STATE_CONFIG[podState] ?? STATE_CONFIG.unknown;
	const idleMin = idleRemainingMs ? Math.ceil(idleRemainingMs / 60_000) : null;

	return (
		<div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85em' }}>
			<span style={{ color: cfg.color, fontWeight: 600 }}>
				{cfg.icon} {cfg.label}
				{podState === 'warm' && idleMin !== null && ` · idle: ${idleMin}m`}
			</span>
			{podState === 'stopped' && onStart && (
				<button className="secondary" onClick={onStart} title="Start RunPod">▶</button>
			)}
			{(podState === 'running' || podState === 'warm') && onStop && (
				<button className="secondary" onClick={onStop} title="Stop RunPod">■</button>
			)}
		</div>
	);
}
