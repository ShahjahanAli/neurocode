import { useEffect, useState } from 'react';

interface Memory {
	id: string;
	task_description: string;
	weight: number;
	provider?: string;
	files_edited?: string;
	created_at: number;
}

export function MemoryPanel({ embedded = false }: { embedded?: boolean }) {
	const [memories, setMemories] = useState<Memory[]>([]);

	useEffect(() => {
		const handler = (e: MessageEvent) => {
			if (e.data.type === 'memories') {
				setMemories(e.data.data?.memories ?? []);
			}
		};
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
	}, []);

	return (
		<div className={`panel${embedded ? ' panel-embedded' : ''}`}>
			<h3 style={{ margin: 0 }}>Project Memory</h3>
			{memories.length === 0 && <p style={{ color: 'var(--nc-muted)' }}>No memories yet</p>}
			{memories.map((m) => (
				<div key={m.id} className="shard-card">
					<div>{m.task_description}</div>
					<div className="shard-reason">
						weight: {m.weight?.toFixed(1)} · {m.provider === 'vllm' ? 'Qwen3 · RunPod' : 'Ollama'}
					</div>
				</div>
			))}
		</div>
	);
}
