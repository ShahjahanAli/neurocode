import { LLMRouter } from './LLMRouter.js';
import { resolveModelId } from './ModelSelector.js';
import { trimHistory } from './ChatOrchestrator.js';
import { recordAnalyticsEvent } from './AnalyticsCollector.js';
import { executeAgentTool } from './AgentTools.js';
import { parseToolCall } from './AgentToolLoop.js';
import { sanitizeForJson, safeJsonPreview } from '../utils/safeJson.js';

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
- If prior fixes failed, say what you found and propose a different approach
- Output ONLY the fenced tool block during tool turns — no prose before or after the fence`;

/**
 * Removes leaked tool-call fences from display text.
 * @param {string} text
 * @returns {string}
 */
function stripToolArtifacts(text) {
	return text
		.replace(/```neurocode-tool[\s\S]*?```/gi, '')
		.replace(/^\s*reply\s*$/gim, '')
		.trim();
}

/**
 * @param {string} tool
 * @param {Record<string, unknown>} args
 * @param {number} step
 * @param {number} maxSteps
 * @returns {string}
 */
function formatProgressLine(tool, args, step, maxSteps) {
	const prefix = `_Investigating (${step}/${maxSteps})_`;
	if (tool === 'read_file') {
		return `${prefix} — reading \`${args.path ?? 'file'}\`…`;
	}
	if (tool === 'search_code') {
		return `${prefix} — searching for \`${args.query ?? '…'}\`…`;
	}
	return `${prefix}…`;
}

/**
 * @param {string} task
 * @returns {string[]}
 */
function suggestPrefetchPaths(task) {
	const paths = [];
	const lower = task.toLowerCase();
	if (/\b(\.env|env file|environment variable|from env)\b/i.test(lower)) {
		paths.push('.env');
	}
	if (/\b(payload|llm|model|gpt-4o|default|getServerDefaults|resolveChatConfig)\b/i.test(lower)) {
		paths.push('lib/llm.ts', 'app/api/chat/route.ts');
	}
	if (/\b(test message|chatinterface|frontend|send button|onClick|input field)\b/i.test(lower)) {
		paths.push('components/chat/ChatInterface.tsx', 'app/page.tsx');
	}
	if (/\b(error|import|export|page\.tsx|ChatInterface|Element type|still not solved|not solving)\b/i.test(lower)) {
		paths.push('app/page.tsx', 'components/chat/ChatInterface.tsx');
	}
	return [...new Set(paths)];
}

/**
 * @param {string} task
 * @param {object} toolCtx
 * @param {(event: object) => void} write
 * @returns {Promise<Array<{ path: string, result: Record<string, unknown> }>>}
 */
async function prefetchInvestigateFiles(task, toolCtx, write) {
	const prefetched = [];
	for (const relPath of suggestPrefetchPaths(task)) {
		write({ type: 'status', content: `_Investigating_ — reading \`${relPath}\`…` });
		const result = await executeAgentTool('read_file', { path: relPath, max_chars: 14_000 }, toolCtx);
		if (result.success) {
			prefetched.push({ path: relPath, result });
		}
	}
	return prefetched;
}

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
 * @param {Array<{ path: string, result: Record<string, unknown> }>} [prefetched]
 * @returns {Array<{role: string, content: string}>}
 */
function buildInvestigateMessages(task, shards, history, prefetched = []) {
	const contextBlock = shards.length
		? shards.map((s) => `// ${s.relativeFile} (${s.reason})\n${s.content}`).join('\n\n')
		: '(no files pre-loaded — use read_file or search_code)';

	const prefetchBlock = prefetched.length
		? `\n\nPre-fetched files:\n${prefetched.map((p) => `### ${p.path}\n\`\`\`\n${p.result.content ?? ''}\n\`\`\``).join('\n\n')}`
		: '';

	const messages = [{ role: 'system', content: INVESTIGATE_SYSTEM }];

	for (const turn of trimHistory(history, 6)) {
		if (turn.role === 'user' || turn.role === 'assistant') {
			messages.push({ role: turn.role, content: turn.content });
		}
	}

	messages.push({
		role: 'user',
		content: `Project context (preview):\n${contextBlock}${prefetchBlock}\n\nUser question: ${task}\n\nInvestigate — read files first, then reply with **reply** tool. Do not write code to disk.`,
	});

	return messages;
}

