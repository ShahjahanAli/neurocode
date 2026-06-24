import { LLMRouter } from './LLMRouter.js';
import { resolveModelId } from './ModelSelector.js';
import { recordAnalyticsEvent } from './AnalyticsCollector.js';
import { executeAgentTool, AGENT_TOOL_NAMES, isIncompleteWriteContent } from './AgentTools.js';
import { sanitizeForJson } from '../utils/safeJson.js';

const AGENT_SYSTEM = `You are NeuroCode Agent — an autonomous coding assistant inside VS Code (like Cursor Agent).

You solve tasks by calling tools, observing results, and continuing until done.

## Tools (call ONE per turn)

Respond with a single fenced block:

\`\`\`neurocode-tool
{"tool":"<name>","args":{...}}
\`\`\`

Available tools:
- **read_file** — args: { "path": "relative/path.ts", "max_chars": 6000 }
- **search_code** — args: { "query": "auth middleware", "limit": 6 }
- **search_replace** — args: { "path": "relative/path.ts", "old_text": "exact snippet", "new_text": "replacement" }
  - Prefer for small fixes (one import line, a few lines). Low token cost.
- **write_file** — args: { "path": "relative/path.ts", "content": "full file contents" }
  - Only when most of the file changes. Output COMPLETE file content.
- **reply** — args: { "message": "final markdown answer to the user" }
  - Use when the task is done or you only need to explain (no more file changes).

## Rules
- Start by reading 1–2 relevant files — do not load the whole project
- One tool call per turn; wait for the tool result before the next call
- When the task is to FIX an error: use **search_replace** for line-level fixes; use **write_file** only for large rewrites
- For import/export mismatches: read the file, then **search_replace** the import line only
- End with **reply** when finished — summarize what you changed
- Keep reply concise; list files created/updated
- Max ${AGENT_TOOL_NAMES.length} tools available: ${AGENT_TOOL_NAMES.join(', ')}`;

/**
 * @param {string} response
 * @returns {{ tool: string, args: Record<string, unknown> } | null}
 */
