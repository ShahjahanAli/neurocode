import { LLMRouter } from './LLMRouter.js';
import { resolveModelId } from './ModelSelector.js';
import { trimHistory } from './ChatOrchestrator.js';
import { recordAnalyticsEvent } from './AnalyticsCollector.js';
import { executeAgentTool, AGENT_TOOL_NAMES } from './AgentTools.js';
import { safeJsonPreview, sanitizeForJson } from '../utils/safeJson.js';

const AGENT_SYSTEM = `You are NeuroCode Agent — an autonomous coding assistant inside VS Code (like Cursor Agent).

You solve tasks by calling tools, observing results, and continuing until done.

## Tools (call ONE per turn)

Respond with a single fenced block:

\`\`\`neurocode-tool
{"tool":"<name>","args":{...}}
\`\`\`

Available tools:
- **read_file** — args: { "path": "relative/path.ts", "max_chars": 14000 }
- **search_code** — args: { "query": "auth middleware", "limit": 6 }
- **write_file** — args: { "path": "relative/path.ts", "content": "full file contents" }
  - Output COMPLETE file content. Match project conventions.
- **reply** — args: { "message": "final markdown answer to the user" }
  - Use when the task is done or you only need to explain (no more file changes).

## Rules
- Start by reading or searching if you lack context — do not guess file contents
- One tool call per turn; wait for the tool result before the next call
- When the task is to FIX an error: you MUST call **write_file** with the corrected file(s) — do not only tell the user what to change
- Prefer **write_file** for code changes (full files, not diffs)
- End with **reply** when finished — summarize what you changed
- Keep reply concise; list files created/updated
- Max ${AGENT_TOOL_NAMES.length} tools available: ${AGENT_TOOL_NAMES.join(', ')}`;

/**
 * @param {string} response
 * @returns {{ tool: string, args: Record<string, unknown> } | null}
 */
export function parseToolCall(response) {
	const candidates = [];

	const fencedClosed = response.match(/```neurocode-tool\s*\n([\s\S]*?)```/i)
		?? response.match(/```json\s*\n([\s\S]*?)```/i);
	if (fencedClosed?.[1]) {
		candidates.push(fencedClosed[1].trim());
	}

	const fencedOpen = response.match(/```neurocode-tool\s*\n([\s\S]+)$/i);
	if (fencedOpen?.[1]) {
		candidates.push(fencedOpen[1].trim().replace(/```\s*$/i, '').trim());
	}

	const inlineRe = /\{\s*"tool"\s*:\s*"(read_file|search_code|write_file|reply)"[\s\S]*?\}/g;
	let inlineMatch;
	while ((inlineMatch = inlineRe.exec(response)) !== null) {
		candidates.push(inlineMatch[0]);
	}

	for (const raw of candidates) {
		try {
			const parsed = JSON.parse(raw);
			if (parsed?.tool && AGENT_TOOL_NAMES.includes(parsed.tool)) {
				return { tool: parsed.tool, args: parsed.args ?? {} };
			}
		} catch {
			// try next
		}
	}

	return null;
}

/**
 * @param {Record<string, unknown>} result
 * @returns {Record<string, unknown>}
 */
function summarizeToolResult(result) {
	if (!result || typeof result !== 'object') {
		return { success: false };
	}
	if (result.staged) {
		return {
			success: result.success,
			staged: result.staged,
			path: result.path,
			bytes: String(result.content ?? '').length,
		};
	}
	if (typeof result.content === 'string' && result.content.length > 2000) {
		return { ...result, content: `${result.content.slice(0, 2000)}… [truncated]` };
	}
	return result;
}

/**
 * @param {string[]} seedPaths
 * @param {object} toolCtx
 * @param {(event: object) => void} write
 * @returns {Promise<Array<{ path: string, result: Record<string, unknown> }>>}
 */
