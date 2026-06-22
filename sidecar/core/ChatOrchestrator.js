import { randomUUID } from 'crypto';
import { LLMRouter } from './LLMRouter.js';
import { isFileReviewTask } from './FileReview.js';

/** @typedef {'chat' | 'plan' | 'edit'} ChatIntent */

const PLANNER_PROMPT = `You are a software task planner. Break the user's task into at most 8 ordered, actionable steps.
Return ONLY valid JSON (no markdown):
{
  "steps": [
    { "id": "step-1", "description": "clear actionable step", "dependsOn": [] },
    { "id": "step-2", "description": "...", "dependsOn": ["step-1"] }
  ]
}`;

const CHAT_SYSTEM = `You are NeuroCode — a friendly expert coding assistant inside VS Code (similar to Cursor or Copilot Chat).

You help developers understand their codebase, review work, and decide what to do next.

Rules:
- Answer in clear, well-structured markdown using ONLY the project context provided below
- If README, package.json, or source files are in the context, summarize what the project does, its stack, and key areas
- Reference specific files from the context when relevant
- Give honest, practical feedback on code quality, UX, and architecture
- Do NOT dump entire file contents unless the user explicitly asks to see code
- Do NOT rewrite or "fix" files when the user only asked to check or review — explain issues instead
- Do NOT ask the user to paste code — the workspace context is already attached
- If context is truly empty, tell them to run **NeuroCode: Index Project** from the Command Palette
- Keep explanations concise but thorough
- Always end with a "## Suggested next steps" section containing 2–4 short, actionable bullets
- If the user might want implementation, tell them to say **"implement …"** or **"go for it"** to write code directly into the project`;

/**
 * Classifies user message intent for routing.
 * @param {string} message
 * @returns {ChatIntent}
 */
