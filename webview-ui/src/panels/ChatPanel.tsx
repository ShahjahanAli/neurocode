import { RunPodStatusBadge } from '../components/RunPodStatusBadge';
import { GenomeConsentBanner } from '../components/GenomeConsentBanner';
import { ShardCard } from '../components/ShardCard';
import { useVsCodeApi } from '../hooks/useVSCodeApi';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

type ChatIntent = 'chat' | 'plan' | 'edit';

interface Message {
	role: 'user' | 'assistant';
	text: string;
	provider?: string;
	modelUsed?: string;
	intent?: ChatIntent;
	shards?: Array<{ file: string; reason: string; tokenCount: number }>;
	planId?: string;
	steps?: Array<{ id: string; description: string; status: string }>;
	streaming?: boolean;
	filesApplied?: Array<{ file: string; action: 'created' | 'updated' }>;
	truncated?: boolean;
	sourceText?: string;
}

const QUICK_PROMPTS = [
	{ label: 'Explain this file', task: 'Explain the file I have open — what does it do and how is it structured?', intent: 'chat' as ChatIntent },
	{ label: 'What should I do next?', task: 'Based on this project, what should I work on next?', intent: 'chat' as ChatIntent },
	{ label: 'Plan a feature', task: 'Plan how to add user authentication to this project', intent: 'plan' as ChatIntent },
	{ label: 'Review for issues', task: 'Review the open file for bugs, security, and UX issues', intent: 'chat' as ChatIntent },
];

const INTENT_LABELS: Record<ChatIntent, string> = {
	chat: 'Explain',
	plan: 'Plan',
	edit: 'Implement',
};

