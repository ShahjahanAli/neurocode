import fs from 'fs';
import path from 'path';
import { EmbeddingService } from './EmbeddingService.js';
import { resolveTaskFilePath } from './FileReview.js';

/**
 * @param {string} filePath
 * @param {string} projectPath
 * @param {import('node:sqlite').DatabaseSync | null} db
 * @returns {string | null}
 */
function resolveReadablePath(filePath, projectPath, db) {
	if (!filePath || !projectPath) {
		return null;
	}

	const fromIndex = db ? resolveTaskFilePath(filePath, projectPath, db) : null;
	if (fromIndex && fs.existsSync(fromIndex)) {
		return fromIndex;
	}

	if (fs.existsSync(filePath)) {
		return filePath;
	}

	const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
	const joined = path.join(projectPath, normalized);
	return fs.existsSync(joined) ? joined : null;
}

/**
 * Executes a single agent tool call.
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {object} ctx
 * @param {string} ctx.projectPath
 * @param {import('node:sqlite').DatabaseSync | null} ctx.db
 * @param {import('../vector/VectorStore.js').VectorStore | null} ctx.vectorStore
 * @returns {Promise<Record<string, unknown>>}
 */
export async function executeAgentTool(toolName, args, ctx) {
	const { projectPath, db, vectorStore } = ctx;

	switch (toolName) {
		case 'read_file': {
			const filePath = String(args.path ?? '');
			const abs = resolveReadablePath(filePath, projectPath, db);

			if (!abs) {
				return { success: false, error: `File not found: ${filePath}` };
			}

			const maxChars = Number(args.max_chars) || 14_000;
			const raw = fs.readFileSync(abs, 'utf8');
			return {
				success: true,
				path: path.relative(projectPath, abs).replace(/\\/g, '/'),
				content: raw.slice(0, maxChars),
				truncated: raw.length > maxChars,
				lineCount: raw.split('\n').length,
			};
		}

		case 'search_code': {
			const query = String(args.query ?? '').trim();
			if (!query) {
				return { success: false, error: 'query is required' };
			}

			const limit = Math.min(Number(args.limit) || 6, 10);
			const hits = [];
			const seen = new Set();

			if (vectorStore) {
				try {
					const emb = await EmbeddingService.embed(query);
					const similar = await vectorStore.query(emb, limit);
					for (const r of similar) {
						const rel = String(r.item.metadata?.relativeFile ?? r.item.id ?? '');
						if (!rel || seen.has(rel)) {
							continue;
						}
						seen.add(rel);
						hits.push({
							file: rel,
							score: Number(r.score?.toFixed(3) ?? 0),
							snippet: String(r.item.metadata?.content ?? '').slice(0, 350),
							source: 'semantic',
						});
					}
				} catch (err) {
					console.warn('[AgentTools] Vector search failed:', err.message);
				}
			}

			if (db) {
				try {
					const pattern = `%${query.replace(/\s+/g, '%')}%`;
					const rows = db.prepare(
						'SELECT relative_path, token_count FROM files WHERE relative_path LIKE ? ORDER BY token_count DESC LIMIT ?',
					).all(pattern, limit);

					for (const row of rows) {
						const rel = String(row.relative_path ?? '').replace(/\\/g, '/');
						if (!rel || seen.has(rel)) {
							continue;
						}
						seen.add(rel);
						hits.push({
							file: rel,
							score: 0.5,
							snippet: '(path name match)',
							source: 'filename',
						});
					}
				} catch {
					// ignore
				}
			}

			return { success: true, query, hits: hits.slice(0, limit) };
		}

		case 'write_file': {
			const relPath = String(args.path ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
			const content = String(args.content ?? '');

			if (!relPath) {
				return { success: false, error: 'path is required' };
			}
			if (!content.trim()) {
				return { success: false, error: 'content is required' };
			}

			return {
				success: true,
				staged: true,
				path: relPath,
				content,
				note: 'Write staged — extension host will apply to workspace',
			};
		}

		case 'reply': {
			return {
				success: true,
				terminal: true,
				message: String(args.message ?? ''),
			};
		}

		default:
			return { success: false, error: `Unknown tool: ${toolName}` };
	}
}

export const AGENT_TOOL_NAMES = ['read_file', 'search_code', 'write_file', 'reply'];
