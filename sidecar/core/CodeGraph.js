import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { encode } from 'gpt-tokenizer';
import { fileQueue } from './FileQueue.js';

const CODE_EXTENSIONS = new Set([
	'.ts', '.tsx', '.js', '.jsx', '.py', '.php', '.java', '.go', '.rs',
]);

const LANG_MAP = {
	'.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
	'.py': 'python', '.php': 'php', '.java': 'java', '.go': 'go', '.rs': 'rust',
};

/**
 * @param {string} projectPath
 * @param {string[]} excludePatterns
 * @returns {AsyncGenerator<string>}
 */
export async function* walkProjectFiles(projectPath, excludePatterns = []) {
	const ignore = loadIgnorePatterns(projectPath, excludePatterns);

	for await (const filePath of walkDir(projectPath, projectPath, ignore)) {
		const ext = path.extname(filePath).toLowerCase();
		if (CODE_EXTENSIONS.has(ext)) {
			yield filePath;
		}
	}
}

/**
 * @param {string} projectPath
 * @param {string[]} excludePatterns
 * @returns {Set<string>}
 */
function loadIgnorePatterns(projectPath, excludePatterns) {
	const ignore = new Set(excludePatterns);
	const ignoreFile = path.join(projectPath, '.neurocodeignore');
	if (fs.existsSync(ignoreFile)) {
		for (const line of fs.readFileSync(ignoreFile, 'utf8').split('\n')) {
			const t = line.trim();
			if (t && !t.startsWith('#')) {
				ignore.add(t);
			}
		}
	}
	return ignore;
}

/**
 * @param {string} dir
 * @param {string} root
 * @param {Set<string>} ignore
 * @returns {AsyncGenerator<string>}
 */
async function* walkDir(dir, root, ignore) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		const rel = path.relative(root, full).replace(/\\/g, '/');

		if (shouldIgnore(rel, entry.name, ignore)) {
			continue;
		}

		if (entry.isDirectory()) {
			yield* walkDir(full, root, ignore);
		} else if (entry.isFile()) {
			yield full;
		}
	}
}

/**
 * @param {string} relPath
 * @param {string} name
 * @param {Set<string>} ignore
 * @returns {boolean}
 */
function shouldIgnore(relPath, name, ignore) {
	for (const pattern of ignore) {
		if (relPath === pattern || relPath.startsWith(`${pattern}/`) || name === pattern) {
			return true;
		}
		if (pattern.includes('*') && new RegExp(`^${pattern.replace(/\*/g, '.*')}$`).test(relPath)) {
			return true;
		}
	}
	return false;
}

/**
 * @param {string} filePath
 * @param {string} projectPath
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Promise<{ fileId: number, content: string, language: string }>}
 */
export async function indexFile(filePath, projectPath, db) {
	const content = await fileQueue.readFile(filePath, 'utf8');
	const tokenCount = encode(content).length;
	const hash = createHash('md5').update(content).digest('hex');
	const relativePath = path.relative(projectPath, filePath).replace(/\\/g, '/');
	const language = LANG_MAP[path.extname(filePath).toLowerCase()] ?? 'unknown';
	const now = Date.now();

	db.prepare(`
		INSERT INTO files (path, relative_path, language, token_count, last_indexed, content_hash)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET
			relative_path = excluded.relative_path,
			language = excluded.language,
			token_count = excluded.token_count,
			last_indexed = excluded.last_indexed,
			content_hash = excluded.content_hash
	`).run(filePath, relativePath, language, tokenCount, now, hash);

	const row = db.prepare('SELECT id FROM files WHERE path = ?').get(filePath);
	return { fileId: row.id, content, language };
}

/**
 * @param {string} content
 * @param {string} language
 * @param {string} filePath
 * @param {string} projectPath
 * @returns {string[]}
 */