async function seedAgentFiles(seedPaths, toolCtx, write) {
	const seeded = [];
	for (const rel of seedPaths.slice(0, 4)) {
		write({ type: 'status', content: `_Reading \`${rel}\`…` });
		write({ type: 'tool_start', tool: 'read_file', args: { path: rel } });
		const result = await executeAgentTool('read_file', { path: rel, max_chars: 14_000 }, toolCtx);
		write({ type: 'tool_result', tool: 'read_file', result: summarizeToolResult(result) });
		if (result.success) {
			seeded.push({ path: rel, result });
		}
	}
	return seeded;
}

/**
 * @param {string} task
 * @param {Array} shards
 * @param {Array<{role: string, content: string}>} history
 * @param {Array<{ path: string, result: Record<string, unknown> }>} [seeded]
 * @returns {Array<{role: string, content: string}>}
 */
function buildAgentMessages(task, shards, history, seeded = []) {
	const seedBlock = seeded.length
		? seeded.map((s) => `// ${s.path} (from error location)\n${String(s.result.content ?? '').slice(0, 12_000)}`).join('\n\n')
		: '';
	const contextBlock = seedBlock
		|| (shards.length
			? shards.map((s) => `// ${s.relativeFile} (${s.reason})\n${s.content}`).join('\n\n')
			: '(no files pre-loaded — use read_file or search_code)');

	const messages = [{ role: 'system', content: AGENT_SYSTEM }];

	for (const turn of trimHistory(history, 6)) {
		if (turn.role === 'user' || turn.role === 'assistant') {
			messages.push({ role: turn.role, content: turn.content });
		}
	}

	messages.push({
		role: 'user',
		content: `Project context (preview):\n${contextBlock}\n\nTask: ${task}\n\nCall your first tool (read_file if you need more context, write_file to fix, reply when done).`,
	});

	return messages;
}

/**
 * Streams an agentic tool loop over SSE.
 * @param {import('./services.js').services} services
 * @param {object} params
 * @param {(event: object) => void} write
 */