export function classifyIntent(message) {
	const m = message.toLowerCase().trim();

	if (isFileReviewTask(message)) {
		return 'chat';
	}

	if (
		/^finish\b/.test(m) ||
		/\b(finish|complete)\s+(?:the\s+)?(?:file\s+)?[`"']?[\w./-]+\.(?:ts|tsx|js|jsx|py)\b/.test(m)
	) {
		return 'edit';
	}

	// Explicit implementation requests (Cursor-style "do it")
	if (
		/\b(go for|implement|build it|code it|apply it|do it now|make it|ship it|write the code|add the code)\b/.test(m) ||
		/\b(number|#|item|option|feature)\s*\d+\b/.test(m) ||
		/^go for\b/.test(m) ||
		/^implement\b/.test(m) ||
		/^build\b/.test(m) ||
		/^continue\b/.test(m)
	) {
		return 'edit';
	}

	const isQuestion =
		/\b(what|why|how|explain|describe|tell me|can you check|can you read|review|analyze|analyse|understand|look at|thoughts on|feedback on|read this)\b/.test(m) ||
		m.endsWith('?');

	if (
		/\b(plan|roadmap|break down|step.by.step|multi.?step|migrate|rebuild|outline)\b/.test(m) ||
		/^how should i\b/.test(m) ||
		/^what should i do\b/.test(m)
	) {
		return 'plan';
	}

	if (
		!isQuestion &&
		/\b(add|implement|fix|refactor|change|update|create|remove|delete|modify|write|rename|move|build|make the)\b/.test(m)
	) {
		return 'edit';
	}

	return 'chat';
}

/**
 * @param {'chat' | 'plan' | 'edit'} intent
 * @returns {number}
 */
export function getMaxTokensForIntent(intent) {
	if (intent === 'edit') {
		return Math.min(4000, Math.max(2000, LLMRouter.getTokenBudget() - 500));
	}
	if (intent === 'chat') {
		return 2500;
	}
	return 1500;
}

/**
 * @param {Array<{role: string, content: string}>} history
 * @param {number} maxTurns
 * @returns {Array<{role: string, content: string}>}
 */
export function trimHistory(history, maxTurns = 8) {
	if (!Array.isArray(history)) {
		return [];
	}
	return history.slice(-maxTurns * 2);
}

/**
 * @param {string} task
 * @param {Array<{id: string, description: string}>} steps
 * @param {string} planId
 * @returns {string}
 */
export function formatPlanMarkdown(task, steps, planId) {
	const lines = [
		`Here's a step-by-step plan for **${task}**:`,
		'',
		...steps.map((s, i) => `${i + 1}. **${s.description}**`),
		'',
		'### Suggested next steps',
		'- Click **Run step 1** below to implement the first step',
		'- Ask me to adjust the plan or explain any step',
		'- Say **implement …** for a direct code change without planning',
	];
	return lines.join('\n');
}

/**
 * @param {import('./services.js').services} services
 * @param {string} task
 * @param {Array} shards
 * @param {string} projectPath
 * @returns {Promise<{ planId: string, steps: Array<{id: string, description: string, dependsOn: string[], status: string}> }>}
 */
export async function createPlan(services, task, shards, projectPath) {
	const adapter = await LLMRouter.getAdapter();
	const contextBlock = services.shardManager.formatContextBlock(shards);

	const response = await adapter.chat(
		[
			{ role: 'system', content: PLANNER_PROMPT },
			{
				role: 'user',
				content: `Code context:\n${contextBlock || '(no files indexed yet)'}\n\nTask: ${task}`,
			},
		],
		{ temperature: 0.3, max_tokens: 1500 },
	);

	const cleaned = response.replace(/```json\n?|\n?```/g, '').trim();
	const parsed = JSON.parse(cleaned);
	const steps = (parsed.steps ?? []).slice(0, 8).map((s, i) => ({
		id: s.id ?? `step-${i + 1}`,
		description: s.description,
		dependsOn: s.dependsOn ?? [],
		status: 'pending',
	}));

	const planId = randomUUID();
	services.db.prepare(
		'INSERT INTO plans (id, task, created_at, status) VALUES (?, ?, ?, ?)',
	).run(planId, task, Date.now(), 'pending');

	const insertStep = services.db.prepare(`
		INSERT INTO plan_steps (id, plan_id, description, depends_on, status, step_order)
		VALUES (?, ?, ?, ?, 'pending', ?)
	`);

	steps.forEach((step, i) => {
		insertStep.run(step.id, planId, step.description, JSON.stringify(step.dependsOn), i);
	});

	return { planId, steps };
}

/**
 * @param {string} response
 * @returns {string | undefined}
 */
export function extractFirstCodeBlock(response) {
	const match = response.match(/```[\w]*\n([\s\S]*?)```/);
	return match?.[1]?.trim();
}

/**
 * @param {import('./services.js').services} services
 * @param {object} params
 * @param {string} params.task
 * @param {string | undefined} params.activeFile
 * @param {string} params.projectPath
 * @param {Array<{role: string, content: string}>} [params.history]
 * @param {ChatIntent} [params.forceIntent]
 * @returns {Promise<object>}
 */
export async function runOrchestratedChat(services, params) {
	const { task, activeFile, projectPath, history = [], forceIntent } = params;
	const startTime = Date.now();

	if (services.runpodManager) {
		try {
			await services.runpodManager.ensureReady();
		} catch (err) {
			console.warn('[ChatOrchestrator] RunPod not ready:', err.message);
		}
	}

	const intent = forceIntent ?? classifyIntent(task);
	const adapter = await LLMRouter.getAdapter();
	const provider = LLMRouter.getActiveProvider();
	const modelInfo = await adapter.getModelInfo();

	const assembleResult = await services.shardManager.assembleContext(
		task,
		activeFile,
		projectPath,
		services.memoryGraph,
		services.crossRepoIndexer,
	);
	const { shards, totalTokens, budget, indexed, fileCount } = assembleResult;

	let response = '';
	let planId;
	let steps;

	if (intent === 'plan') {
		const plan = await createPlan(services, task, shards, projectPath);
		planId = plan.planId;
		steps = plan.steps;
		response = formatPlanMarkdown(task, steps, planId);
	} else {
		const messages = services.shardManager.buildMessagesForIntent(intent, task, shards, history);
		const temp = intent === 'chat' ? 0.5 : 0.1;
		const maxTokens = getMaxTokensForIntent(intent);
		response = await adapter.chat(messages, { temperature: temp, max_tokens: maxTokens });
	}

	if (services.runpodManager) {
		services.runpodManager.resetIdleTimer();
	}

	if (provider === 'vllm' && services.runpodManager?.currentSessionId) {
		services.db.prepare(
			'UPDATE runpod_sessions SET llm_calls = llm_calls + 1 WHERE id = ?',
		).run(services.runpodManager.currentSessionId);
	}

	const attentionMap = services.shardManager.buildAttentionMap(shards, response);
	const latencyMs = Date.now() - startTime;

	services.genomeCollector?.record({
		shardCount: shards.length,
		totalTokens,
		shardReasons: shards.map((s) => s.reason),
		accepted: false,
		latencyMs,
		provider,
		modelClass: modelInfo.name,
	});

	return {
		response,
		intent,
		diff: intent === 'edit' ? extractFirstCodeBlock(response) : undefined,
		planId,
		steps,
		shardsUsed: shards.map((s) => ({
			file: s.relativeFile,
			reason: s.reason,
			tokenCount: s.tokenCount,
		})),
		attentionMap,
		tokensUsed: totalTokens,
		budget,
		modelUsed: modelInfo.name,
		provider,
		latencyMs,
		indexed,
		fileCount,
	};
}

/**
 * Streams orchestrated chat over SSE writer callback.
 * @param {import('./services.js').services} services
 * @param {object} params
 * @param {(event: object) => void} write
 */
export async function streamOrchestratedChat(services, params, write) {
	const { task, activeFile, projectPath, history = [], forceIntent } = params;

	try {
		const intent = forceIntent ?? classifyIntent(task);
		write({ type: 'intent', intent });

		if (services.runpodManager) {
			try {
				await services.runpodManager.ensureReady();
			} catch (err) {
				console.warn('[ChatOrchestrator] RunPod not ready:', err.message);
			}
		}

		const assembleResult = await services.shardManager.assembleContext(
			task,
			activeFile,
			projectPath,
			services.memoryGraph,
			services.crossRepoIndexer,
		);
		const { shards, totalTokens, budget, indexed, fileCount } = assembleResult;

		const adapter = await LLMRouter.getAdapter();
		const provider = LLMRouter.getActiveProvider();
		const modelInfo = await adapter.getModelInfo();
		const startTime = Date.now();

		let response = '';
		let planId;
		let steps;

		if (intent === 'plan') {
			const plan = await createPlan(services, task, shards, projectPath);
			planId = plan.planId;
			steps = plan.steps;
			response = formatPlanMarkdown(task, steps, planId);
			write({ type: 'token', content: response });
		} else {
			const messages = services.shardManager.buildMessagesForIntent(intent, task, shards, history);
			const temp = intent === 'chat' ? 0.5 : 0.1;
			const maxTokens = getMaxTokensForIntent(intent);

			for await (const token of adapter.stream(messages, { temperature: temp, max_tokens: maxTokens })) {
				response += token;
				write({ type: 'token', content: token });
			}
		}

		if (services.runpodManager) {
			services.runpodManager.resetIdleTimer();
		}

		if (provider === 'vllm' && services.runpodManager?.currentSessionId) {
			services.db.prepare(
				'UPDATE runpod_sessions SET llm_calls = llm_calls + 1 WHERE id = ?',
			).run(services.runpodManager.currentSessionId);
		}

		const attentionMap = services.shardManager.buildAttentionMap(shards, response);
		const latencyMs = Date.now() - startTime;

		write({
			type: 'done',
			data: {
				response,
				intent,
				diff: intent === 'edit' ? extractFirstCodeBlock(response) : undefined,
				planId,
				steps,
				shardsUsed: shards.map((s) => ({
					file: s.relativeFile,
					reason: s.reason,
					tokenCount: s.tokenCount,
				})),
				attentionMap,
				tokensUsed: totalTokens,
				budget,
				modelUsed: modelInfo.name,
				provider,
				latencyMs,
				indexed,
				fileCount,
			},
		});
	} catch (err) {
		write({
			type: 'error',
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

export { CHAT_SYSTEM };
