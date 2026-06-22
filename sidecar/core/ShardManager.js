import fs from 'fs';
import path from 'path';
import { encode } from 'gpt-tokenizer';
import { LLMRouter } from './LLMRouter.js';
import { EmbeddingService } from './EmbeddingService.js';
import { CHAT_SYSTEM, trimHistory } from './ChatOrchestrator.js';
import {
	buildReviewNotes,
	extractFileHintFromTask,
	isFileReviewTask,
	resolveTaskFilePath,
	REVIEW_FILE_RULES,
} from './FileReview.js';
import { walkProjectFiles } from './CodeGraph.js';

/**
 * Assembles context shards within a dynamic token budget.
 */
export class ShardManager {
	/**
	 * @param {import('node:sqlite').DatabaseSync} db
	 * @param {import('../vector/VectorStore.js').VectorStore} vectorStore
	 */
	constructor(db, vectorStore) {
		this.db = db;
		this.vectorStore = vectorStore;
	}

	get MAX_TOKENS() {
		const manual = parseInt(process.env.SHARD_MAX_TOKENS || '0', 10);
		if (manual > 0) {
			return manual;
		}
		return LLMRouter.getTokenBudget();
	}

	/**
	 * @param {string} text
	 * @returns {number}
	 */
	countTokens(text) {
		return encode(text).length;
	}

	/**
	 * @param {Array<{relativeFile: string, content: string, reason: string}>} shards
	 * @returns {string}
	 */
	formatContextBlock(shards) {
		return shards
			.map((s) => `// === ${s.relativeFile} (${s.reason}) ===\n${s.content}`)
			.join('\n\n');
	}

	/**
	 * @param {'chat' | 'plan' | 'edit'} intent
	 * @param {string} task
	 * @param {Array<{relativeFile: string, content: string, reason: string}>} shards
	 * @param {Array<{role: string, content: string}>} [history]
	 * @returns {Array<{role: string, content: string}>}
	 */
	buildMessagesForIntent(intent, task, shards, history = []) {
		if (intent === 'edit') {
			if (shards.length === 0) {
				return this.buildChatPrompt(task, shards, history);
			}
			return this.buildEditPrompt(task, shards, history);
		}

		const review = isFileReviewTask(task);
		const reviewNotes = review ? buildReviewNotes(shards, task) : '';
		return this.buildChatPrompt(task, shards, history, { review, reviewNotes });
	}

	/**
	 * @param {string} task
	 * @param {Array<{relativeFile: string, content: string, reason: string}>} shards
	 * @param {Array<{role: string, content: string}>} [history]
	 * @returns {Array<{role: string, content: string}>}
	 */
	buildChatPrompt(task, shards, history = [], options = {}) {
		const contextBlock = this.formatContextBlock(shards);
		const contextNote = contextBlock
			? `Relevant project context:\n${contextBlock}`
			: 'No source files were loaded. Tell the user to run **NeuroCode: Index Project** and open a relevant file.';

		const reviewSection = options.reviewNotes
			? `\n\nAutomated file review:\n${options.reviewNotes}\n`
			: '';

		const systemContent = options.review
			? `${CHAT_SYSTEM}\n${REVIEW_FILE_RULES}`
			: CHAT_SYSTEM;

		const messages = [{ role: 'system', content: systemContent }];
		for (const turn of trimHistory(history)) {
			if (turn.role === 'user' || turn.role === 'assistant') {
				messages.push({ role: turn.role, content: turn.content });
			}
		}
		messages.push({
			role: 'user',
			content: `${contextNote}${reviewSection}\n\nUser message: ${task}`,
		});
		return messages;
	}

