import { useVsCodeApi } from '../hooks/useVSCodeApi';
import { useEffect, useState } from 'react';

interface AnalyticsSummary {
	periodHours: number;
	totalCalls: number;
	tokensContext: number;
	tokensOutput: number;
	totalTokens: number;
	totalLatencyMs: number;
	avgLatencyMs: number;
	totalShards: number;
	failedCalls: number;
	feedbackPositive: number;
	feedbackNegative: number;
	allTimeCalls: number;
	allTimeTokensOutput: number;
	byIntent: Array<{ intent: string; calls: number; tokens_context: number; tokens_output: number; latency_ms: number }>;
	byProvider: Array<{ provider: string; calls: number; tokens_output: number }>;
}

interface AnalyticsEvent {
	id: string;
	event_type: string;
	intent: string | null;
	chat_mode: string | null;
	provider: string | null;
	model_used: string | null;
	tokens_context: number;
	tokens_output: number;
	latency_ms: number;
	shard_count: number;
	tool_steps: number;
	success: number;
	created_at: number;
}

function formatMs(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) {
		return `${(n / 1_000_000).toFixed(1)}M`;
	}
	if (n >= 1000) {
		return `${(n / 1000).toFixed(1)}k`;
	}
	return String(n);
}

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Developer analytics dashboard — tokens, latency, calls, feedback.
 */