/**
 * @param {import('../adapters/OpenAICompatibleAdapter.js').OpenAICompatibleAdapter | import('../adapters/OllamaAdapter.js').OllamaAdapter} adapter
 * @param {Array<{role: string, content: string}>} messages
 * @param {Array} toolLog
 * @returns {Promise<string>}
 */
async function synthesizeInvestigateReply(adapter, messages, toolLog) {
	if (toolLog.length === 0) {
		return 'Investigation finished without reading any files. Try rephrasing or attach the relevant file.';
	}

	messages.push({
		role: 'user',
		content: `You used ${toolLog.length} tool(s) but did not call reply. Summarize findings for the user in markdown:
- Cite exact env values and code lines you read
- Explain why the payload shows the wrong model
- Suggest what to change (describe only — do not output full file rewrites)
Do NOT output tool blocks.`,
	});

	return adapter.chat(messages, { temperature: 0.3, max_tokens: 2500 });
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

		const toolCtx = {
			projectPath,
			db: services.db,
			vectorStore: services.vectorStore,
		};

		const prefetched = await prefetchInvestigateFiles(task, toolCtx, write);
		const toolLog = prefetched.map((p) => ({
			tool: 'read_file',
			args: { path: p.path },
			result: summarizeToolResult(p.result),
			prefetch: true,
		}));

		const messages = buildInvestigateMessages(task, shards, history, prefetched);
		let finalReply = '';
		let malformedRetries = 0;

		for (let step = 0; step < maxSteps; step++) {
			write({ type: 'step', step: step + 1, maxSteps });

			let response = '';
			for await (const token of adapter.stream(messages, {
				temperature: 0.3,
				max_tokens: 2500,
			})) {
				response += token;
			}

			const toolCall = parseToolCall(response);

			if (!toolCall) {
				const looksMalformed = /neurocode-tool|"tool"\s*:/i.test(response);
				if (looksMalformed && malformedRetries < 2) {
					malformedRetries += 1;
					messages.push({ role: 'assistant', content: response });
					messages.push({
						role: 'user',
						content: 'Malformed tool JSON. Respond with ONLY this format (no extra text):\n```neurocode-tool\n{"tool":"read_file","args":{"path":".env"}}\n```',
					});
					continue;
				}

				finalReply = stripToolArtifacts(response.trim());
				if (finalReply) {
					write({ type: 'stream_set', text: finalReply });
				}
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
				write({ type: 'stream_set', text: finalReply });
				break;
			}

			if (toolCall.tool === 'reply') {
				finalReply = stripToolArtifacts(String(toolCall.args.message ?? response).trim());
				toolLog.push({ tool: 'reply', args: toolCall.args });
				write({ type: 'stream_set', text: finalReply });
				break;
			}

			const progress = formatProgressLine(toolCall.tool, toolCall.args, step + 1, maxSteps);
			write({ type: 'status', content: progress });
			write({ type: 'tool_start', tool: toolCall.tool, args: toolCall.args });

			const result = await executeAgentTool(toolCall.tool, toolCall.args, toolCtx);
			const summary = summarizeToolResult(result);

			write({ type: 'tool_result', tool: toolCall.tool, result: sanitizeForJson(summary) });
			toolLog.push({
				tool: toolCall.tool,
				args: toolCall.args,
				result: sanitizeForJson(summary),
			});

			messages.push({ role: 'assistant', content: response });
			messages.push({
				role: 'user',
				content: `Tool result for ${toolCall.tool}:\n\`\`\`json\n${safeJsonPreview(result)}\n\`\`\`\n\nContinue investigating or call reply with your answer.`,
			});
		}

		if (!finalReply) {
			write({ type: 'status', content: '_Summarizing findings…_' });
			finalReply = stripToolArtifacts((await synthesizeInvestigateReply(adapter, messages, toolLog)).trim());
			write({ type: 'stream_set', text: finalReply });
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
				toolLog: sanitizeForJson(toolLog),
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