export function parseToolCall(response) {
	/** @type {Array<{ raw: string, fenced: boolean }>} */
	const candidates = [];

	const fencedClosed = response.match(/```neurocode-tool\s*\n([\s\S]*?)```/i)
		?? response.match(/```json\s*\n([\s\S]*?)```/i);
	if (fencedClosed?.[1]) {
		candidates.push({ raw: fencedClosed[1].trim(), fenced: true });
	}

	const fencedOpen = response.match(/```neurocode-tool\s*\n([\s\S]+)$/i);
	if (fencedOpen?.[1] && !fencedClosed) {
		candidates.push({
			raw: fencedOpen[1].trim().replace(/```\s*$/i, '').trim(),
			fenced: false,
		});
	}

	const inlineRe = /\{\s*"tool"\s*:\s*"(read_file|search_code|reply)"[\s\S]*?\}/g;
	let inlineMatch;
	while ((inlineMatch = inlineRe.exec(response)) !== null) {
		candidates.push({ raw: inlineMatch[0], fenced: true });
	}

	for (const { raw, fenced } of candidates) {
		try {
			const parsed = JSON.parse(raw);
			if (!parsed?.tool || !AGENT_TOOL_NAMES.includes(parsed.tool)) {
				continue;
			}
			if ((parsed.tool === 'write_file' || parsed.tool === 'search_replace') && !fenced) {
				continue;
			}
			return { tool: parsed.tool, args: parsed.args ?? {} };
		} catch {
			// try next
		}
	}

	return null;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isToolArtifact(text) {
	const trimmed = String(text ?? '').trim();
	if (!trimmed) {
		return false;
	}
	if (/```neurocode-tool/i.test(trimmed)) {
		return true;
	}
	return /^\s*\{\s*"tool"\s*:\s*"(?:read_file|search_code|write_file|search_replace|reply)"/.test(trimmed);
}

const AGENT_FILE_CACHE_PREVIEW = 1200;
const AGENT_MAX_CACHED_FILES = 3;
const AGENT_MAX_STEP_LOG = 8;

/**
 * @typedef {object} AgentSessionState
 * @property {string} task
 * @property {string[]} steps
 * @property {Map<string, { preview: string, chars: number, corrupted?: boolean }>} files
 * @property {string} nudge
 */

/**
 * @param {string} task
 * @returns {AgentSessionState}
 */
function createAgentSession(task) {
	return { task, steps: [], files: new Map(), nudge: '' };
}

/**
 * @param {AgentSessionState} session
 * @param {string} path
 * @param {string} content
 * @param {boolean} [corrupted]
 */
function recordFileInSession(session, path, content, corrupted = false) {
	const rel = path.replace(/\\/g, '/').replace(/^\.\//, '');
	session.files.delete(rel);
	session.files.set(rel, {
		preview: String(content).slice(0, AGENT_FILE_CACHE_PREVIEW),
		chars: String(content).length,
		corrupted,
	});
	while (session.files.size > AGENT_MAX_CACHED_FILES) {
		const oldest = session.files.keys().next().value;
		if (oldest) {
			session.files.delete(oldest);
		}
	}
}

/**
 * @param {AgentSessionState} session
 * @param {string} line
 */
function recordSessionStep(session, line) {
	session.steps.push(line);
	while (session.steps.length > AGENT_MAX_STEP_LOG) {
		session.steps.shift();
	}
}

/**
 * Rebuilds a bounded prompt each agent step — O(budget) not O(steps × file_size).
 * @param {AgentSessionState} session
 * @returns {Array<{role: string, content: string}>}
 */
function rebuildAgentMessages(session) {
	const parts = [`Task: ${session.task}`];

	if (session.steps.length > 0) {
		parts.push('', 'Session log:', ...session.steps.map((s) => `- ${s}`));
	}

	if (session.files.size > 0) {
		parts.push('', 'Cached file previews (re-call read_file if you need lines not shown):');
		for (const [path, meta] of session.files) {
			const flag = meta.corrupted ? ' ⚠️ CORRUPTED' : '';
			parts.push(
				`\n### ${path}${flag} (${meta.chars} chars)\n\`\`\`\n${meta.preview}\n\`\`\``,
			);
		}
	}

	if (session.nudge) {
		parts.push('', session.nudge);
	} else {
		parts.push('', 'Call your next tool (search_replace for small fixes), or reply when done.');
	}

	return [
		{ role: 'system', content: AGENT_SYSTEM },
		{ role: 'user', content: parts.join('\n') },
	];
}

/**
 * Short tool feedback for the next rebuilt prompt (not appended to growing history).
 * @param {string} tool
 * @param {{ args?: Record<string, unknown> }} toolCall
 * @param {Record<string, unknown>} result
 * @returns {string}
 */
