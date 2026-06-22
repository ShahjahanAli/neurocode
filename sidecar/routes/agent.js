import { Router } from 'express';
import { randomUUID } from 'crypto';
import { LLMRouter } from '../core/LLMRouter.js';
import { services } from '../core/services.js';
import { runOrchestratedChat, streamOrchestratedChat } from '../core/ChatOrchestrator.js';
import { streamAgentToolLoop } from '../core/AgentToolLoop.js';
import { recordAnalyticsEvent } from '../core/AnalyticsCollector.js';

const router = Router();

const PLANNER_PROMPT = `You are a software task planner. Break the user's task into at most 8 ordered steps.
Return ONLY valid JSON (no markdown):
{
  "steps": [
    { "id": "step-1", "description": "clear actionable step", "dependsOn": [] },
    { "id": "step-2", "description": "...", "dependsOn": ["step-1"] }
  ]
}`;

/**
 * @param {string} response
 * @returns {string | undefined}
 */
function extractFirstCodeBlock(response) {
	const match = response.match(/```[\w]*\n([\s\S]*?)```/);
	return match?.[1]?.trim();
}

router.post('/ask', async (req, res) => {
	try {
		const { task, activeFile, projectPath, warmup } = req.body ?? {};

		if (warmup) {
			const adapter = await LLMRouter.getAdapter();
			await adapter.chat([{ role: 'user', content: 'ready' }], { max_tokens: 5 });
			return res.json({ success: true, data: { warmup: true } });
		}

		if (!task || !projectPath) {
			return res.status(400).json({ success: false, error: 'task and projectPath required' });
		}

		if (services.runpodManager) {
			try {
				await services.runpodManager.ensureReady();
			} catch (err) {
				console.warn('[agent/ask] RunPod not ready:', err.message);
			}
		}

		const startTime = Date.now();
		const adapter = await LLMRouter.getAdapter();
		const provider = LLMRouter.getActiveProvider();
		const modelInfo = await adapter.getModelInfo();

		const { shards, totalTokens, budget } = await services.shardManager.assembleContext(
			task,
			activeFile,
			projectPath,
			services.memoryGraph,
			services.crossRepoIndexer,
		);

		const messages = services.shardManager.buildPrompt(task, shards);
		const response = await adapter.chat(messages, { temperature: 0.1, max_tokens: 1500 });

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

		recordAnalyticsEvent(services, {
			eventType: 'ask',
			intent: 'edit',
			provider,
			modelUsed: modelInfo.name,
			tokensContext: totalTokens,
			responseText: response,
			latencyMs,
			shardCount: shards.length,
		});

		res.json({
			success: true,
			data: {
				response,
				diff: extractFirstCodeBlock(response),
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
			},
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

router.post('/chat', async (req, res) => {
	try {
		const { task, activeFile, projectPath, history, forceIntent, chatMode, fixOnCheck } = req.body ?? {};
		if (!task || !projectPath) {
			return res.status(400).json({ success: false, error: 'task and projectPath required' });
		}

		const data = await runOrchestratedChat(services, {
			task,
			activeFile,
			projectPath,
			history,
			forceIntent,
			chatMode,
			fixOnCheck,
		});

		res.json({ success: true, data });
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

router.post('/chat/stream', async (req, res) => {
	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');
	res.flushHeaders();

	const { task, activeFile, projectPath, history, forceIntent, chatMode, fixOnCheck } = req.body ?? {};
	if (!task || !projectPath) {
		res.write(`data: ${JSON.stringify({ type: 'error', message: 'task and projectPath required' })}\n\n`);
		res.write('data: [DONE]\n\n');
		return res.end();
	}

	await streamOrchestratedChat(
		services,
		{ task, activeFile, projectPath, history, forceIntent, chatMode, fixOnCheck },
		(event) => {
			res.write(`data: ${JSON.stringify(event)}\n\n`);
		},
	);

	res.write('data: [DONE]\n\n');
	res.end();
});

router.post('/loop/stream', async (req, res) => {
	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');
	res.flushHeaders();

	const {
		task,
		activeFile,
		projectPath,
		history,
		maxSteps,
	} = req.body ?? {};

	if (!task || !projectPath) {
		res.write(`data: ${JSON.stringify({ type: 'error', message: 'task and projectPath required' })}\n\n`);
		res.write('data: [DONE]\n\n');
		return res.end();
	}

	await streamAgentToolLoop(
		services,
		{ task, activeFile, projectPath, history, maxSteps },
		(event) => {
			res.write(`data: ${JSON.stringify(event)}\n\n`);
		},
	);

	res.write('data: [DONE]\n\n');
	res.end();
});

router.post('/plan', async (req, res) => {
	try {
		const { task, projectPath } = req.body ?? {};
		if (!task || !projectPath) {
			return res.status(400).json({ success: false, error: 'task and projectPath required' });
		}

		if (services.runpodManager) {
			try {
				await services.runpodManager.ensureReady();
			} catch {
				// fallback
			}
		}

		const files = services.db.prepare(
			'SELECT relative_path, token_count FROM files ORDER BY token_count DESC LIMIT 50',
		).all();

		const adapter = await LLMRouter.getAdapter();
		const fileList = files.map((f) => f.relative_path).join('\n');
		const response = await adapter.chat(
			[
				{ role: 'system', content: PLANNER_PROMPT },
				{ role: 'user', content: `Project files:\n${fileList}\n\nTask: ${task}` },
			],
			{ temperature: 0.3, max_tokens: 1500 },
		);

		if (services.runpodManager) {
			services.runpodManager.resetIdleTimer();
		}

		const cleaned = response.replace(/```json\n?|\n?```/g, '').trim();
		const parsed = JSON.parse(cleaned);
		const steps = (parsed.steps ?? []).slice(0, 8);

		const planId = randomUUID();
		services.db.prepare(
			'INSERT INTO plans (id, task, created_at, status) VALUES (?, ?, ?, ?)',
		).run(planId, task, Date.now(), 'pending');

		const insertStep = services.db.prepare(`
			INSERT INTO plan_steps (id, plan_id, description, depends_on, status, step_order)
			VALUES (?, ?, ?, ?, 'pending', ?)
		`);

		steps.forEach((step, i) => {
			insertStep.run(
				step.id ?? `step-${i + 1}`,
				planId,
				step.description,
				JSON.stringify(step.dependsOn ?? []),
				i,
			);
		});

		res.json({
			success: true,
			data: {
				planId,
				steps: steps.map((s) => ({
					id: s.id,
					description: s.description,
					dependsOn: s.dependsOn ?? [],
					status: 'pending',
				})),
			},
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

router.post('/plan/:planId/execute', async (req, res) => {
	try {
		const { planId } = req.params;
		const { projectPath, activeFile } = req.body ?? {};

		const steps = services.db.prepare(
			'SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY step_order',
		).all(planId);

		const doneIds = new Set(
			steps.filter((s) => s.status === 'done').map((s) => s.id),
		);

		const next = steps.find((s) => {
			if (s.status !== 'pending') {
				return false;
			}
			const deps = JSON.parse(s.depends_on || '[]');
			return deps.every((d) => doneIds.has(d));
		});

		if (!next) {
			return res.json({
				success: true,
				data: { stepId: null, status: 'complete', diff: null, shardsUsed: [] },
			});
		}

		if (services.runpodManager) {
			try {
				await services.runpodManager.ensureReady();
			} catch {
				// fallback
			}
		}

		services.db.prepare('UPDATE plan_steps SET status = ? WHERE id = ?').run('running', next.id);

		const priorOutputs = steps
			.filter((s) => s.status === 'done' && s.output)
			.map((s) => `Step ${s.id}: ${s.output}`)
			.join('\n');

		const task = `${next.description}\n\nPrior outputs:\n${priorOutputs}`;
		const { shards, totalTokens } = await services.shardManager.assembleContext(
			task,
			activeFile,
			projectPath,
			services.memoryGraph,
			services.crossRepoIndexer,
		);

		const adapter = await LLMRouter.getAdapter();
		const messages = services.shardManager.buildMessagesForIntent('edit', task, shards, []);
		let response;
		try {
			response = await adapter.chat(messages, {
				temperature: 0.1,
				max_tokens: Math.min(4000, Math.max(2000, LLMRouter.getTokenBudget() - 500)),
			});
		} catch (err) {
			services.db.prepare(
				'UPDATE plan_steps SET status = ?, error = ? WHERE id = ?',
			).run('failed', err.message, next.id);
			throw err;
		}

		if (services.runpodManager) {
			services.runpodManager.resetIdleTimer();
		}

		services.db.prepare(
			'UPDATE plan_steps SET status = ?, output = ? WHERE id = ?',
		).run('done', response, next.id);

		res.json({
			success: true,
			data: {
				stepId: next.id,
				status: 'done',
				response,
				diff: extractFirstCodeBlock(response),
				shardsUsed: shards.map((s) => ({
					file: s.relativeFile,
					reason: s.reason,
					tokenCount: s.tokenCount,
				})),
				tokensUsed: totalTokens,
				provider: LLMRouter.getActiveProvider(),
			},
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

export default router;
