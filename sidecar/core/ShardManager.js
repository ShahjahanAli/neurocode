import fs from 'fs';
import path from 'path';
import { encode } from 'gpt-tokenizer';
import { LLMRouter } from './LLMRouter.js';
import { EmbeddingService } from './EmbeddingService.js';
import { CHAT_SYSTEM, trimHistory } from './ChatOrchestrator.js';

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
		const contextBlock = this.formatContextBlock(shards);
		const contextNote = contextBlock
			? `Relevant code context:\n${contextBlock}`
			: 'No indexed code context yet. Suggest indexing the project first.';

		if (intent === 'edit') {
			return this.buildEditPrompt(task, shards);
		}

		const messages = [{ role: 'system', content: CHAT_SYSTEM }];
		for (const turn of trimHistory(history)) {
			if (turn.role === 'user' || turn.role === 'assistant') {
				messages.push({ role: turn.role, content: turn.content });
			}
		}
		messages.push({
			role: 'user',
			content: `${contextNote}\n\nUser message: ${task}`,
		});
		return messages;
	}

	/**
	 * @param {string} task
	 * @param {Array<{relativeFile: string, content: string, reason: string}>} shards
	 * @returns {Array<{role: string, content: string}>}
	 */
	buildEditPrompt(task, shards) {
		const contextBlock = this.formatContextBlock(shards);

		const systemPrompt = `You are NeuroCode — an expert software engineer helping implement code changes.

Analyze the provided code context, then complete the task.
Output the modified code in a fenced block with the filename as a comment on line 1.
You may include a brief 1–2 sentence summary BEFORE the code block explaining what you changed.

Format:
\`\`\`typescript
// filename: relative/path/to/file.ts
[complete modified file or relevant section]
\`\`\``;

		return [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: `Context:\n${contextBlock}\n\nTask: ${task}` },
		];
	}

	/**
	 * @param {string} task
	 * @param {Array<{relativeFile: string, content: string, reason: string}>} shards
	 * @returns {Array<{role: string, content: string}>}
	 */
	buildPrompt(task, shards) {
		return this.buildEditPrompt(task, shards);
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

		if (activeFile && fs.existsSync(activeFile)) {
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

		if (activeFile) {
			const related = this.db.prepare(`
				SELECT f.path, f.token_count, 'import' as rel FROM dependencies d
				JOIN files f ON f.id = d.to_file_id
				JOIN files af ON af.id = d.from_file_id WHERE af.path = ?
				UNION
				SELECT f.path, f.token_count, 'caller' as rel FROM dependencies d
				JOIN files f ON f.id = d.from_file_id
				JOIN files af ON af.id = d.to_file_id WHERE af.path = ?
			`).all(activeFile, activeFile);

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

		return {
			shards,
			totalTokens: this.MAX_TOKENS - budget,
			budget: this.MAX_TOKENS,
			provider: LLMRouter.getActiveProvider(),
		};
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