	/**
	 * @param {string} task
	 * @param {Array<{relativeFile: string, content: string, reason: string}>} shards
	 * @param {Array<{role: string, content: string}>} [history]
	 * @returns {Array<{role: string, content: string}>}
	 */
	buildEditPrompt(task, shards, history = []) {
		const contextBlock = this.formatContextBlock(shards);

		const systemPrompt = `You are NeuroCode — an expert software engineer implementing real code changes in the user's project (like Cursor or Copilot).

Your job is to WRITE CODE INTO THE PROJECT, not to write tutorials.

Rules:
- Output one fenced code block per file changed or created
- Each block MUST start with: // filename: relative/path/from/project/root
- You may also put the path in the fence tag, e.g. \`\`\`typescript:src/app/page.tsx
- Output COMPLETE file contents — never truncate mid-function or mid-string
- Create NEW files when the task requires them (e.g. lib/analytics/service.ts)
- Match existing project conventions (imports, TypeScript, Next.js app router, Drizzle, etc.)
- Keep prose minimal: at most 2 sentences before the first code block, then code only
- If the task references a numbered item from earlier conversation, implement THAT item using conversation context

Format for each file:
\`\`\`typescript
// filename: lib/example.ts
[complete file content]
\`\`\``;

		const messages = [{ role: 'system', content: systemPrompt }];
		for (const turn of trimHistory(history)) {
			if (turn.role === 'user' || turn.role === 'assistant') {
				messages.push({ role: turn.role, content: turn.content });
			}
		}
		messages.push({
			role: 'user',
			content: `Project context:\n${contextBlock}\n\nImplement this task in the codebase:\n${task}`,
		});
		return messages;
	}

	/**
	 * @param {string} task
	 * @param {Array<{relativeFile: string, content: string, reason: string}>} shards
	 * @returns {Array<{role: string, content: string}>}
	 */
	buildPrompt(task, shards) {
		return this.buildEditPrompt(task, shards, []);
	}

