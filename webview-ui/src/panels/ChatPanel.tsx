import { ChangeReviewBar, type ChangeReviewSummary } from '../components/ChangeReviewBar';
import { ChatAttachments, MessageAttachments, type ChatAttachment } from '../components/ChatAttachments';
import { GenomeConsentBanner } from '../components/GenomeConsentBanner';
import { LlmConnectionBadge } from '../components/LlmConnectionBadge';
import { MessageFeedback } from '../components/MessageFeedback';
import { ModelPicker } from '../components/ModelPicker';
import { ShardCard } from '../components/ShardCard';
import { MessageMarkdown } from '../components/MessageMarkdown';
import { useVsCodeApi } from '../hooks/useVSCodeApi';
import { useEffect, useRef, useState } from 'react';

type ChatIntent = 'chat' | 'plan' | 'edit';
type ChatMode = 'auto' | 'explain' | 'plan' | 'implement' | 'agent';

interface Message {
	role: 'user' | 'assistant';
	text: string;
	messageId?: string;
	taskText?: string;
	tokensUsed?: number;
	latencyMs?: number;
	provider?: string;
	modelUsed?: string;
	intent?: ChatIntent;
	agentic?: boolean;
	shards?: Array<{ file: string; reason: string; tokenCount: number }>;
	planId?: string;
	steps?: Array<{ id: string; description: string; status: string }>;
	streaming?: boolean;
	filesApplied?: Array<{ file: string; action: 'created' | 'updated' }>;
	truncated?: boolean;
	sourceText?: string;
	feedbackRating?: 'positive' | 'negative';
	changeReview?: ChangeReviewSummary;
	attachments?: ChatAttachment[];
}

const QUICK_PROMPTS = [
	{ label: 'Check open file', task: 'Can you check the file I have open — what is done and what is still missing?' },
	{ label: 'Explain this file', task: 'Explain the file I have open — what does it do and how is it structured?' },
	{ label: 'What should I do next?', task: 'Based on this project, what should I work on next?' },
	{ label: 'Plan a feature', task: 'Plan how to add user authentication to this project', mode: 'plan' as ChatMode },
	{ label: 'Review for issues', task: 'Review the open file for bugs, security, and UX issues' },
];

const CHAT_MODES: Array<{ id: ChatMode; label: string; hint: string }> = [
	{ id: 'auto', label: 'Auto', hint: 'Infer intent from your message (Cursor-style)' },
	{ id: 'explain', label: 'Ask', hint: 'Explain, review, discuss — no code writes' },
	{ id: 'plan', label: 'Plan', hint: 'Break work into steps' },
	{ id: 'implement', label: 'Edit', hint: 'Write code to the project' },
	{ id: 'agent', label: 'Agent', hint: 'Plan + auto-execute steps' },
];

const INTENT_LABELS: Record<ChatIntent, string> = {
	chat: 'Explain',
	plan: 'Plan',
	edit: 'Implement',
};

