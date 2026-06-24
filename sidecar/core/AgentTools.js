import fs from 'fs';
import path from 'path';
import { EmbeddingService } from './EmbeddingService.js';
import { resolveTaskFilePath } from './FileReview.js';

/**
 * @param {string} content
 * @returns {boolean}
 */
function isInvalidWriteContent(content) {
	const trimmed = String(content ?? '').trim();
	if (!trimmed) {
		return true;
	}
	if (/```neurocode-tool/i.test(trimmed)) {
		return true;
	}
	return /^\s*\{\s*"tool"\s*:\s*"(?:read_file|search_code|write_file|search_replace|reply)"/.test(trimmed);
}

/**
 * @param {string} content
 * @param {string} [relPath]
 * @returns {boolean}
 */
export function isIncompleteWriteContent(content, relPath = '') {
	const trimmed = String(content ?? '').trim();
	if (!trimmed || trimmed.length < 8) {
		return true;
	}
	if (isInvalidWriteContent(trimmed)) {
		return true;
	}
	const ext = String(relPath ?? '').toLowerCase();
	if (/\.(tsx?|jsx?)$/.test(ext)) {
		const open = (trimmed.match(/\{/g) ?? []).length;
		const close = (trimmed.match(/\}/g) ?? []).length;
		const openParen = (trimmed.match(/\(/g) ?? []).length;
		const closeParen = (trimmed.match(/\)/g) ?? []).length;
		if (Math.abs(open - close) > 1 || Math.abs(openParen - closeParen) > 1) {
			return true;
		}
		if (!trimmed.includes('\n') && trimmed.length < 40) {
			return true;
		}
	}
	return false;
}

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

			const maxChars = Math.min(Number(args.max_chars) || 6000, 8000);
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
			if (isInvalidWriteContent(content)) {
				return {
					success: false,
					error: 'content looks like a tool-call JSON block, not source code — write the full file body',
				};
			}
			if (isIncompleteWriteContent(content, relPath)) {
				return {
					success: false,
					error: 'content looks truncated or incomplete — use search_replace for small edits',
				};
			}

			return {
				success: true,
				staged: true,
				path: relPath,
				content,
				note: 'Write staged — extension host will apply to workspace',
			};
		}

		case 'search_replace': {
			const relPath = String(args.path ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
			const oldText = String(args.old_text ?? args.oldText ?? '');
			const newText = String(args.new_text ?? args.newText ?? '');

			if (!relPath) {
				return { success: false, error: 'path is required' };
			}
			if (!oldText) {
				return { success: false, error: 'old_text is required' };
			}

			const abs = resolveReadablePath(relPath, projectPath, db);
			if (!abs) {
				return { success: false, error: `File not found: ${relPath}` };
			}

			const raw = fs.readFileSync(abs, 'utf8');
			if (!raw.includes(oldText)) {
				return {
					success: false,
					error: 'old_text not found in file',
					preview: raw.slice(0, 400),
				};
			}

			const updated = raw.replace(oldText, newText);
			if (isInvalidWriteContent(updated) || isIncompleteWriteContent(updated, relPath)) {
				return { success: false, error: 'search_replace produced invalid file content' };
			}

			return {
				success: true,
				staged: true,
				path: path.relative(projectPath, abs).replace(/\\/g, '/'),
				content: updated,
				note: 'search_replace staged — extension host will apply to workspace',
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

export const AGENT_TOOL_NAMES = ['read_file', 'search_code', 'write_file', 'search_replace', 'reply'];
