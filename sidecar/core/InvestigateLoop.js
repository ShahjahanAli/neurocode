import { LLMRouter } from './LLMRouter.js';
import { resolveModelId } from './ModelSelector.js';
import { trimHistory } from './ChatOrchestrator.js';
import { recordAnalyticsEvent } from './AnalyticsCollector.js';
import { executeAgentTool } from './AgentTools.js';
import { parseToolCall } from './AgentToolLoop.js';

const INVESTIGATE_TOOLS = ['read_file', 'search_code', 'reply'];

const INVESTIGATE_SYSTEM = `You are NeuroCode Ask — a read-only coding investigator (like Cursor Ask).

You debug and explain by reading the codebase. You do NOT write or modify files in this mode.

## Tools (call ONE per turn)

\`\`\`neurocode-tool
{"tool":"<name>","args":{...}}
\`\`\`

Available tools:
- **read_file** — args: { "path": "relative/path.ts", "max_chars": 14000 }
  - Read .env, lib/*.ts, config files, routes, etc.
- **search_code** — args: { "query": "OPENAI_MODEL", "limit": 6 }
- **reply** — args: { "message": "final markdown answer" }
  - Use when you have enough evidence. Explain root cause and what to change.
  - Do NOT output full file rewrites — describe fixes or offer to implement if the user wants.

## Rules
- Start by reading files relevant to the question (.env, config, the file mentioned in the error)
- Never call write_file — it is not available
- One tool per turn; end with **reply**
- For "why is payload X" questions: read env + LLM client code, cite exact lines
- If prior fixes failed, say what you found and propose a different approach`;

/**
 * @param {Record<string, unknown>} result
 * @returns {Record<string, unknown>}
 */
function summarizeToolResult(result) {
	if (!result || typeof result !== 'object') {
		return { success: false };
	}
	if (typeof result.content === 'string' && result.content.length > 2000) {
		return { ...result, content: `${result.content.slice(0, 2000)}… [truncated]` };
	}
	return result;
}

/**
 * @param {string} task
 * @param {Array} shards
 * @param {Array<{role: string, content: string}>} history
 * @returns {Array<{role: string, content: string}>}
 */
function buildInvestigateMessages(task, shards, history) {
	const contextBlock = shards.length
		? shards.map((s) => `// ${s.relativeFile} (${s.reason})\n${s.content}`).join('\n\n')
		: '(no files pre-loaded — use read_file or search_code)';

	const messages = [{ role: 'system', content: INVESTIGATE_SYSTEM }];

	for (const turn of trimHistory(history, 6)) {
		if (turn.role === 'user' || turn.role === 'assistant') {
			messages.push({ role: turn.role, content: turn.content });
		}
	}

	messages.push({
		role: 'user',
		content: `Project context (preview):\n${contextBlock}\n\nUser question: ${task}\n\nInvestigate — read files first, then reply. Do not write code to disk.`,
	});

	return messages;
}

/**
 * Read-only tool loop for Ask / investigate routing (Cursor-style).
 * @param {import('./services.js').services} services
 * @param {object} params
 * @param {(event: object) => void} write
 */
export async function streamInvestigateLoop(services, params, write) {
	const {
		task,
		activeFile,
		projectPath,
		history = [],
		attachments = [],
		modelSelection = 'auto',
		selectedModel,
		chatMode = 'auto',
	} = params;

	const maxSteps = parseInt(process.env.NEUROCODE_INVESTIGATE_MAX_STEPS || '8', 10);

	try {
		const assembleResult = await services.shardManager.assembleContext(
			task,
			activeFile,
			projectPath,
			services.memoryGraph,
			services.crossRepoIndexer,
			attachments,
		);
		const { shards, totalTokens, budget, indexed, fileCount } = assembleResult;

		const adapter = await LLMRouter.getAdapter();
		const models = await LLMRouter.listModels();
		const cfg = LLMRouter._readEnvConfig();
		const resolvedModel = resolveModelId(models, {
			modelSelection,
			selectedModel,
			task,
			chatMode,
			intent: 'chat',
			defaultModel: cfg.model,
		});
		LLMRouter.applyModel(adapter, resolvedModel);

		write({
			type: 'intent',
			intent: 'chat',
			agentic: false,
			investigate: true,
			readOnly: true,
			mode: 'investigate-loop',
			model: resolvedModel,
		});

		const provider = LLMRouter.getActiveProvider();
		const modelInfo = await adapter.getModelInfo();
		const startTime = Date.now();

		const messages = buildInvestigateMessages(task, shards, history);
		const toolLog = [];
		let finalReply = '';
		let streamedText = '';

		const toolCtx = {
			projectPath,
			db: services.db,
			vectorStore: services.vectorStore,
		};

		for (let step = 0; step < maxSteps; step++) {
			write({ type: 'step', step: step + 1, maxSteps });

			let response = '';
			for await (const token of adapter.stream(messages, {
				temperature: 0.3,
				max_tokens: 2500,
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

			if (toolCall.tool === 'write_file') {
				messages.push({ role: 'assistant', content: response });
				messages.push({
					role: 'user',
					content: 'write_file is not allowed in investigate mode. Use read_file/search_code, then reply with your findings.',
				});
				continue;
			}

			if (!INVESTIGATE_TOOLS.includes(toolCall.tool)) {
				finalReply = response.trim();
				break;
			}

			if (toolCall.tool === 'reply') {
				finalReply = String(toolCall.args.message ?? response).trim();
				toolLog.push({ tool: 'reply', args: toolCall.args });
				break;
			}

			write({ type: 'tool_start', tool: toolCall.tool, args: toolCall.args });

			const result = await executeAgentTool(toolCall.tool, toolCall.args, toolCtx);
			const summary = summarizeToolResult(result);

			write({ type: 'tool_result', tool: toolCall.tool, result: summary });
			toolLog.push({ tool: toolCall.tool, args: toolCall.args, result: summary });

			messages.push({ role: 'assistant', content: response });
			messages.push({
				role: 'user',
				content: `Tool result for ${toolCall.tool}:\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n\nContinue investigating or reply with your answer.`,
			});
		}

		if (!finalReply) {
			finalReply = streamedText.trim() || 'Investigation finished without a final reply.';
		}

		const latencyMs = Date.now() - startTime;

		recordAnalyticsEvent(services, {
			eventType: 'chat',
			intent: 'chat',
			chatMode,
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
				intent: 'chat',
				agentic: false,
				investigate: true,
				readOnly: true,
				allowWrites: false,
				mode: 'investigate-loop',
				toolLog,
				pendingWrites: [],
				shardsUsed: shards.map((s) => ({
					file: s.relativeFile,
					reason: s.reason,
					tokenCount: s.tokenCount,
				})),
				tokensUsed: totalTokens,
				budget,
				modelUsed: modelInfo.name,
				resolvedModel,
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