export function ChatPanel({ embedded = false }: { embedded?: boolean }) {
	const vscode = useVsCodeApi();
	const [messages, setMessages] = useState<Message[]>([]);
	const [input, setInput] = useState('');
	const [loading, setLoading] = useState(false);
	const [chatMode, setChatMode] = useState<ChatMode>('auto');
	const [streamIntent, setStreamIntent] = useState<ChatIntent | null>(null);
	const [streamAgentic, setStreamAgentic] = useState(false);
	const [podState, setPodState] = useState('not-configured');
	const [llmProvider, setLlmProvider] = useState<string | null>(null);
	const [llmModel, setLlmModel] = useState<string | null>(null);
	const [lifecycleConfigured, setLifecycleConfigured] = useState(false);
	const [idleRemainingMs, setIdleRemainingMs] = useState<number | undefined>();
	const [cost, setCost] = useState<{ estimatedCostUsd?: number; sessionMinutes?: number; llmCalls?: number }>();
	const [indexing, setIndexing] = useState<string | null>(null);
	const [batchProgress, setBatchProgress] = useState<string | null>(null);
	const [genomeConsent, setGenomeConsent] = useState(true);
	const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
	const [maxAttachments, setMaxAttachments] = useState(5);
	const [modelSelection, setModelSelection] = useState<'auto' | 'manual'>('auto');
	const [selectedModel, setSelectedModel] = useState('');
	const [availableModels, setAvailableModels] = useState<Array<{ id: string; owned_by?: string }>>([]);
	const [modelsLoading, setModelsLoading] = useState(false);
	const [activeResolvedModel, setActiveResolvedModel] = useState<string | null>(null);
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
		vscode.postMessage({ type: 'requestModels' });
		setModelsLoading(true);
		const handler = (e: MessageEvent) => {
			const msg = e.data;
			if (msg.type === 'syncModelPreference') {
				setModelSelection(msg.modelSelection ?? 'auto');
				setSelectedModel(msg.selectedModel ?? '');
			}
			if (msg.type === 'modelsList') {
				setAvailableModels(msg.models ?? []);
				setModelsLoading(false);
				if (msg.error) {
					console.warn('[ChatPanel] models:', msg.error);
				}
			}
			if (msg.type === 'syncAttachments') {
				setPendingAttachments(msg.attachments ?? []);
				if (typeof msg.maxAttachments === 'number') {
					setMaxAttachments(msg.maxAttachments);
				}
			}
			if (msg.type === 'podStatus') {
				setPodState(msg.data.podState);
				setLlmProvider(msg.data.provider ?? null);
				setLlmModel(msg.data.model ?? msg.data.modelName ?? null);
				setLifecycleConfigured(Boolean(msg.data.lifecycleConfigured));
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
			if (msg.type === 'batchProgress') {
				setBatchProgress(msg.round > 0 ? (msg.message ?? `Generating part ${msg.round}…`) : null);
			}
			if (msg.type === 'streamSetText') {
				setMessages((m) => {
					const copy = [...m];
					const last = copy[copy.length - 1];
					if (last?.streaming) {
						copy[copy.length - 1] = { ...last, text: msg.text ?? '' };
					}
					return copy;
				});
			}
			if (msg.type === 'streamStart') {
				setLoading(true);
				setStreamIntent(null);
				setStreamAgentic(false);
				stickToBottomRef.current = true;
				setMessages((m) => [...m, { role: 'assistant', text: '', streaming: true }]);
			}
			if (msg.type === 'streamIntent') {
				setStreamIntent(msg.intent);
				setStreamAgentic(Boolean(msg.agentic));
				if (msg.model) {
					setActiveResolvedModel(msg.model);
				}
				setMessages((m) => {
					const copy = [...m];
					const last = copy[copy.length - 1];
					if (last?.streaming) {
						copy[copy.length - 1] = {
							...last,
							intent: msg.intent,
							agentic: msg.agentic,
						};
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
				setStreamAgentic(false);
				setBatchProgress(null);
				setMessages((m) => {
					const withoutStream = m.filter((x) => !x.streaming);
					const lastUser = [...withoutStream].reverse().find((x) => x.role === 'user');
					return [...withoutStream, {
						role: 'assistant',
						text: msg.data.response,
						messageId: msg.messageId,
						taskText: msg.taskText ?? lastUser?.text,
						tokensUsed: msg.data.tokensUsed,
						latencyMs: msg.data.latencyMs,
						provider: msg.data.provider,
						modelUsed: msg.data.modelUsed,
						intent: msg.data.intent,
						agentic: msg.data.agentic,
						shards: msg.data.shardsUsed,
						planId: msg.data.planId,
						steps: msg.data.steps,
						filesApplied: msg.data.filesApplied,
						truncated: msg.data.truncated,
						sourceText: msg.sourceText ?? msg.data.response,
						changeReview: msg.changeReview,
					}];
				});
			}
			if (msg.type === 'changeReviewUpdate' && msg.messageId) {
				setMessages((m) => m.map((x) => (
					x.messageId === msg.messageId
						? {
							...x,
							changeReview: msg.changeReview,
							filesApplied: msg.filesApplied ?? x.filesApplied,
						}
						: x
				)));
			}
			if (msg.type === 'feedbackSaved' && msg.messageId) {
				setMessages((m) => m.map((x) => (
					x.messageId === msg.messageId
						? { ...x, feedbackRating: msg.rating }
						: x
				)));
			}
			if (msg.type === 'error') {
				setLoading(false);
				setStreamIntent(null);
				setStreamAgentic(false);
				setBatchProgress(null);
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
			if (msg.type === 'analyticsRefresh') {
				vscode.postMessage({ type: 'requestAnalytics', hours: 24 });
			}
		};
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
	}, [vscode]);

	useEffect(() => {
		if (!stickToBottomRef.current) {
			return;
		}
		const behavior: ScrollBehavior = loading ? 'auto' : 'smooth';
		requestAnimationFrame(() => scrollToBottom(behavior));
	}, [messages, loading]);

	const send = (task: string, mode?: ChatMode) => {
		if (!task.trim() || loading) return;
		stickToBottomRef.current = true;
		vscode.postMessage({
			type: 'askAgent',
			task,
			chatMode: mode ?? chatMode,
			modelSelection,
			selectedModel: selectedModel || undefined,
		});
		setInput('');
	};

	const providerLabel = (p?: string, model?: string) => {
		if (p === 'ollama') return `Ollama · ${model ?? 'local'}`;
		if (p === 'gateway') return model ? `Gateway · ${model}` : 'LLM gateway';
		return model ?? 'NeuroCode';
	};

	const badgeLabel = (m: Message): string => {
		if (m.agentic || (m.streaming && streamAgentic)) return 'Agent';
		const intent = m.intent ?? streamIntent ?? 'chat';
		return INTENT_LABELS[intent];
	};

	return (
		<div className={`panel chat-panel${embedded ? ' chat-panel-embedded' : ''}`}>
			<LlmConnectionBadge
				podState={podState}
				provider={llmProvider}
				modelName={llmModel}
				lifecycleConfigured={lifecycleConfigured}
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
			{batchProgress && (
				<div className="batch-progress-banner">{batchProgress}</div>
			)}
			<div
				className="messages"
				ref={messagesContainerRef}
				onScroll={handleMessagesScroll}
			>
				{messages.length === 0 && (
					<div className="welcome-card">
						<h3>NeuroCode Chat</h3>
						<p>Talk naturally — NeuroCode figures out whether to explain, plan, or write code.</p>
						<ul className="welcome-tips">
							<li><strong>Auto</strong> — &quot;check service.ts&quot;, &quot;this looks broken&quot;, &quot;yes go ahead&quot;</li>
							<li><strong>Plan</strong> — &quot;how should we migrate auth to JWT?&quot;</li>
							<li><strong>Agent</strong> — &quot;handle the full analytics feature end to end&quot;</li>
						</ul>
						<div className="quick-prompts">
							{QUICK_PROMPTS.map((q) => (
								<button
									key={q.label}
									className="quick-prompt"
									type="button"
									onClick={() => send(q.task, q.mode)}
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
						{m.role === 'user' && m.attachments && m.attachments.length > 0 && (
							<MessageAttachments attachments={m.attachments} />
						)}
						{m.role === 'assistant' && (
							<div className="msg-meta">
								<span className="badge">{providerLabel(m.provider, m.modelUsed)}</span>
								{(m.intent || streamIntent || m.agentic || streamAgentic) && (
									<span className={`badge intent-badge intent-${m.agentic ? 'agent' : (m.intent ?? streamIntent ?? 'chat')}`}>
										{badgeLabel(m)}
									</span>
								)}
								{m.tokensUsed != null && m.tokensUsed > 0 && (
									<span className="badge metrics-badge">{m.tokensUsed} ctx tok</span>
								)}
								{m.latencyMs != null && m.latencyMs > 0 && (
									<span className="badge metrics-badge">{(m.latencyMs / 1000).toFixed(1)}s</span>
								)}
							</div>
						)}
						<div className="msg-body">
							<MessageMarkdown text={m.text} streaming={m.streaming} />
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

						{m.filesApplied && m.filesApplied.length > 0 && !m.changeReview?.files?.length && (
							<div className="applied-files">
								<strong>Written to project:</strong>
								<ul>
									{m.filesApplied.map((f) => (
										<li key={f.file}>{f.file} <span className="action-tag">{f.action}</span></li>
									))}
								</ul>
							</div>
						)}

						{m.role === 'assistant' && m.intent === 'edit' && !m.streaming && !loading && m.messageId && (
							<ChangeReviewBar
								messageId={m.messageId}
								text={m.text}
								sourceText={m.sourceText}
								shardFiles={m.shards?.map((s) => s.file)}
								changeReview={m.changeReview}
								filesApplied={m.filesApplied}
								truncated={m.truncated}
							/>
						)}

						{m.role === 'assistant' && !m.streaming && !loading && m.messageId && (
							<MessageFeedback
								messageId={m.messageId}
								taskPreview={m.taskText}
								responsePreview={m.sourceText ?? m.text}
								intent={m.intent}
								provider={m.provider}
								modelUsed={m.modelUsed}
								tokensUsed={m.tokensUsed}
								latencyMs={m.latencyMs}
								shards={m.shards}
								initialRating={m.feedbackRating}
							/>
						)}

						{m.planId && !loading && !m.agentic && (
							<div className="action-row">
								<button type="button" onClick={() => vscode.postMessage({ type: 'executePlanStep', planId: m.planId })}>
									Run step 1
								</button>
							</div>
						)}

						{m.truncated && (
							<div className="action-row">
								<button
									type="button"
									onClick={() => vscode.postMessage({
										type: 'continueGeneration',
										appliedFiles: m.filesApplied?.map((f) => f.file) ?? [],
									})}
								>
									Continue
								</button>
							</div>
						)}
					</div>
				))}
			</div>

			<div className="chat-toolbar">
				<div className="chat-toolbar-left">
					<ModelPicker
						modelSelection={modelSelection}
						selectedModel={selectedModel}
						models={availableModels}
						activeModel={activeResolvedModel ?? llmModel}
						loading={modelsLoading}
						disabled={loading}
						onChange={(selection, model) => {
							setModelSelection(selection);
							if (model) {
								setSelectedModel(model);
							}
							vscode.postMessage({ type: 'setModelSelection', modelSelection: selection, selectedModel: model ?? selectedModel });
						}}
						onRefresh={() => {
							setModelsLoading(true);
							vscode.postMessage({ type: 'requestModels' });
						}}
					/>
					<div className="mode-selector" role="tablist" aria-label="Chat mode">
						{CHAT_MODES.map((mode) => (
							<button
								key={mode.id}
								type="button"
								className={`mode-pill${chatMode === mode.id ? ' active' : ''}`}
								title={mode.hint}
								disabled={loading}
								onClick={() => setChatMode(mode.id)}
							>
								{mode.label}
							</button>
						))}
					</div>
				</div>
				<button className="secondary toolbar-btn" type="button" onClick={() => vscode.postMessage({ type: 'clearChat' })} disabled={loading || messages.length === 0}>
					Clear chat
				</button>
			</div>

			<ChatAttachments
				attachments={pendingAttachments}
				maxAttachments={maxAttachments}
				disabled={loading}
				onAttachFile={() => vscode.postMessage({ type: 'attachActiveFile' })}
				onAttachSelection={() => vscode.postMessage({ type: 'attachSelection' })}
				onPickFiles={() => vscode.postMessage({ type: 'pickAttachments' })}
				onRemove={(index) => vscode.postMessage({ type: 'removeAttachment', index })}
			/>

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
					placeholder="Ask naturally… (Enter to send)"
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
