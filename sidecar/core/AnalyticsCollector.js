import { randomUUID } from 'crypto';
import { encode } from 'gpt-tokenizer';

/**
 * Records LLM usage analytics and developer feedback (stored locally in SQLite).
 */
export class AnalyticsCollector {
	/**
	 * @param {import('node:sqlite').DatabaseSync | null} db - Project database.
	 */
	constructor(db) {
		this.db = db;
	}

	/**
	 * @param {string | undefined} text
	 * @returns {number}
	 */
	_countTokens(text) {
		if (!text) {
			return 0;
		}
		try {
			return encode(text).length;
		} catch {
			return Math.ceil(text.length / 4);
		}
	}

	/**
	 * Records one LLM interaction for analytics dashboards.
	 * @param {object} event
	 * @param {string} event.eventType - chat | plan | edit | agent | ask | review | debug
	 * @param {string} [event.intent]
	 * @param {string} [event.chatMode]
	 * @param {string} [event.provider]
	 * @param {string} [event.modelUsed]
	 * @param {number} [event.tokensContext]
	 * @param {number} [event.tokensOutput]
	 * @param {string} [event.responseText] - Used to estimate output tokens when tokensOutput omitted.
	 * @param {number} [event.latencyMs]
	 * @param {number} [event.shardCount]
	 * @param {number} [event.toolSteps]
	 * @param {boolean} [event.success]
	 * @param {string} [event.error]
	 * @param {import('../core/services.js').services} [services] - Optional services for RunPod session counters.
	 */
	recordEvent(event, services = null) {
		if (!this.db) {
			return null;
		}

		const tokensOutput = event.tokensOutput ?? this._countTokens(event.responseText);
		const id = randomUUID();
		const now = Date.now();

		this.db.prepare(`
			INSERT INTO analytics_events (
				id, event_type, intent, chat_mode, provider, model_used,
				tokens_context, tokens_output, latency_ms, shard_count, tool_steps,
				success, error, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			id,
			event.eventType ?? 'chat',
			event.intent ?? null,
			event.chatMode ?? null,
			event.provider ?? null,
			event.modelUsed ?? null,
			event.tokensContext ?? 0,
			tokensOutput,
			event.latencyMs ?? 0,
			event.shardCount ?? 0,
			event.toolSteps ?? 0,
			event.success === false ? 0 : 1,
			event.error ?? null,
			now,
		);

		if (services?.runpodManager?.currentSessionId) {
			services.db.prepare(`
				UPDATE runpod_sessions
				SET llm_calls = llm_calls + 1,
				    tokens_generated = tokens_generated + ?
				WHERE id = ?
			`).run(tokensOutput, services.runpodManager.currentSessionId);
		}

		return id;
	}

	/**
	 * Stores thumbs-up / thumbs-down developer feedback (Cursor-style).
	 * @param {object} feedback
	 * @returns {string | null} Feedback row id.
	 */
	recordFeedback(feedback) {
		if (!this.db) {
			return null;
		}

		const id = randomUUID();
		const now = Date.now();

		this.db.prepare(`
			INSERT INTO developer_feedback (
				id, rating, comment, message_id, task_preview, response_preview,
				intent, provider, model_used, tokens_used, latency_ms, diagnostics, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			id,
			feedback.rating,
			feedback.comment ?? null,
			feedback.messageId ?? null,
			feedback.taskPreview?.slice(0, 500) ?? null,
			feedback.responsePreview?.slice(0, 2000) ?? null,
			feedback.intent ?? null,
			feedback.provider ?? null,
			feedback.modelUsed ?? null,
			feedback.tokensUsed ?? 0,
			feedback.latencyMs ?? 0,
			feedback.diagnostics ? JSON.stringify(feedback.diagnostics) : null,
			now,
		);

		return id;
	}

	/**
	 * @param {number} [sinceMs] - Epoch ms lower bound; defaults to session start (24h).
	 * @returns {object}
	 */
	getSummary(sinceMs = Date.now() - 86_400_000) {
		if (!this.db) {
			return this._emptySummary();
		}

		const totals = this.db.prepare(`
			SELECT
				COUNT(*) as total_calls,
				COALESCE(SUM(tokens_context), 0) as tokens_context,
				COALESCE(SUM(tokens_output), 0) as tokens_output,
				COALESCE(SUM(latency_ms), 0) as total_latency_ms,
				COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
				COALESCE(SUM(shard_count), 0) as total_shards,
				SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_calls
			FROM analytics_events
			WHERE created_at >= ?
		`).get(sinceMs);

		const byIntent = this.db.prepare(`
			SELECT intent, COUNT(*) as calls,
				COALESCE(SUM(tokens_context), 0) as tokens_context,
				COALESCE(SUM(tokens_output), 0) as tokens_output,
				COALESCE(SUM(latency_ms), 0) as latency_ms
			FROM analytics_events
			WHERE created_at >= ? AND intent IS NOT NULL
			GROUP BY intent
		`).all(sinceMs);

		const byProvider = this.db.prepare(`
			SELECT provider, COUNT(*) as calls,
				COALESCE(SUM(tokens_output), 0) as tokens_output
			FROM analytics_events
			WHERE created_at >= ? AND provider IS NOT NULL
			GROUP BY provider
		`).all(sinceMs);

		const feedback = this.db.prepare(`
			SELECT rating, COUNT(*) as count
			FROM developer_feedback
			WHERE created_at >= ?
			GROUP BY rating
		`).all(sinceMs);

		const feedbackPositive = feedback.find((r) => r.rating === 'positive')?.count ?? 0;
		const feedbackNegative = feedback.find((r) => r.rating === 'negative')?.count ?? 0;

		const allTime = this.db.prepare(`
			SELECT COUNT(*) as total_calls,
				COALESCE(SUM(tokens_output), 0) as tokens_output
			FROM analytics_events
		`).get();

		return {
			periodHours: Math.round((Date.now() - sinceMs) / 3_600_000),
			sinceMs,
			totalCalls: totals.total_calls ?? 0,
			tokensContext: totals.tokens_context ?? 0,
			tokensOutput: totals.tokens_output ?? 0,
			totalTokens: (totals.tokens_context ?? 0) + (totals.tokens_output ?? 0),
			totalLatencyMs: totals.total_latency_ms ?? 0,
			avgLatencyMs: Math.round(totals.avg_latency_ms ?? 0),
			totalShards: totals.total_shards ?? 0,
			failedCalls: totals.failed_calls ?? 0,
			byIntent,
			byProvider,
			feedbackPositive,
			feedbackNegative,
			allTimeCalls: allTime.total_calls ?? 0,
			allTimeTokensOutput: allTime.tokens_output ?? 0,
		};
	}

	/**
	 * @param {number} [limit]
	 * @returns {Array<object>}
	 */
	getRecentEvents(limit = 25) {
		if (!this.db) {
			return [];
		}

		return this.db.prepare(`
			SELECT id, event_type, intent, chat_mode, provider, model_used,
				tokens_context, tokens_output, latency_ms, shard_count, tool_steps,
				success, error, created_at
			FROM analytics_events
			ORDER BY created_at DESC
			LIMIT ?
		`).all(limit);
	}

	/**
	 * @param {number} [limit]
	 * @returns {Array<object>}
	 */
	getRecentFeedback(limit = 15) {
		if (!this.db) {
			return [];
		}

		return this.db.prepare(`
			SELECT id, rating, comment, intent, provider, model_used,
				tokens_used, latency_ms, created_at
			FROM developer_feedback
			ORDER BY created_at DESC
			LIMIT ?
		`).all(limit);
	}

	/** @returns {object} */
	_emptySummary() {
		return {
			periodHours: 24,
			sinceMs: Date.now() - 86_400_000,
			totalCalls: 0,
			tokensContext: 0,
			tokensOutput: 0,
			totalTokens: 0,
			totalLatencyMs: 0,
			avgLatencyMs: 0,
			totalShards: 0,
			failedCalls: 0,
			byIntent: [],
			byProvider: [],
			feedbackPositive: 0,
			feedbackNegative: 0,
			allTimeCalls: 0,
			allTimeTokensOutput: 0,
		};
	}
}

/**
 * Convenience helper for orchestrators.
 * @param {import('../core/services.js').services} services
 * @param {object} event
 */
export function recordAnalyticsEvent(services, event) {
	if (!services.analytics) {
		return null;
	}
	return services.analytics.recordEvent(event, services);
}
