import { randomUUID } from 'crypto';
import { LLMRouter } from './LLMRouter.js';
import { resolveModelId } from './ModelSelector.js';
import { getPrimaryReviewShard } from './FileReview.js';
import { resolveUserIntent, resolveIntentPermissions } from './IntentRouter.js';
import { streamInvestigateLoop } from './InvestigateLoop.js';
import { streamAgentToolLoop } from './AgentToolLoop.js';
import { recordAnalyticsEvent } from './AnalyticsCollector.js';

/** @typedef {'chat' | 'plan' | 'edit'} ChatIntent */
/** @typedef {'auto' | 'explain' | 'plan' | 'implement' | 'agent'} ChatMode */

/**
 * Resolves and applies the model for a chat request.
 * @param {object} params
 * @param {ChatIntent} [intent]
 */
async function bindAdapterForRequest(params, intent) {
	const models = await LLMRouter.listModels();
	const cfg = LLMRouter._readEnvConfig();
	const model = resolveModelId(models, {
		modelSelection: params.modelSelection ?? 'auto',
		selectedModel: params.selectedModel,
		task: params.task,
		chatMode: params.chatMode ?? 'auto',
		intent,
		defaultModel: cfg.model,
	});
	const adapter = await LLMRouter.getAdapter();
	LLMRouter.applyModel(adapter, model);
	const modelInfo = await adapter.getModelInfo();
	return {
		adapter,
		model,
		provider: LLMRouter.getActiveProvider(),
		modelInfo,
	};
}

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
- Do NOT rewrite or "fix" files when the user only asked to check, review, or debug — explain issues and read config/env files instead
- Do NOT claim you read a file unless it appears in the project context below — if unsure, say which file to open or ask the user to run Index Project
- Do NOT ask the user to paste code — the workspace context is already attached
- If context is truly empty, tell them to run **NeuroCode: Index Project** from the Command Palette
- Keep explanations concise but thorough
- Always end with a "## Suggested next steps" section containing 2–4 short, actionable bullets
- When the user likely wants code changes, offer to proceed — they can say **yes**, **go ahead**, or describe the fix in plain language
- If the user says thanks, got it, cool, etc. after work was done, reply briefly and warmly — do NOT start new implementation or suggest building more features unless they ask`;

/**
 * Legacy alias — delegates to resolveUserIntent.
 * @param {string} message
 * @returns {ChatIntent}
 */
export function classifyIntent(message) {
	return resolveUserIntent(message).intent;
}

/**
 * @param {'chat' | 'plan' | 'edit'} intent
 * @returns {number}
 */
export function getMaxTokensForIntent(intent) {
	const cap = LLMRouter.getMaxOutputTokens();
	if (intent === 'edit') {
		return Math.min(cap, Math.min(4000, Math.max(2000, LLMRouter.getTokenBudget() - 500)));
	}
	if (intent === 'chat') {
		return Math.min(cap, 2500);
	}
	return Math.min(cap, 1500);
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
		'- Click **Run step 1** below to implement the first step (or switch to **Agent** mode to run all steps automatically)',
		'- Ask me to adjust the plan or explain any step',
		'- Say **yes** or **go ahead** to implement without re-explaining',
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
 * Resolves intent after context is assembled (history, shards, mode).
 * @param {string} task
 * @param {ChatIntent | undefined} forceIntent
 * @param {Array} shards
 * @param {Array<{role: string, content: string}>} [history]
 * @param {{ chatMode?: ChatMode, fixOnCheck?: boolean }} [options]
 * @param {import('../adapters/OpenAICompatibleAdapter.js').OpenAICompatibleAdapter | import('../adapters/OllamaAdapter.js').OllamaAdapter | null} [adapter]
 * @returns {Promise<import('./IntentRouter.js').IntentResolution & { intent: ChatIntent }>}
 */
export async function resolveIntentWithContext(task, forceIntent, shards, history = [], options = {}, adapter = null) {
	if (forceIntent) {
		const allowWrites = forceIntent === 'edit';
		return {
			intent: forceIntent,
			effectiveTask: task,
			autoFixed: false,
			agentic: options.chatMode === 'agent',
			readOnly: !allowWrites,
			allowWrites,
			investigate: forceIntent === 'chat',
			confidence: 'high',
			reason: 'forceIntent',
		};
	}

	return resolveIntentPermissions(task, { history, shards, ...options }, adapter);
}

/**
 * @param {import('./IntentRouter.js').IntentResolution} resolved
 * @param {ChatMode} [chatMode]
 * @returns {boolean}
 */
function shouldUseInvestigateLoop(resolved, chatMode = 'auto') {
	return (
		(resolved.investigate || chatMode === 'explain') &&
		!resolved.agentic &&
		resolved.intent !== 'plan'
	);
}

/**
 * Cursor-style agent loop: read → search → write when the LLM router grants writes.
 * @param {import('./IntentRouter.js').IntentResolution} resolved
 * @param {ChatMode} [chatMode]
 * @returns {boolean}
 */
function shouldUseAgentToolLoop(resolved, chatMode = 'auto') {
	if (resolved.agentic || chatMode === 'agent') {
		return true;
	}
	if (chatMode === 'implement') {
		return true;
	}
	return resolved.intent === 'edit' && resolved.allowWrites && !resolved.investigate;
}

/**
 * @param {import('./services.js').services} services
 * @param {object} loopParams
 * @param {(event: object) => void} write
 * @returns {Promise<object>}
 */
async function runAgentToolLoopCollect(services, loopParams, write) {
	let doneData;
	await streamAgentToolLoop(services, loopParams, (event) => {
		write?.(event);
		if (event.type === 'done') {
			doneData = event.data;
		}
	});
	return doneData ?? { response: 'Agent loop failed.', intent: 'edit' };
}

/**
 * @param {import('./services.js').services} services
 * @param {object} params
 * @param {string} params.task
 * @param {string | undefined} params.activeFile
 * @param {string} params.projectPath
 * @param {Array<{role: string, content: string}>} [params.history]
 * @param {ChatIntent} [params.forceIntent]
 * @param {ChatMode} [params.chatMode]
 * @param {boolean} [params.fixOnCheck]
 * @param {Array<{path: string, kind: string, content?: string, lineStart?: number, lineEnd?: number}>} [params.attachments]
 * @returns {Promise<object>}
 */
export async function runOrchestratedChat(services, params) {
	const {
		task,
		activeFile,
		projectPath,
		history = [],
		forceIntent,
		chatMode = 'auto',
		fixOnCheck = true,
		attachments = [],
		modelSelection = 'auto',
		selectedModel,
	} = params;
	const startTime = Date.now();

	if (services.runpodManager) {
		try {
			await services.runpodManager.ensureReady();
		} catch (err) {
			console.warn('[ChatOrchestrator] RunPod not ready:', err.message);
		}
	}

	const routerAdapter = !forceIntent && chatMode === 'auto'
		? await LLMRouter.getAdapter().catch(() => null)
		: null;
	const resolved = await resolveIntentWithContext(task, forceIntent, [], history, {
		chatMode,
		fixOnCheck: false,
	}, routerAdapter);

	if (shouldUseInvestigateLoop(resolved, chatMode)) {
		let investigateData;
		await streamInvestigateLoop(services, {
			task: resolved.effectiveTask,
			activeFile,
			projectPath,
			history,
			attachments,
			modelSelection,
			selectedModel,
			chatMode,
			prefetchShards: false,
			routingReason: resolved.reason,
		}, (event) => {
			if (event.type === 'done') {
				investigateData = event.data;
			}
		});
		return investigateData ?? { response: 'Investigation failed.', intent: 'chat' };
	}

	if (shouldUseAgentToolLoop(resolved, chatMode)) {
		return runAgentToolLoopCollect(services, {
			task: resolved.effectiveTask,
			activeFile,
			projectPath,
			history,
			attachments,
			modelSelection,
			selectedModel,
			chatMode: chatMode === 'auto' ? 'implement' : chatMode,
			prefetchShards: false,
			allowWrites: resolved.allowWrites,
			routingReason: resolved.reason,
		});
	}

	const assembleResult = await services.shardManager.assembleContext(
		task,
		activeFile,
		projectPath,
		services.memoryGraph,
		services.crossRepoIndexer,
		attachments,
	);
	const { shards, totalTokens, budget, indexed, fileCount } = assembleResult;

	const effectiveIntent = resolved.intent;
	const effectiveTask = resolved.effectiveTask;
	const agentic = resolved.agentic;

	const { adapter, model, provider, modelInfo } = await bindAdapterForRequest(
		{ task, chatMode, modelSelection, selectedModel },
		effectiveIntent,
	);

	let response = '';
	let planId;
	let steps;

	if (effectiveIntent === 'plan') {
		const plan = await createPlan(services, task, shards, projectPath);
		planId = plan.planId;
		steps = plan.steps;
		response = formatPlanMarkdown(task, steps, planId);
	} else {
		const messages = services.shardManager.buildMessagesForIntent(
			effectiveIntent,
			effectiveTask,
			shards,
			history,
		);
		const temp = effectiveIntent === 'chat' ? 0.5 : 0.1;
		const maxTokens = getMaxTokensForIntent(effectiveIntent);
		response = await adapter.chat(messages, { temperature: temp, max_tokens: maxTokens });
	}

	if (resolved.autoFixed && effectiveIntent === 'edit' && resolved.allowWrites) {
		response = `**Incomplete file detected** — completing \`${getPrimaryReviewShard(shards, task)?.relativeFile ?? 'file'}\` in your project.\n\n${response}`;
	}

	if (services.runpodManager) {
		services.runpodManager.resetIdleTimer();
	}

	if (provider === 'gateway' && services.runpodManager?.currentSessionId) {
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

	recordAnalyticsEvent(services, {
		eventType: agentic ? 'agent' : effectiveIntent,
		intent: effectiveIntent,
		chatMode,
		provider,
		modelUsed: modelInfo.name,
		tokensContext: totalTokens,
		responseText: response,
		latencyMs,
		shardCount: shards.length,
	});

	return {
		response,
		intent: effectiveIntent,
		agentic,
		investigate: resolved.investigate,
		readOnly: resolved.readOnly,
		allowWrites: resolved.allowWrites,
		routingReason: resolved.reason,
		diff: effectiveIntent === 'edit' && resolved.allowWrites ? extractFirstCodeBlock(response) : undefined,
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
		resolvedModel: model,
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
	const {
		task,
		activeFile,
		projectPath,
		history = [],
		forceIntent,
		chatMode = 'auto',
		fixOnCheck = true,
		attachments = [],
		modelSelection = 'auto',
		selectedModel,
	} = params;

	try {
		if (services.runpodManager) {
			try {
				await services.runpodManager.ensureReady();
			} catch (err) {
				console.warn('[ChatOrchestrator] RunPod not ready:', err.message);
			}
		}

		const routerAdapter = !forceIntent && chatMode === 'auto'
			? await LLMRouter.getAdapter().catch(() => null)
			: null;
		const resolved = await resolveIntentWithContext(task, forceIntent, [], history, {
			chatMode,
			fixOnCheck: false,
		}, routerAdapter);

		write({
			type: 'routing',
			intent: resolved.intent,
			agentic: resolved.agentic,
			investigate: resolved.investigate,
			readOnly: resolved.readOnly,
			allowWrites: resolved.allowWrites,
			reason: resolved.reason,
		});

		if (shouldUseInvestigateLoop(resolved, chatMode)) {
			return streamInvestigateLoop(services, {
				task: resolved.effectiveTask,
				activeFile,
				projectPath,
				history,
				attachments,
				modelSelection,
				selectedModel,
				chatMode,
				prefetchShards: false,
				routingReason: resolved.reason,
			}, write);
		}

		if (shouldUseAgentToolLoop(resolved, chatMode)) {
			return streamAgentToolLoop(services, {
				task: resolved.effectiveTask,
				activeFile,
				projectPath,
				history,
				attachments,
				modelSelection,
				selectedModel,
				chatMode: chatMode === 'auto' ? 'implement' : chatMode,
				prefetchShards: false,
				allowWrites: resolved.allowWrites,
				routingReason: resolved.reason,
			}, write);
		}

		const assembleResult = await services.shardManager.assembleContext(
			task,
			activeFile,
			projectPath,
			services.memoryGraph,
			services.crossRepoIndexer,
			attachments,
		);
		const { shards, totalTokens, budget, indexed, fileCount } = assembleResult;

		const effectiveIntent = resolved.intent;
		const effectiveTask = resolved.effectiveTask;
		const agentic = resolved.agentic;

		const { adapter, model, provider, modelInfo } = await bindAdapterForRequest(
			{ task, chatMode, modelSelection, selectedModel },
			effectiveIntent,
		);

		write({
			type: 'intent',
			intent: effectiveIntent,
			agentic,
			investigate: resolved.investigate,
			readOnly: resolved.readOnly,
			model,
			reason: resolved.reason,
		});

		const startTime = Date.now();

		let response = '';
		let planId;
		let steps;

		if (effectiveIntent === 'plan') {
			const plan = await createPlan(services, task, shards, projectPath);
			planId = plan.planId;
			steps = plan.steps;
			response = formatPlanMarkdown(task, steps, planId);
			write({ type: 'token', content: response });
		} else {
			const messages = services.shardManager.buildMessagesForIntent(
				effectiveIntent,
				effectiveTask,
				shards,
				history,
			);
			const temp = effectiveIntent === 'chat' ? 0.5 : 0.1;
			const maxTokens = getMaxTokensForIntent(effectiveIntent);

			if (resolved.autoFixed && effectiveIntent === 'edit' && resolved.allowWrites) {
				const banner = `**Incomplete file detected** — completing \`${getPrimaryReviewShard(shards, task)?.relativeFile ?? 'file'}\` in your project…\n\n`;
				response = banner;
				write({ type: 'token', content: banner });
			}

			for await (const token of adapter.stream(messages, { temperature: temp, max_tokens: maxTokens })) {
				response += token;
				write({ type: 'token', content: token });
			}
		}

		if (services.runpodManager) {
			services.runpodManager.resetIdleTimer();
		}

		if (provider === 'gateway' && services.runpodManager?.currentSessionId) {
			services.db.prepare(
				'UPDATE runpod_sessions SET llm_calls = llm_calls + 1 WHERE id = ?',
			).run(services.runpodManager.currentSessionId);
		}

		const attentionMap = services.shardManager.buildAttentionMap(shards, response);
		const latencyMs = Date.now() - startTime;

		recordAnalyticsEvent(services, {
			eventType: agentic ? 'agent' : effectiveIntent,
			intent: effectiveIntent,
			chatMode,
			provider,
			modelUsed: modelInfo.name,
			tokensContext: totalTokens,
			responseText: response,
			latencyMs,
			shardCount: shards.length,
		});

		write({
			type: 'done',
			data: {
				response,
				intent: effectiveIntent,
				agentic,
				investigate: resolved.investigate,
				readOnly: resolved.readOnly,
				allowWrites: resolved.allowWrites,
				routingReason: resolved.reason,
				diff: effectiveIntent === 'edit' ? extractFirstCodeBlock(response) : undefined,
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
				resolvedModel: model,
				provider,
				latencyMs,
				indexed,
				fileCount,
			},
		});
	} catch (err) {
		recordAnalyticsEvent(services, {
			eventType: 'chat',
			chatMode,
			success: false,
			error: err instanceof Error ? err.message : String(err),
			latencyMs: 0,
		});
		write({
			type: 'error',
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

export { CHAT_SYSTEM };