	/**
	 * @param {string} task
	 * @param {string | undefined} activeFile
	 * @param {string} projectPath
	 * @param {import('./ProjectMemoryGraph.js').ProjectMemoryGraph | null} memoryGraph
	 * @param {import('./CrossRepoIndexer.js').CrossRepoIndexer | null} crossRepoIndexer
	 */
	async assembleContext(task, activeFile, projectPath, memoryGraph = null, crossRepoIndexer = null) {
		const shards = [];
		let budget = this.MAX_TOKENS;
		const reviewTask = isFileReviewTask(task);
		const fileHint = extractFileHintFromTask(task);
		const requestedFile = fileHint
			? resolveTaskFilePath(fileHint, projectPath, this.db)
			: null;

		if (requestedFile && fs.existsSync(requestedFile)) {
			const content = this._readFile(requestedFile);
			const fullTokens = this.countTokens(content);
			const maxForReview = reviewTask
				? Math.min(fullTokens, budget - 400, 3200)
				: Math.min(1200, budget - 500);
			const tokens = Math.min(fullTokens, maxForReview);
			shards.push({
				file: requestedFile,
				relativeFile: this._rel(requestedFile, projectPath),
				content: reviewTask && tokens >= fullTokens ? content : content.slice(0, tokens * 4),
				reason: 'requested file',
				tokenCount: tokens,
				priority: 0,
			});
			budget -= tokens;
		}

		if (activeFile && fs.existsSync(activeFile) && activeFile !== requestedFile) {
			const content = this._readFile(activeFile);
			const tokens = Math.min(this.countTokens(content), budget - 500);
			shards.push({
				file: activeFile,
				relativeFile: this._rel(activeFile, projectPath),
				content: content.slice(0, tokens * 4),
				reason: 'active file',
				tokenCount: tokens,
				priority: 1,
			});
			budget -= tokens;
		}

		const contextFile = requestedFile ?? activeFile;
		if (contextFile) {
			const related = this.db.prepare(`
				SELECT f.path, f.token_count, 'import' as rel FROM dependencies d
				JOIN files f ON f.id = d.to_file_id
				JOIN files af ON af.id = d.from_file_id WHERE af.path = ?
				UNION
				SELECT f.path, f.token_count, 'caller' as rel FROM dependencies d
				JOIN files f ON f.id = d.from_file_id
				JOIN files af ON af.id = d.to_file_id WHERE af.path = ?
			`).all(contextFile, contextFile);

			for (const r of related) {
				if (budget <= 300) {
					break;
				}
				if (shards.some((s) => s.file === r.path)) {
					continue;
				}
				try {
					const c = this._readFile(r.path);
					const t = Math.min(this.countTokens(c), budget);
					shards.push({
						file: r.path,
						relativeFile: this._rel(r.path, projectPath),
						content: c.slice(0, t * 4),
						reason: r.rel,
						tokenCount: t,
						priority: r.rel === 'import' ? 2 : 3,
					});
					budget -= t;
				} catch {
					// file missing
				}
			}
		}

		if (memoryGraph && budget > 400) {
			const hits = await memoryGraph.query(task, 3);
			for (const hit of hits) {
				const files = JSON.parse(hit.filesEdited || '[]');
				for (const f of files) {
					if (budget <= 300) {
						break;
					}
					const absPath = path.isAbsolute(f) ? f : path.resolve(projectPath, f);
					if (shards.some((s) => s.file === absPath)) {
						continue;
					}
					try {
						const c = this._readFile(absPath);
						const t = Math.min(this.countTokens(c), budget);
						shards.push({
							file: absPath,
							relativeFile: this._rel(absPath, projectPath),
							content: c.slice(0, t * 4),
							reason: `memory hit (weight: ${hit.weight.toFixed(1)})`,
							tokenCount: t,
							priority: 4,
						});
						budget -= t;
					} catch {
						// file may not exist
					}
				}
			}
		}

		if (budget > 300) {
			try {
				const emb = await EmbeddingService.embed(task);
				const similar = await this.vectorStore.query(emb, 3);
				for (const r of similar) {
					if (budget <= 200) {
						break;
					}
					const f = r.item.metadata?.file;
					if (!f || shards.some((s) => s.file === f)) {
						continue;
					}
					const c = r.item.metadata?.content ?? '';
					const t = Math.min(this.countTokens(String(c)), budget);
					shards.push({
						file: f,
						relativeFile: r.item.metadata?.relativeFile ?? f,
						content: String(c).slice(0, t * 4),
						reason: `semantic match (${r.score.toFixed(2)})`,
						tokenCount: t,
						priority: 5,
					});
					budget -= t;
				}
			} catch (err) {
				console.warn('[ShardManager] Vector search skipped:', err.message);
			}
		}

		if (crossRepoIndexer && budget > 300) {
			try {
				const crossHits = await crossRepoIndexer.searchAcrossRepos(task, 2, projectPath);
				for (const hit of crossHits) {
					if (budget <= 200) {
						break;
					}
					if (shards.some((s) => s.file === hit.file)) {
						continue;
					}
					const t = Math.min(hit.tokenCount ?? 200, budget);
					shards.push({
						file: hit.file,
						relativeFile: hit.relativeFile,
						content: hit.content?.slice(0, t * 4) ?? '',
						reason: `cross-repo from ${hit.projectName}`,
						tokenCount: t,
						priority: 5,
					});
					budget -= t;
				}
			} catch (err) {
				console.warn('[ShardManager] Cross-repo search skipped:', err.message);
			}
		}

		await this._bootstrapProjectContext(task, projectPath, shards, budget);

		return {
			shards,
			totalTokens: this.MAX_TOKENS - budget,
			budget: this.MAX_TOKENS,
			provider: LLMRouter.getActiveProvider(),
			indexed: this._getIndexedFileCount(projectPath) > 0,
			fileCount: this._getIndexedFileCount(projectPath),
		};
	}