export function ChatPanel() {
	const vscode = useVsCodeApi();
	const [messages, setMessages] = useState<Message[]>([]);
	const [input, setInput] = useState('');
	const [loading, setLoading] = useState(false);
	const [streamIntent, setStreamIntent] = useState<ChatIntent | null>(null);
	const [podState, setPodState] = useState('not-configured');
	const [idleRemainingMs, setIdleRemainingMs] = useState<number | undefined>();
	const [cost, setCost] = useState<{ estimatedCostUsd?: number; sessionMinutes?: number; llmCalls?: number }>();
	const [indexing, setIndexing] = useState<string | null>(null);
	const [genomeConsent, setGenomeConsent] = useState(true);
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const stickToBottomRef = useRef(true);

	/** @returns Whether the scroll position is near the bottom of the message list. */
	const isNearBottom = (el: HTMLElement, threshold = 48): boolean =>
		el.scrollHeight - el.scrollTop - el.clientHeight < threshold;

	/** Scrolls the message list to the bottom when the user is following the stream. */
	const scrollToBottom = (behavior: ScrollBehavior = 'auto'): void => {
		const el = messagesContainerRef.current;
		if (!el) {
			return;
		}
		if (behavior === 'auto') {
			el.scrollTop = el.scrollHeight;
		} else {
			el.scrollTo({ top: el.scrollHeight, behavior });
		}
	};

	const handleMessagesScroll = (): void => {
		const el = messagesContainerRef.current;
		if (!el) {
			return;
		}
		stickToBottomRef.current = isNearBottom(el);
	};

	useEffect(() => {
		vscode.postMessage({ type: 'webviewReady' });
		vscode.postMessage({ type: 'getGenomeConsent' });
		const handler = (e: MessageEvent) => {
			const msg = e.data;
			if (msg.type === 'podStatus') {
				setPodState(msg.data.podState);
				setIdleRemainingMs(msg.data.idleRemainingMs);
				setCost(msg.data.cost);
			}
			if (msg.type === 'restoreChat') {
				setMessages(msg.messages ?? []);
				setLoading(false);
				stickToBottomRef.current = true;
				requestAnimationFrame(() => scrollToBottom('auto'));
			}
			if (msg.type === 'appendMessage') {
				setMessages((m) => [...m, msg.message]);
			}
			if (msg.type === 'indexing') {
				setIndexing(msg.message ?? 'Indexing…');
			}
			if (msg.type === 'indexingDone') {
				setIndexing(null);
			}
			if (msg.type === 'streamStart') {
				setLoading(true);
				setStreamIntent(null);
				stickToBottomRef.current = true;
				setMessages((m) => [...m, { role: 'assistant', text: '', streaming: true }]);
			}
			if (msg.type === 'streamIntent') {
				setStreamIntent(msg.intent);
				setMessages((m) => {
					const copy = [...m];
					const last = copy[copy.length - 1];
					if (last?.streaming) {
						copy[copy.length - 1] = { ...last, intent: msg.intent };
					}
					return copy;
				});
			}
			if (msg.type === 'streamToken') {
				setMessages((m) => {
					const copy = [...m];
					const last = copy[copy.length - 1];
					if (last?.streaming) {
						copy[copy.length - 1] = { ...last, text: last.text + msg.content };
					}
					return copy;
				});
			}
			if (msg.type === 'agentResponse') {
				setLoading(false);
				setStreamIntent(null);
				setMessages((m) => {
					const withoutStream = m.filter((x) => !x.streaming);
					return [...withoutStream, {
						role: 'assistant',
						text: msg.data.response,
						provider: msg.data.provider,
						modelUsed: msg.data.modelUsed,
						intent: msg.data.intent,
						shards: msg.data.shardsUsed,
						planId: msg.data.planId,
						steps: msg.data.steps,
						filesApplied: msg.data.filesApplied,
						truncated: msg.data.truncated,
						sourceText: msg.sourceText ?? msg.data.response,
					}];
				});
			}
			if (msg.type === 'error') {
				setLoading(false);
				setStreamIntent(null);
				setMessages((m) => {
					const withoutStream = m.filter((x) => !x.streaming);
					return [...withoutStream, {
						role: 'assistant',
						text: `**Error:** ${msg.message}`,
						intent: 'chat',
					}];
				});
			}
			if (msg.type === 'chatCleared') {
				setMessages([]);
			}
			if (msg.type === 'genomeConsent') setGenomeConsent(msg.accepted);
		};
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
	}, [vscode]);

	useEffect(() => {
		if (!stickToBottomRef.current) {
			return;
		}
		// Instant scroll during streaming avoids fighting manual scroll gestures.
		const behavior: ScrollBehavior = loading ? 'auto' : 'smooth';
		requestAnimationFrame(() => scrollToBottom(behavior));
	}, [messages, loading]);

	const send = (task: string, forceIntent?: ChatIntent) => {
		if (!task.trim() || loading) return;
		stickToBottomRef.current = true;
		vscode.postMessage({ type: 'askAgent', task, forceIntent });
		setInput('');
	};

	const providerLabel = (p?: string, model?: string) => {
		if (p === 'ollama') return `Ollama · ${model ?? 'local'}`;
		if (p === 'vllm') return 'Qwen · RunPod';
		return model ?? 'NeuroCode';
	};

	return (
		<div className="panel chat-panel">
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

			{indexing && (
				<div className="indexing-banner">{indexing}</div>
			)}
			<div
				className="messages"
				ref={messagesContainerRef}
				onScroll={handleMessagesScroll}
			>
				{messages.length === 0 && (
					<div className="welcome-card">
						<h3>NeuroCode Chat</h3>
						<p>Ask questions, get plans, or request code changes — like Cursor.</p>
						<ul className="welcome-tips">
							<li><strong>Ask anything</strong> — &quot;check the landing page&quot;, &quot;what does this do?&quot;</li>
							<li><strong>Plan work</strong> — &quot;plan a JWT migration&quot;</li>
							<li><strong>Edit code</strong> — &quot;add email validation to signup&quot;</li>
						</ul>
						<div className="quick-prompts">
							{QUICK_PROMPTS.map((q) => (
								<button
									key={q.label}
									className="quick-prompt"
									type="button"
									onClick={() => send(q.task, q.intent)}
									disabled={loading}
								>
									{q.label}
								</button>
							))}
						</div>
					</div>
				)}

				{messages.map((m, i) => (
					<div key={i} className={m.role === 'user' ? 'msg-user' : 'msg-ai'}>
						{m.role === 'assistant' && (
							<div className="msg-meta">
								<span className="badge">{providerLabel(m.provider, m.modelUsed)}</span>
								{(m.intent || streamIntent) && (
									<span className={`badge intent-badge intent-${m.intent ?? streamIntent}`}>
										{INTENT_LABELS[m.intent ?? streamIntent ?? 'chat']}
									</span>
								)}
							</div>
						)}
						<div className="msg-body">
							<ReactMarkdown>{m.text || (m.streaming ? ' ' : '')}</ReactMarkdown>
							{m.streaming && <span className="typing-cursor">▋</span>}
						</div>

						{m.steps && m.steps.length > 0 && (
							<ol className="plan-steps">
								{m.steps.map((s) => (
									<li key={s.id}>{s.description}</li>
								))}
							</ol>
						)}

						{m.shards && m.shards.length > 0 && (
							<details className="shards-details">
								<summary>Context files ({m.shards.length})</summary>
								{m.shards.map((s, j) => (
									<ShardCard key={j} file={s.file} reason={s.reason} tokenCount={s.tokenCount} />
								))}
							</details>
						)}

						{m.filesApplied && m.filesApplied.length > 0 && (
							<div className="applied-files">
								<strong>Written to project:</strong>
								<ul>
									{m.filesApplied.map((f) => (
										<li key={f.file}>{f.file} <span className="action-tag">{f.action}</span></li>
									))}
								</ul>
							</div>
						)}

						{m.planId && !loading && (
							<div className="action-row">
								<button type="button" onClick={() => vscode.postMessage({ type: 'executePlanStep', planId: m.planId })}>
									Run step 1
								</button>
							</div>
						)}

						{m.role === 'assistant' && m.text.includes('```') && m.intent === 'edit' && !m.streaming && (
							<div className="action-row">
								<button className="secondary" type="button" onClick={() => vscode.postMessage({ type: 'viewDiff', text: m.text })}>
									View Diff
								</button>
								{(!m.filesApplied || m.filesApplied.length === 0) && (
									<button
										type="button"
										onClick={() => vscode.postMessage({
											type: 'acceptDiff',
											text: m.text,
											sourceText: m.sourceText,
											truncated: m.truncated,
											shardFiles: m.shards?.map((s) => s.file),
										})}
									>
										Accept
									</button>
								)}
								{m.truncated && (
									<button
										type="button"
										onClick={() => vscode.postMessage({
											type: 'continueGeneration',
											appliedFiles: m.filesApplied?.map((f) => f.file) ?? [],
										})}
									>
										Continue
									</button>
								)}
							</div>
						)}
					</div>
				))}
			</div>

			<div className="chat-toolbar">
				<button className="secondary toolbar-btn" type="button" onClick={() => vscode.postMessage({ type: 'clearChat' })} disabled={loading || messages.length === 0}>
					Clear chat
				</button>
			</div>

			<div className="input-row">
				<textarea
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							send(input);
						}
					}}
					placeholder="Ask anything… (Enter to send, Shift+Enter for new line)"
					rows={2}
					disabled={loading}
				/>
				<button type="button" onClick={() => send(input)} disabled={loading || !input.trim()}>
					{loading ? '…' : 'Send'}
				</button>
			</div>
		</div>
	);
}
