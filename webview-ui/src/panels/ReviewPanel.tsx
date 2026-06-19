import { useVsCodeApi } from '../hooks/useVSCodeApi';
import { useState } from 'react';

const AGENT_COLORS: Record<string, string> = {
	architect: 'agent-architect',
	security: 'agent-security',
	performance: 'agent-performance',
	test: 'agent-test',
};

export function ReviewPanel() {
	const vscode = useVsCodeApi();
	const [results, setResults] = useState<Array<{ agentType: string; severity: string; findings: Array<{ line: number; message: string; suggestion: string }> }>>([]);
	const [running, setRunning] = useState(false);
	const [provider, setProvider] = useState('');

	const start = () => {
		setRunning(true);
		vscode.postMessage({ type: 'startReview' });
		const handler = (e: MessageEvent) => {
			if (e.data.type === 'reviewResults') {
				setResults(e.data.data?.results ?? []);
				setProvider(e.data.data?.provider ?? '');
				setRunning(false);
			}
		};
		window.addEventListener('message', handler);
	};

	return (
		<div className="panel">
			<h3 style={{ margin: 0 }}>Code Review</h3>
			{provider && <span className="badge">Running on {provider === 'vllm' ? 'Qwen3 · RunPod L4' : 'Ollama'}</span>}
			<button onClick={start} disabled={running}>{running ? 'Reviewing...' : 'Start Review (Ctrl+Shift+R)'}</button>
			{results.map((r, i) => (
				<div key={i} className={`agent-card ${AGENT_COLORS[r.agentType] ?? ''}`}>
					<strong>{r.agentType}</strong> · {r.severity}
					{r.findings?.map((f, j) => (
						<div key={j} style={{ fontSize: '0.85em', marginTop: 4 }}>
							L{f.line}: {f.message}
						</div>
					))}
				</div>
			))}
		</div>
	);
}
