import { randomUUID } from 'crypto';
import { LLMRouter } from './LLMRouter.js';

const AGENT_PROMPTS = {
	architect: `You are a software architect. Review the code for structural issues, coupling, and design patterns.
Return JSON only: { "agentType": "architect", "severity": "info|warning|error", "findings": [{ "line": number, "message": string, "suggestion": string }] }`,
	security: `You are a security specialist. Find vulnerabilities: injection, auth flaws, secrets, unsafe deps.
Return JSON only: { "agentType": "security", "severity": "info|warning|error", "findings": [{ "line": number, "message": string, "suggestion": string }] }`,
	performance: `You are a performance engineer. Find bottlenecks, N+1 queries, unnecessary allocations.
Return JSON only: { "agentType": "performance", "severity": "info|warning|error", "findings": [{ "line": number, "message": string, "suggestion": string }] }`,
	test: `You are a test engineer. Identify missing tests, edge cases, and testability issues.
Return JSON only: { "agentType": "test", "severity": "info|warning|error", "findings": [{ "line": number, "message": string, "suggestion": string }] }`,
};

/**
 * Runs specialist review agents in parallel.
 */
export class MultiAgentRunner {
	/**
	 * @param {string} contextBlock
	 * @param {string[]} agents
	 */
	static async runAll(contextBlock, agents = ['architect', 'security', 'performance', 'test']) {
		const adapter = await LLMRouter.getAdapter();
		const limited = agents.slice(0, 4);

		return Promise.all(
			limited.map((type) => MultiAgentRunner.runAgent(adapter, type, contextBlock)),
		);
	}

	/**
	 * @param {object} adapter
	 * @param {string} agentType
	 * @param {string} contextBlock
	 */
	static async runAgent(adapter, agentType, contextBlock) {
		const system = AGENT_PROMPTS[agentType] ?? AGENT_PROMPTS.architect;
		const response = await adapter.chat(
			[
				{ role: 'system', content: system },
				{ role: 'user', content: `Review this code:\n${contextBlock}` },
			],
			{ temperature: 0.5, max_tokens: 1000 },
		);

		return MultiAgentRunner.parseResult(agentType, response);
	}

	/**
	 * @param {string} agentType
	 * @param {string} response
	 */
	static parseResult(agentType, response) {
		const cleaned = response.replace(/```json\n?|\n?```/g, '').trim();
		try {
			return JSON.parse(cleaned);
		} catch {
			return {
				agentType,
				severity: 'info',
				findings: [{ line: 0, message: response.slice(0, 500), suggestion: '' }],
			};
		}
	}
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} activeFile
 * @param {object[]} results
 * @returns {string}
 */
export function storeReviewSession(db, activeFile, results) {
	const sessionId = randomUUID();
	db.prepare(
		'INSERT INTO review_sessions (id, active_file, created_at, status) VALUES (?, ?, ?, ?)',
	).run(sessionId, activeFile, Date.now(), 'done');

	const insert = db.prepare(`
		INSERT INTO review_findings (session_id, agent_type, severity, file_path, line_number, message, suggestion)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`);

	for (const r of results) {
		for (const f of r.findings ?? []) {
			insert.run(
				sessionId,
				r.agentType ?? 'unknown',
				r.severity ?? 'info',
				activeFile,
				f.line ?? 0,
				f.message ?? '',
				f.suggestion ?? '',
			);
		}
	}

	return sessionId;
}