export function extractImportPaths(content, language, filePath, projectPath) {
	const imports = [];
	const dir = path.dirname(filePath);

	if (language === 'typescript' || language === 'javascript') {
		const importRe = /(?:import|export)\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g;
		const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
		let m;
		while ((m = importRe.exec(content)) !== null) {
			imports.push(m[1]);
		}
		while ((m = requireRe.exec(content)) !== null) {
			imports.push(m[1]);
		}
	} else if (language === 'python') {
		const pyRe = /^(?:from\s+(\S+)\s+import|import\s+(\S+))/gm;
		let m;
		while ((m = pyRe.exec(content)) !== null) {
			imports.push(m[1] || m[2]);
		}
	} else if (language === 'php') {
		const phpRe = /(?:require|include|require_once|include_once)\s*\(?\s*['"]([^'"]+)['"]/g;
		let m;
		while ((m = phpRe.exec(content)) !== null) {
			imports.push(m[1]);
		}
	}

	return imports
		.filter((i) => i.startsWith('.') || i.startsWith('/'))
		.map((i) => resolveImportPath(i, dir, projectPath))
		.filter(Boolean);
}

/**
 * @param {string} importPath
 * @param {string} fromDir
 * @param {string} projectPath
 * @returns {string | null}
 */
function resolveImportPath(importPath, fromDir, projectPath) {
	let resolved = path.resolve(fromDir, importPath);
	const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.py', '.php'];
	for (const ext of exts) {
		const candidate = resolved + ext;
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			return candidate;
		}
	}
	const indexCandidates = exts.map((ext) => path.join(resolved, `index${ext}`));
	for (const c of indexCandidates) {
		if (fs.existsSync(c)) {
			return c;
		}
	}
	if (resolved.startsWith(projectPath) && fs.existsSync(resolved)) {
		return resolved;
	}
	return null;
}

/**
 * Regex-based symbol extraction (tree-sitter upgrade path in future).
 * @param {string} content
 * @param {string} language
 * @returns {Array<{name: string, type: string, lineStart: number, lineEnd: number, signature: string, docstring: string}>}
 */
export function extractSymbols(content, language) {
	const symbols = [];
	const lines = content.split('\n');

	if (language === 'typescript' || language === 'javascript') {
		const fnRe = /^(export\s+)?(async\s+)?function\s+(\w+)/;
		const classRe = /^(export\s+)?class\s+(\w+)/;
		const constFnRe = /^(export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/;
		lines.forEach((line, i) => {
			let m = line.match(fnRe);
			if (m) {
				symbols.push({ name: m[3], type: 'function', lineStart: i + 1, lineEnd: i + 1, signature: line.trim(), docstring: '' });
				return;
			}
			m = line.match(classRe);
			if (m) {
				symbols.push({ name: m[2], type: 'class', lineStart: i + 1, lineEnd: i + 1, signature: line.trim(), docstring: '' });
				return;
			}
			m = line.match(constFnRe);
			if (m) {
				symbols.push({ name: m[2], type: 'function', lineStart: i + 1, lineEnd: i + 1, signature: line.trim(), docstring: '' });
			}
		});
	} else if (language === 'python') {
		const pyFnRe = /^def\s+(\w+)/;
		const pyClassRe = /^class\s+(\w+)/;
		lines.forEach((line, i) => {
			let m = line.match(pyFnRe);
			if (m) {
				symbols.push({ name: m[1], type: 'function', lineStart: i + 1, lineEnd: i + 1, signature: line.trim(), docstring: '' });
				return;
			}
			m = line.match(pyClassRe);
			if (m) {
				symbols.push({ name: m[1], type: 'class', lineStart: i + 1, lineEnd: i + 1, signature: line.trim(), docstring: '' });
			}
		});
	}

	return symbols;
}

/**
 * @param {number} fromFileId
 * @param {string[]} importPaths
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function storeDependencies(fromFileId, importPaths, db) {
	db.prepare('DELETE FROM dependencies WHERE from_file_id = ?').run(fromFileId);

	for (const imp of importPaths) {
		const target = db.prepare('SELECT id FROM files WHERE path = ?').get(imp);
		if (target) {
			db.prepare(`
				INSERT OR IGNORE INTO dependencies (from_file_id, to_file_id, import_name)
				VALUES (?, ?, ?)
			`).run(fromFileId, target.id, path.basename(imp));
		}
	}
}

/**
 * @param {number} fileId
 * @param {ReturnType<typeof extractSymbols>} symbols
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function storeSymbols(fileId, symbols, db) {
	db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);

	const insert = db.prepare(`
		INSERT INTO symbols (file_id, name, type, line_start, line_end, signature, docstring)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`);

	for (const s of symbols) {
		insert.run(fileId, s.name, s.type, s.lineStart, s.lineEnd, s.signature, s.docstring);
	}
}
