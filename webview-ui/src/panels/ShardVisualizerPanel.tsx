import { ShardCard } from '../components/ShardCard';
import { useVsCodeApi } from '../hooks/useVSCodeApi';
import { useEffect, useState } from 'react';

interface ShardData {
	shards: Array<{ file: string; reason: string; tokenCount: number }>;
	totalTokens: number;
	budget: number;
	provider: string;
	modelUsed?: string;
}

export function ShardVisualizerPanel() {
	const vscode = useVsCodeApi();
	const [data, setData] = useState<ShardData | null>(null);

	useEffect(() => {
		const handler = (e: MessageEvent) => {
			if (e.data.type === 'shards') setData(e.data.data);
		};
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
	}, []);

	const pct = data ? Math.min(100, (data.totalTokens / data.budget) * 100) : 0;
	const label = data?.provider === 'vllm'
		? 'RunPod L4 · 6K context'
		: 'Ollama · 3.5K context';

	return (
		<div className="panel">
			<h3 style={{ margin: 0 }}>Shard Visualizer</h3>
			{!data ? (
				<p style={{ color: 'var(--nc-muted)' }}>Run Ask Agent to see context here</p>
			) : (
				<>
					<div>Context Budget: {data.totalTokens} / {data.budget} tokens</div>
					<div className="badge">{label} · {data.modelUsed}</div>
					<div className="budget-bar">
						<div className={`budget-fill ${pct > 80 ? 'danger' : pct > 60 ? 'warn' : ''}`} style={{ width: `${pct}%` }} />
					</div>
					{data.shards.map((s, i) => (
						<ShardCard key={i} file={s.file} reason={s.reason} tokenCount={s.tokenCount} budget={data.budget} />
					))}
				</>
			)}
		</div>
	);
}
