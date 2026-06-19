import { RunPodStatusBadge } from '../components/RunPodStatusBadge';
import { GenomeConsentBanner } from '../components/GenomeConsentBanner';
import { ShardCard } from '../components/ShardCard';
import { useVsCodeApi } from '../hooks/useVSCodeApi';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';

interface Message {
	role: 'user' | 'assistant';
	text: string;
	provider?: string;
	modelUsed?: string;
	shards?: Array<{ file: string; reason: string; tokenCount: number }>;
}

export function ChatPanel() {
	const vscode = useVsCodeApi();
	const [messages, setMessages] = useState<Message[]>([]);
	const [input, setInput] = useState('');
	const [loading, setLoading] = useState(false);
	const [podState, setPodState] = useState('not-configured');
	const [idleRemainingMs, setIdleRemainingMs] = useState<number | undefined>();
	const [cost, setCost] = useState<{ estimatedCostUsd?: number; sessionMinutes?: number; llmCalls?: number }>();
	const [genomeConsent, setGenomeConsent] = useState(true);

	useEffect(() => {
		vscode.postMessage({ type: 'getGenomeConsent' });
		const handler = (e: MessageEvent) => {
			const msg = e.data;
			if (msg.type === 'podStatus') {
				setPodState(msg.data.podState);
				setIdleRemainingMs(msg.data.idleRemainingMs);
				setCost(msg.data.cost);
			}
			if (msg.type === 'streamStart') setLoading(true);
			if (msg.type === 'agentResponse') {
				setLoading(false);
				setMessages((m) => [...m, {
					role: 'assistant',
					text: msg.data.response,
					provider: msg.data.provider,
					modelUsed: msg.data.modelUsed,
					shards: msg.data.shardsUsed,
				}]);
			}
			if (msg.type === 'error') { setLoading(false); }
			if (msg.type === 'genomeConsent') setGenomeConsent(msg.accepted);
		};
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
	}, [vscode]);

	const ask = () => {
		if (!input.trim()) return;
		setMessages((m) => [...m, { role: 'user', text: input }]);
		vscode.postMessage({ type: 'askAgent', task: input });
		setInput('');
	};

	const providerLabel = (p?: string, model?: string) =>
		p === 'vllm' ? `Qwen3 · RunPod L4` : `Ollama · ${model ?? 'local'}`;

	return (
		<div className="panel">
			<RunPodStatusBadge
				podState={podState as never}
				idleRemainingMs={idleRemainingMs}
				onStart={() => vscode.postMessage({ type: 'startPod' })}
				onStop={() => vscode.postMessage({ type: 'stopPod' })}
			/>
			{(podState === 'warm' || podState === 'running') && cost && (
				<div className="badge" style={{ fontSize: '0.75em' }}>
					Session: ~${(cost.estimatedCostUsd ?? 0).toFixed(2)} · {cost.sessionMinutes ?? 0} min · {cost.llmCalls ?? 0} calls
				</div>
			)}
			{!genomeConsent && (
				<GenomeConsentBanner onAccept={() => vscode.postMessage({ type: 'genomeConsent' })} />
			)}
			<div className="messages">
				{messages.map((m, i) => (
					<div key={i} className={m.role === 'user' ? 'msg-user' : 'msg-ai'}>
						{m.role === 'assistant' && (
							<span className="badge">{providerLabel(m.provider, m.modelUsed)}</span>
						)}
						<ReactMarkdown>{m.text}</ReactMarkdown>
						{m.shards && (
							<details>
								<summary>Shards ({m.shards.length})</summary>
								{m.shards.map((s, j) => <ShardCard key={j} file={s.file} reason={s.reason} tokenCount={s.tokenCount} />)}
							</details>
						)}
						{m.role === 'assistant' && m.text.includes('```') && (
							<div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
								<button className="secondary" onClick={() => vscode.postMessage({ type: 'viewDiff', text: m.text })}>View Diff</button>
								<button onClick={() => vscode.postMessage({ type: 'acceptDiff', text: m.text })}>Accept</button>
							</div>
						)}
					</div>
				))}
				{loading && <div className="badge">Thinking...</div>}
			</div>
			<div className="input-row">
				<input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()} placeholder="Ask the agent..." />
				<button onClick={ask} disabled={loading}>Send</button>
			</div>
		</div>
	);
}