export function AnalyticsPanel({ embedded = false }: { embedded?: boolean }) {
	const vscode = useVsCodeApi();
	const [hours, setHours] = useState(24);
	const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
	const [events, setEvents] = useState<AnalyticsEvent[]>([]);
	const [loading, setLoading] = useState(true);

	const [error, setError] = useState<string | null>(null);

	const refresh = (): void => {
		setLoading(true);
		setError(null);
		vscode.postMessage({ type: 'requestAnalytics', hours });
	};

	useEffect(() => {
		const handler = (e: MessageEvent) => {
			if (e.data.type === 'analyticsData') {
				setSummary(e.data.summary ?? null);
				setEvents(Array.isArray(e.data.events) ? e.data.events : []);
				setError(typeof e.data.error === 'string' ? e.data.error : null);
				setLoading(false);
			}
			if (e.data.type === 'analyticsRefresh') {
				refresh();
			}
		};
		window.addEventListener('message', handler);
		refresh();
		const timer = setInterval(refresh, 30_000);
		return () => {
			window.removeEventListener('message', handler);
			clearInterval(timer);
		};
	// eslint-disable-next-line react-hooks/exhaustive-deps -- refresh when range changes
	}, [hours]);

	return (
		<div className={`panel analytics-panel${embedded ? ' panel-embedded' : ''}`}>
			<div className="analytics-header">
				<h3 style={{ margin: 0 }}>Analytics</h3>
				<div className="analytics-controls">
					<select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Time range">
						<option value={1}>Last hour</option>
						<option value={24}>Last 24h</option>
						<option value={168}>Last 7 days</option>
					</select>
					<button type="button" className="hub-btn sm secondary" onClick={refresh}>Refresh</button>
				</div>
			</div>

			{loading && !summary && !error && (
				<p style={{ color: 'var(--nc-muted)' }}>Loading analytics…</p>
			)}

			{error && (
				<div className="analytics-warn">{error}</div>
			)}

			{!loading && !summary && !error && (
				<p style={{ color: 'var(--nc-muted)', fontSize: '0.85em' }}>
					No analytics yet. Use Chat to generate usage data, then refresh.
				</p>
			)}

			{summary && (
				<>
					<div className="analytics-grid">
						<div className="analytics-stat-card">
							<span className="analytics-stat-label">LLM calls</span>
							<span className="analytics-stat-value">{summary.totalCalls}</span>
							<span className="analytics-stat-hint">{summary.allTimeCalls} all time</span>
						</div>
						<div className="analytics-stat-card">
							<span className="analytics-stat-label">Context tokens</span>
							<span className="analytics-stat-value">{formatTokens(summary.tokensContext)}</span>
							<span className="analytics-stat-hint">Shards assembled</span>
						</div>
						<div className="analytics-stat-card">
							<span className="analytics-stat-label">Output tokens</span>
							<span className="analytics-stat-value">{formatTokens(summary.tokensOutput)}</span>
							<span className="analytics-stat-hint">{formatTokens(summary.allTimeTokensOutput)} all time</span>
						</div>
						<div className="analytics-stat-card">
							<span className="analytics-stat-label">Elapsed time</span>
							<span className="analytics-stat-value">{formatMs(summary.totalLatencyMs)}</span>
							<span className="analytics-stat-hint">avg {formatMs(summary.avgLatencyMs)} / call</span>
						</div>
						<div className="analytics-stat-card">
							<span className="analytics-stat-label">Shards used</span>
							<span className="analytics-stat-value">{summary.totalShards}</span>
						</div>
						<div className="analytics-stat-card">
							<span className="analytics-stat-label">Feedback</span>
							<span className="analytics-stat-value">
								👍 {summary.feedbackPositive} · 👎 {summary.feedbackNegative}
							</span>
						</div>
					</div>

					{summary.failedCalls > 0 && (
						<div className="analytics-warn">{summary.failedCalls} failed call(s) in this period</div>
					)}

					{(summary.byIntent?.length ?? 0) > 0 && (
						<section className="analytics-section">
							<h4 className="hub-section-title">By intent</h4>
							<div className="analytics-table-wrap">
								<table className="analytics-table">
									<thead>
										<tr>
											<th>Intent</th>
											<th>Calls</th>
											<th>Context</th>
											<th>Output</th>
											<th>Time</th>
										</tr>
									</thead>
									<tbody>
										{(summary.byIntent ?? []).map((row) => (
											<tr key={row.intent}>
												<td>{row.intent}</td>
												<td>{row.calls}</td>
												<td>{formatTokens(row.tokens_context)}</td>
												<td>{formatTokens(row.tokens_output)}</td>
												<td>{formatMs(row.latency_ms)}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</section>
					)}

					{(summary.byProvider?.length ?? 0) > 0 && (
						<section className="analytics-section">
							<h4 className="hub-section-title">By provider</h4>
							<ul className="hub-activity-list">
								{(summary.byProvider ?? []).map((row) => (
									<li key={row.provider}>
										<strong>{row.provider}</strong> — {row.calls} calls, {formatTokens(row.tokens_output)} output tokens
									</li>
								))}
							</ul>
						</section>
					)}

					<section className="analytics-section">
						<h4 className="hub-section-title">Recent activity</h4>
						{events.length === 0 ? (
							<p style={{ color: 'var(--nc-muted)', fontSize: '0.85em' }}>No LLM calls yet — ask something in Chat.</p>
						) : (
							<div className="analytics-table-wrap">
								<table className="analytics-table">
									<thead>
										<tr>
											<th>Time</th>
											<th>Type</th>
											<th>Model</th>
											<th>Ctx</th>
											<th>Out</th>
											<th>Latency</th>
										</tr>
									</thead>
									<tbody>
										{events.map((ev) => (
											<tr key={ev.id} className={ev.success ? '' : 'row-fail'}>
												<td>{formatTime(ev.created_at)}</td>
												<td>{ev.intent ?? ev.event_type}{ev.tool_steps > 0 ? ` (${ev.tool_steps} tools)` : ''}</td>
												<td title={ev.model_used ?? ''}>{ev.provider ?? '—'}</td>
												<td>{formatTokens(ev.tokens_context)}</td>
												<td>{formatTokens(ev.tokens_output)}</td>
												<td>{formatMs(ev.latency_ms)}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</section>

					<p className="analytics-footnote">
						Stored locally in <code>.neurocode/neurocode.db</code>. Feedback helps tune prompts and routing — nothing is sent to the cloud unless you configure it.
					</p>
				</>
			)}
		</div>
	);
}