function formatToolNudge(tool, toolCall, result) {
	const path = String(result.path ?? toolCall.args?.path ?? '?');

	if (tool === 'read_file' && result.success) {
		if (result.corrupted) {
			return `⚠️ \`${path}\` is corrupted (tool JSON, not source). Restore valid code with write_file, then reply.`;
		}
		return `read_file \`${path}\` OK — preview updated above. Prefer search_replace for one-line fixes.`;
	}
	if (tool === 'write_file' || tool === 'search_replace') {
		if (result.success && result.staged) {
			return `${tool} staged for \`${path}\`. Continue or reply when done.`;
		}
		return `${tool} failed for \`${path}\`: ${result.error ?? 'unknown error'}. Try search_replace with exact old_text.`;
	}
	if (tool === 'search_code' && result.success) {
		const hits = Array.isArray(result.hits) ? result.hits : [];
		const lines = hits.slice(0, 4).map((h) => `- \`${h.file}\` (${h.source})`).join('\n');
		return `search_code found ${hits.length} hit(s):\n${lines || '(none)'}\n\nread_file the best match next.`;
	}
	return `Tool ${tool} completed. Continue or reply.`;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isInternalAgentEcho(text) {
	const t = String(text ?? '').trim();
	return /^\[Called\s+\w+:/.test(t)
		|| /^⟪\w+/.test(t)
		|| /^\(read_file:|^\(write_file:|^\(search_replace:/.test(t);
}

/**
 * @param {string} content
 * @returns {boolean}
 */
function isCorruptedSource(content) {
	return /^\s*\{\s*"tool"\s*:\s*"(?:write_file|read_file)/.test(String(content ?? '').trim());
}

/**
 * @param {Array<{ tool: string, args?: Record<string, unknown>, result?: Record<string, unknown> }>} toolLog
 * @param {Array<{ path: string }>} pendingWrites
 * @returns {string}
 */
function buildAgentSummary(toolLog, pendingWrites) {
	const lines = [];
	for (const entry of toolLog) {
		const path = entry.args?.path ? String(entry.args.path) : '';
		if (entry.tool === 'read_file') {
			const corrupt = entry.result?.corrupted ? ' ⚠️ corrupted' : '';
			lines.push(`- Read \`${path || '?'}\`${corrupt}`);
		} else if (entry.tool === 'write_file' || entry.tool === 'search_replace') {
			const ok = entry.result?.success ? '' : ' _(failed)_';
			lines.push(`- ${entry.tool} \`${path}\`${ok}`);
		} else if (entry.tool === 'reply') {
			lines.push('- Replied');
		}
	}
	if (pendingWrites.length > 0) {
		lines.push('', '**Staged changes:**', ...pendingWrites.map((w) => `- \`${w.path}\``));
	}
	if (lines.length === 0) {
		return 'Agent stopped before completing the task. Paste the error again or say **continue**.';
	}
	return `**Agent progress:**\n${lines.join('\n')}\n\n_Did not finish — say **continue** to resume fixing._`;
}

/**
 * @param {string} response
 * @returns {boolean}
 */
function isTruncatedToolResponse(response) {
	const text = String(response ?? '');
	if (/```neurocode-tool/i.test(text) && !/```neurocode-tool[\s\S]*?```/i.test(text)) {
		return true;
	}
	return false;
}

/**
 * @param {string} text
 * @returns {string}
 */
function cleanDisplayReply(text) {
	return String(text ?? '')
		.replace(/```neurocode-tool[\s\S]*?```/gi, '')
		.replace(/```json\s*\n\s*\{\s*"tool"[\s\S]*?```/gi, '')
		.trim();
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
 * @param {AgentSessionState} session
 * @param {(event: object) => void} write
 * @returns {Promise<Array<{ path: string, result: Record<string, unknown> }>>}
 */
async function seedAgentFiles(seedPaths, toolCtx, session, write) {
	const seeded = [];
	for (const rel of seedPaths.slice(0, 4)) {
		write({ type: 'status', content: `_Reading \`${rel}\`…` });
		write({ type: 'tool_start', tool: 'read_file', args: { path: rel } });
		const result = await executeAgentTool('read_file', { path: rel, max_chars: 5000 }, toolCtx);
		write({ type: 'tool_result', tool: 'read_file', result: summarizeToolResult(result) });
		if (result.success) {
			const corrupt = isCorruptedSource(result.content);
			recordFileInSession(session, rel, String(result.content ?? ''), corrupt);
			recordSessionStep(session, `read \`${rel}\` (${String(result.content ?? '').length} chars)${corrupt ? ' [corrupted]' : ''}`);
			seeded.push({ path: rel, result });
		}
	}
	return seeded;
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
		let displayReply = '';

		const toolCtx = {
			projectPath,
			db: services.db,
			vectorStore: services.vectorStore,
		};

		const session = createAgentSession(task);

		const seeded = seedPaths.length > 0
			? await seedAgentFiles(seedPaths, toolCtx, session, write)
			: [];
		const seedShards = seeded.map((s) => ({
			relativeFile: s.path,
			reason: 'error location',
			tokenCount: Math.ceil(String(s.result.content ?? '').length / 4),
		}));

		const agentMaxTokens = LLMRouter.getAgentOutputTokens();

		for (let step = 0; step < maxSteps; step++) {
			write({ type: 'step', step: step + 1, maxSteps });

			const messages = rebuildAgentMessages(session);
			session.nudge = '';

			let response = '';
			for await (const token of adapter.stream(messages, {
				temperature: 0.1,
				max_tokens: agentMaxTokens,
			})) {
				response += token;
			}

			if (isTruncatedToolResponse(response)) {
				session.nudge = 'Your last response was cut off (output token limit). Use search_replace for small edits, then reply.';
				continue;
			}

			const toolCall = parseToolCall(response);

			if (!toolCall) {
				if (isToolArtifact(response) || isInternalAgentEcho(response)) {
					session.nudge = isInternalAgentEcho(response)
						? 'Do not echo session labels. Call the next tool, then reply when done.'
						: 'Respond with exactly one ```neurocode-tool``` block containing valid JSON for a single tool call.';
					continue;
				}
				finalReply = response.trim();
				displayReply = finalReply;
				break;
			}

			if (toolCall.tool === 'reply') {
				finalReply = String(toolCall.args.message ?? response).trim();
				displayReply = cleanDisplayReply(finalReply);
				toolLog.push({ tool: 'reply', args: toolCall.args });
				recordSessionStep(session, 'reply');
				break;
			}

			if (
				toolCall.tool === 'write_file'
				&& isIncompleteWriteContent(String(toolCall.args.content ?? ''), String(toolCall.args.path ?? ''))
			) {
				session.nudge = 'write_file content is incomplete. Use search_replace with old_text/new_text for the minimal fix.';
				recordSessionStep(session, `write_file \`${toolCall.args.path}\` rejected (truncated)`);
				continue;
			}

			write({ type: 'tool_start', tool: toolCall.tool, args: toolCall.args });

			if ((toolCall.tool === 'write_file' || toolCall.tool === 'search_replace') && !allowWrites) {
				session.nudge = 'File writes are not allowed. Use read_file/search_code, then reply.';
				continue;
			}

			const result = await executeAgentTool(toolCall.tool, toolCall.args, toolCtx);
			if (toolCall.tool === 'read_file' && result.success && isCorruptedSource(result.content)) {
				result.corrupted = true;
			}
			const summary = summarizeToolResult(result);

			write({ type: 'tool_result', tool: toolCall.tool, result: sanitizeForJson(summary) });
			toolLog.push({ tool: toolCall.tool, args: toolCall.args, result: summary });

			const pathLabel = toolCall.args?.path ? String(toolCall.args.path) : '';

			if (toolCall.tool === 'read_file' && result.success && pathLabel) {
				recordFileInSession(
					session,
					pathLabel,
					String(result.content ?? ''),
					Boolean(result.corrupted),
				);
				recordSessionStep(
					session,
					`read \`${pathLabel}\` (${String(result.content ?? '').length} chars)${result.corrupted ? ' [corrupted]' : ''}`,
				);
			} else if (toolCall.tool === 'search_code') {
				const hitCount = Array.isArray(result.hits) ? result.hits.length : 0;
				recordSessionStep(session, `search_code "${String(toolCall.args?.query ?? '')}" (${hitCount} hits)`);
			} else if ((toolCall.tool === 'write_file' || toolCall.tool === 'search_replace') && pathLabel) {
				recordSessionStep(
					session,
					`${toolCall.tool} \`${pathLabel}\`${result.success ? '' : ' failed'}`,
				);
			}

			if (toolCall.tool === 'read_file' && pathLabel) {
				write({
					type: 'status',
					content: result.corrupted
						? `_Read \`${pathLabel}\` — ⚠️ file is corrupted, needs restore_`
						: `_Read \`${pathLabel}\` (${String(result.content ?? '').length} chars)_`,
				});
			} else if ((toolCall.tool === 'write_file' || toolCall.tool === 'search_replace') && pathLabel) {
				write({
					type: 'status',
					content: result.success
						? `_Staged \`${pathLabel}\`_`
						: `_Failed to edit \`${pathLabel}\`_`,
				});
			}

			if (
				(toolCall.tool === 'write_file' || toolCall.tool === 'search_replace')
				&& result.success
				&& result.staged
				&& allowWrites
			) {
				pendingWrites.push({
					path: String(result.path),
					content: String(result.content),
				});
			}

			session.nudge = formatToolNudge(toolCall.tool, toolCall, result);
		}

		if (!finalReply && pendingWrites.length > 0) {
			finalReply = `Agent completed ${pendingWrites.length} file change(s):\n${pendingWrites.map((w) => `- \`${w.path}\``).join('\n')}`;
			displayReply = finalReply;
		} else if (!finalReply) {
			finalReply = buildAgentSummary(toolLog, pendingWrites);
			displayReply = finalReply;
		}

		if (!displayReply) {
			displayReply = cleanDisplayReply(finalReply) || finalReply;
		}

		write({ type: 'stream_set', text: displayReply });

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
				response: displayReply,
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