	/**
	 * Loads README, package.json, and key source files when context is thin.
	 * @param {string} task
	 * @param {string} projectPath
	 * @param {Array} shards
	 * @param {number} budget
	 */
	async _bootstrapProjectContext(task, projectPath, shards, budget) {
		const isProjectWide = /\b(project|codebase|repo|repository|understand|overview|read this|whole app|landing page|tell me what)\b/i.test(task);
		if (shards.length > 0 && !isProjectWide) {
			return;
		}

		const keyFiles = ['README.md', 'package.json', 'tsconfig.json'];
		for (const name of keyFiles) {
			if (budget <= 400) {
				break;
			}
			const fp = path.join(projectPath, name);
			budget = this._tryAddShard(fp, projectPath, shards, budget, 'project overview', 0) ?? budget;
		}

		const indexedCount = this._getIndexedFileCount(projectPath);
		if (indexedCount > 0) {
			const prefix = projectPath.replace(/\\/g, '/');
			const rows = this.db.prepare(`
				SELECT path, relative_path FROM files
				WHERE replace(path, '\\', '/') LIKE ? || '%'
				ORDER BY
					CASE WHEN relative_path LIKE 'src/app/page%' THEN 0
					     WHEN relative_path LIKE 'src/%' THEN 1
					     ELSE 2 END,
					length(relative_path) ASC
				LIMIT 12
			`).all(`${prefix}%`);

			for (const row of rows) {
				if (budget <= 400) {
					break;
				}
				budget = this._tryAddShard(row.path, projectPath, shards, budget, 'indexed file', 6) ?? budget;
			}
			return;
		}

		const exclude = JSON.parse(process.env.NEUROCODE_INDEX_EXCLUDE || '[]');
		let added = 0;
		for await (const fp of walkProjectFiles(projectPath, exclude)) {
			if (added >= 10 || budget <= 400) {
				break;
			}
			const before = shards.length;
			budget = this._tryAddShard(fp, projectPath, shards, budget, 'project scan', 6) ?? budget;
			if (shards.length > before) {
				added++;
			}
		}
	}

	/**
	 * @param {string} [projectPath]
	 * @returns {number}
	 */
	_getIndexedFileCount(projectPath) {
		try {
			if (projectPath) {
				const prefix = projectPath.replace(/\\/g, '/');
				return this.db.prepare(
					`SELECT COUNT(*) as c FROM files WHERE replace(path, '\\', '/') LIKE ? || '%'`,
				).get(`${prefix}%`)?.c ?? 0;
			}
			return this.db.prepare('SELECT COUNT(*) as c FROM files').get()?.c ?? 0;
		} catch {
			return 0;
		}
	}

	/**
	 * @param {string} filePath
	 * @param {string} projectPath
	 * @param {Array} shards
	 * @param {number} budget
	 * @param {string} reason
	 * @param {number} priority
	 * @returns {number | undefined} Remaining budget
	 */
	_tryAddShard(filePath, projectPath, shards, budget, reason, priority) {
		if (!filePath || !fs.existsSync(filePath) || budget <= 300) {
			return budget;
		}
		if (shards.some((s) => s.file === filePath)) {
			return budget;
		}
		try {
			const content = this._readFile(filePath);
			const maxTokens = reason === 'project overview' ? 800 : 500;
			const tokens = Math.min(this.countTokens(content), maxTokens, budget - 200);
			if (tokens <= 0) {
				return budget;
			}
			shards.push({
				file: filePath,
				relativeFile: this._rel(filePath, projectPath),
				content: content.slice(0, tokens * 4),
				reason,
				tokenCount: tokens,
				priority,
			});
			return budget - tokens;
		} catch {
			return budget;
		}
	}

	/**
	 * @param {Array<{file: string, relativeFile: string, content: string}>} shards
	 * @param {string} llmResponse
	 */
	buildAttentionMap(shards, llmResponse) {
		const inContext = shards.map((s) => ({
			file: s.file,
			lineStart: 1,
			lineEnd: s.content.split('\n').length,
		}));

		const cited = [];
		for (const s of shards) {
			const lines = s.content.split('\n');
			lines.forEach((line, i) => {
				const trimmed = line.trim();
				if (trimmed.length > 8 && llmResponse.includes(trimmed.slice(0, 40))) {
					cited.push({ file: s.file, lineStart: i + 1, lineEnd: i + 1 });
				}
			});
		}

		const missed = [];
		if (cited.length === 0 && inContext.length > 0) {
			const first = shards[0];
			if (first) {
				const lineCount = first.content.split('\n').length;
				missed.push({
					file: first.file,
					lineStart: Math.floor(lineCount / 2),
					lineEnd: lineCount,
				});
			}
		}

		return { inContext, cited, missed };
	}

	/**
	 * @param {string} filePath
	 * @returns {string}
	 */
	_readFile(filePath) {
		return fs.readFileSync(filePath, 'utf8');
	}

	/**
	 * @param {string} absPath
	 * @param {string} projectPath
	 * @returns {string}
	 */
	_rel(absPath, projectPath) {
		return path.relative(projectPath, absPath).replace(/\\/g, '/');
	}
}