export async function streamAgentToolLoop(services, params, write) {
	const {
		task,
		activeFile,
		projectPath,
		history = [],
		maxSteps = 10,
		attachments = [],
		modelSelection = 'auto',
		selectedModel,
		chatMode = 'agent',
		prefetchShards = false,
		allowWrites = true,
		routingReason,
		seedPaths = [],
	} = params;

	try {
		if (services.runpodManager) {
			try {
				await services.runpodManager.ensureReady();
			} catch (err) {
				console.warn('[AgentToolLoop] RunPod not ready:', err.message);
			}
		}

		let shards = [];
		let totalTokens = 0;
		let budget = services.shardManager.MAX_TOKENS;
		let indexed = false;
		let fileCount = 0;

		if (prefetchShards) {
			const assembleResult = await services.shardManager.assembleContext(
				task,
				activeFile,
				projectPath,
				services.memoryGraph,
				services.crossRepoIndexer,
				attachments,
			);
			shards = assembleResult.shards;
			totalTokens = assembleResult.totalTokens;
			budget = assembleResult.budget;
			indexed = assembleResult.indexed;
			fileCount = assembleResult.fileCount;
		} else {
			const row = services.db.prepare('SELECT COUNT(*) AS c FROM files').get();
			fileCount = row?.c ?? 0;
			indexed = fileCount > 0;
		}

		const adapter = await LLMRouter.getAdapter();
		const models = await LLMRouter.listModels();
		const cfg = LLMRouter._readEnvConfig();
		const resolvedModel = resolveModelId(models, {
			modelSelection,
			selectedModel,
			task,
			chatMode,
			intent: 'edit',
			defaultModel: cfg.model,
		});
		LLMRouter.applyModel(adapter, resolvedModel);
		write({
			type: 'intent',
			intent: allowWrites ? 'edit' : 'chat',
			agentic: true,
			mode: 'tool-loop',
			model: resolvedModel,
			allowWrites,
			readOnly: !allowWrites,
			reason: routingReason,
		});

		const provider = LLMRouter.getActiveProvider();
		const modelInfo = await adapter.getModelInfo();
		const startTime = Date.now();

		const pendingWrites = [];
		const toolLog = [];
		let finalReply = '';
		let streamedText = '';

		const toolCtx = {
			projectPath,
			db: services.db,
			vectorStore: services.vectorStore,
		};

		const seeded = seedPaths.length > 0
			? await seedAgentFiles(seedPaths, toolCtx, write)
			: [];
		const seedShards = seeded.map((s) => ({
			relativeFile: s.path,
			reason: 'error location',
			tokenCount: Math.ceil(String(s.result.content ?? '').length / 4),
		}));

		const messages = buildAgentMessages(task, shards, history, seeded);

		for (let step = 0; step < maxSteps; step++) {
			write({ type: 'step', step: step + 1, maxSteps });

			let response = '';
			for await (const token of adapter.stream(messages, {
				temperature: 0.1,
				max_tokens: LLMRouter.getMaxOutputTokens(),
			})) {
				response += token;
				streamedText += token;
				write({ type: 'token', content: token });
			}

			const toolCall = parseToolCall(response);

			if (!toolCall) {
				finalReply = response.trim();
				break;
			}

			if (toolCall.tool === 'reply') {
				finalReply = String(toolCall.args.message ?? response).trim();
				toolLog.push({ tool: 'reply', args: toolCall.args });
				break;
			}

			write({ type: 'tool_start', tool: toolCall.tool, args: toolCall.args });

			if (toolCall.tool === 'write_file' && !allowWrites) {
				messages.push({ role: 'assistant', content: response });
				messages.push({
					role: 'user',
					content: 'write_file is not allowed for this request. Use read_file/search_code, then reply.',
				});
				continue;
			}

			const result = await executeAgentTool(toolCall.tool, toolCall.args, toolCtx);
			const summary = summarizeToolResult(result);

			write({ type: 'tool_result', tool: toolCall.tool, result: sanitizeForJson(summary) });
			toolLog.push({ tool: toolCall.tool, args: toolCall.args, result: summary });

			if (toolCall.tool === 'write_file' && result.success && result.staged && allowWrites) {
				pendingWrites.push({
					path: String(result.path),
					content: String(result.content),
				});
			}

			messages.push({ role: 'assistant', content: response });
			messages.push({
				role: 'user',
				content: `Tool result for ${toolCall.tool}:\n\`\`\`json\n${safeJsonPreview(result)}\n\`\`\`\n\nContinue with the next tool call, or reply when done.`,
			});
		}

		if (!finalReply && pendingWrites.length > 0) {
			finalReply = `Agent completed ${pendingWrites.length} file change(s):\n${pendingWrites.map((w) => `- \`${w.path}\``).join('\n')}`;
		} else if (!finalReply) {
			finalReply = streamedText.trim() || 'Agent finished without a final reply.';
		}

		if (services.runpodManager) {
			services.runpodManager.resetIdleTimer();
		}

		if (provider === 'gateway' && services.runpodManager?.currentSessionId) {
			services.db.prepare(
				'UPDATE runpod_sessions SET llm_calls = llm_calls + 1 WHERE id = ?',
			).run(services.runpodManager.currentSessionId);
		}

		const latencyMs = Date.now() - startTime;

		recordAnalyticsEvent(services, {
			eventType: 'agent',
			intent: 'edit',
			chatMode: 'agent',
			provider,
			modelUsed: modelInfo.name,
			tokensContext: totalTokens,
			responseText: finalReply,
			latencyMs,
			shardCount: shards.length,
			toolSteps: toolLog.length,
		});

		write({
			type: 'done',
			data: {
				response: finalReply,
				intent: 'edit',
				agentic: true,
				mode: 'tool-loop',
				readOnly: !allowWrites,
				allowWrites,
				routingReason,
				pendingWrites: allowWrites ? pendingWrites : [],
				toolLog: sanitizeForJson(toolLog),
				shardsUsed: (seedShards.length ? seedShards : shards).map((s) => ({
					file: s.relativeFile,
					reason: s.reason,
					tokenCount: s.tokenCount,
				})),
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
