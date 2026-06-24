import fs from 'fs';
import path from 'path';

/**
 * @param {string} task
 * @returns {boolean}
 */
export function isFileReviewTask(task) {
	const m = task.toLowerCase().trim();
	return (
		/\b(check|review|inspect|audit|look at|read|analyze|analyse|what(?:'s| is) wrong with)\b/.test(m) &&
		(/\b(file|\.ts|\.tsx|\.js|\.jsx|\.py)\b/.test(m) || /\b[\w./-]+\.(?:ts|tsx|js|jsx|py)\b/.test(m))
	) || /\b(is this (?:file )?complete|half done|incomplete|unfinished)\b/.test(m);
}

/**
 * @param {string} task
 * @returns {string | null} Filename or path hint from the user message.
 */
export function extractFileHintFromTask(task) {
	const patterns = [
		/\b(?:check|review|inspect|read|look at|analyze|analyse)\s+(?:the\s+)?(?:file\s+)?[`"']?([^\s`"']+\.[a-z0-9]+)[`"']?/i,
		/\b[`"']?((?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]+)[`"']?/i,
		/\b([a-z][\w.-]*\.(?:ts|tsx|js|jsx|py))\b/i,
	];

	for (const pattern of patterns) {
		const match = task.match(pattern);
		if (match?.[1]) {
			return match[1].replace(/^['"`]+|['"`]+$/g, '');
		}
	}

	return null;
}

/**
 * Paths and line numbers from pasted stack traces / Next.js error overlays.
 * @param {string} task
 * @returns {Array<{ path: string, line?: number }>}
 */
export function extractStackTracePaths(task) {
	if (!task || typeof task !== 'string') {
		return [];
	}

	const found = new Map();

	const add = (rawPath, line) => {
		const path = rawPath.replace(/\\/g, '/').replace(/^\.\//, '').trim();
		if (!path || !/\.\w+$/.test(path)) {
			return;
		}
		const existing = found.get(path);
		if (!existing || (line && !existing.line)) {
			found.set(path, { path, line: line || existing?.line });
		}
	};

	const patterns = [
		/([\w./\\-]+\.(?:tsx?|jsx?))\s*[:(]\s*(\d+)/gi,
		/([\w./\\-]+\.(?:tsx?|jsx?)):(\d+)(?::\d+)?/gi,
	];

	for (const pattern of patterns) {
		let match;
		while ((match = pattern.exec(task)) !== null) {
			const rel = match[1].replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
			const line = parseInt(match[2], 10);
			add(rel, Number.isFinite(line) ? line : undefined);
		}
	}

	const jsxComponent = task.match(/<([A-Z][A-Za-z0-9_]*)/);
	if (jsxComponent?.[1] && found.size < 4) {
		const name = jsxComponent[1];
		add(`components/chat/${name}.tsx`);
		add(`components/chat/${name.toLowerCase()}.tsx`);
	}

	return [...found.values()];
}

/**
 * @param {string} task
 * @param {Array<{ path: string, line?: number }>} locations
 * @returns {string}
 */
export function buildErrorFixTask(task, locations = []) {
	const paths = locations.map((l) => (l.line ? `${l.path}:${l.line}` : l.path));
	const fileList = paths.length ? paths.join(', ') : 'files mentioned in the error';
	return `Fix this error. Start by reading ONLY these files: ${fileList}. Then apply the minimal code fix with write_file.

Error / request:
${task.slice(0, 2500)}`;
}

/**
 * @param {string} hint
 * @param {string} projectPath
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string | null} Absolute path if found.
 */
export function resolveTaskFilePath(hint, projectPath, db) {
	if (!hint || !projectPath) {
		return null;
	}

	const normalizedHint = hint.replace(/\\/g, '/').toLowerCase();
	const basename = path.basename(normalizedHint).toLowerCase();

	try {
		const rows = db.prepare('SELECT path, relative_path FROM files').all();
		const prefix = projectPath.replace(/\\/g, '/').toLowerCase();

		const candidates = rows
			.map((row) => ({
				path: row.path,
				relative: String(row.relative_path ?? '').replace(/\\/g, '/').toLowerCase(),
			}))
			.filter((row) => row.path.toLowerCase().startsWith(`${prefix}/`) || row.path.toLowerCase() === prefix);

		const exact = candidates.find((c) => c.relative === normalizedHint);
		if (exact) {
			return exact.path;
		}

		const endsWith = candidates.filter(
			(c) => c.relative.endsWith(`/${normalizedHint}`) || c.relative === normalizedHint,
		);
		if (endsWith.length > 0) {
			endsWith.sort((a, b) => a.relative.length - b.relative.length);
			return endsWith[0].path;
		}

		const byBase = candidates.filter((c) => path.basename(c.relative) === basename);
		if (byBase.length === 1) {
			return byBase[0].path;
		}
		if (byBase.length > 1) {
			byBase.sort((a, b) => {
				const aScore = a.relative.includes('lib/') ? 0 : 1;
				const bScore = b.relative.includes('lib/') ? 0 : 1;
				return aScore - bScore || a.relative.length - b.relative.length;
			});
			return byBase[0].path;
		}
	} catch {
		// fall through to filesystem walk
	}

	const direct = path.join(projectPath, normalizedHint);
	if (fs.existsSync(direct)) {
		return direct;
	}

	return findFileByBasename(projectPath, basename, 0);
}

/**
 * @param {string} dir
 * @param {string} basename
 * @param {number} depth
 * @returns {string | null}
 */
function findFileByBasename(dir, basename, depth) {
	if (depth > 6) {
		return null;
	}

	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}

	for (const entry of entries) {
		if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
			continue;
		}
		const full = path.join(dir, entry.name);
		if (entry.isFile() && entry.name.toLowerCase() === basename) {
			return full;
		}
		if (entry.isDirectory()) {
			const found = findFileByBasename(full, basename, depth + 1);
			if (found) {
				return found;
			}
		}
	}

	return null;
}

/**
 * @param {string} content
 * @returns {{ complete: boolean, issues: string[] }}
 */
export function analyzeFileCompleteness(content) {
	const issues = [];
	const text = content.trimEnd();

	if (!text) {
		return { complete: false, issues: ['File is empty'] };
	}

	const openBraces = (text.match(/\{/g) ?? []).length;
	const closeBraces = (text.match(/\}/g) ?? []).length;
	if (openBraces !== closeBraces) {
		issues.push(`Unbalanced braces (${openBraces} opening, ${closeBraces} closing)`);
	}

	const openParens = (text.match(/\(/g) ?? []).length;
	const closeParens = (text.match(/\)/g) ?? []).length;
	if (openParens !== closeParens) {
		issues.push(`Unbalanced parentheses (${openParens} opening, ${closeParens} closing)`);
	}

	const fenceCount = (text.match(/```/g) ?? []).length;
	if (fenceCount % 2 !== 0) {
		issues.push('Unclosed markdown code fence inside file');
	}

	const lastLine = text.split('\n').pop()?.trim() ?? '';
	if (/[,=(]$/.test(lastLine) && !lastLine.startsWith('//')) {
		issues.push(`File ends mid-statement: "${lastLine}"`);
	}

	if (/\bclass\s+\w+/.test(text) && !/\bexport\b/.test(text)) {
		issues.push('Defines a class but has no export — may be unfinished');
	}

	if (/\bTODO\b|\bFIXME\b|\.\.\./.test(text)) {
		issues.push('Contains TODO/FIXME or placeholder ellipsis');
	}

	if (/\basync\s+\w+\([^)]*$/.test(text.split('\n').slice(-3).join('\n'))) {
		issues.push('Last lines suggest a truncated function signature');
	}

	return { complete: issues.length === 0, issues };
}

/**
 * @param {Array<{ relativeFile: string, content: string, reason?: string, file?: string }>} shards
 * @param {string} task
 * @returns {{ relativeFile: string, content: string, file?: string } | null}
 */
export function getPrimaryReviewShard(shards, task) {
	const hint = extractFileHintFromTask(task)?.toLowerCase() ?? '';
	return (
		shards.find((s) => hint && s.relativeFile.toLowerCase().includes(hint)) ??
		shards.find((s) => s.reason === 'requested file') ??
		shards.find((s) => s.reason === 'active file') ??
		shards[0] ??
		null
	);
}

/**
 * @param {{ file?: string, content: string }} shard
 * @returns {string}
 */
export function getFullFileContent(shard) {
	if (shard?.file && fs.existsSync(shard.file)) {
		try {
			return fs.readFileSync(shard.file, 'utf8');
		} catch {
			// fall through
		}
	}
	return shard?.content ?? '';
}

/**
 * @param {string} task
 * @param {Array<{ relativeFile: string, content: string, reason?: string, file?: string }>} shards
 * @param {boolean} [fixOnCheck=true]
 * @returns {boolean}
 */
export function shouldAutoFixOnCheck(task, shards, fixOnCheck = true) {
	if (!fixOnCheck || !isFileReviewTask(task)) {
		return false;
	}
	const primary = getPrimaryReviewShard(shards, task);
	if (!primary) {
		return false;
	}
	const fullContent = getFullFileContent(primary);
	return !analyzeFileCompleteness(fullContent).complete;
}

/**
 * @param {string} task
 * @param {Array<{ relativeFile: string, content: string, reason?: string, file?: string }>} shards
 * @returns {string}
 */
export function buildAutoFixTask(task, shards) {
	const primary = getPrimaryReviewShard(shards, task);
	if (!primary) {
		return task;
	}

	const fullContent = getFullFileContent(primary);
	const analysis = analyzeFileCompleteness(fullContent);
	const issueList = analysis.issues.map((i) => `- ${i}`).join('\n');

	return `The file \`${primary.relativeFile}\` is incomplete or has structural errors. Complete and fix it in the project.

Detected issues:
${issueList || '- file appears truncated or unfinished'}

Requirements:
- Output the FULL corrected file in a fenced code block
- First line inside the block MUST be: // filename: ${primary.relativeFile}
- Preserve all valid existing logic from the current file
- Finish truncated methods, fix syntax errors, add missing exports
- Do NOT explain in prose — output the complete file only`;
}

/**
 * @param {Array<{ relativeFile: string, content: string, reason?: string }>} shards
 * @param {string} task
 * @returns {string}
 */
export function buildReviewNotes(shards, task) {
	const primary = getPrimaryReviewShard(shards, task);

	if (!primary) {
		return 'No source file was loaded. Ask the user to open the file or run **Index Project**.';
	}

	const analysis = analyzeFileCompleteness(getFullFileContent(primary));
	const status = analysis.complete
		? 'Structure looks complete (automated check only — still review logic by hand).'
		: '**Likely incomplete or truncated** — automated structural checks failed.';

	const issueLines = analysis.issues.length
		? analysis.issues.map((i) => `- ${i}`).join('\n')
		: '- (no structural issues detected)';

	return [
		`Primary file: \`${primary.relativeFile}\``,
		`Status: ${status}`,
		'Structural notes:',
		issueLines,
	].join('\n');
}

export const REVIEW_FILE_RULES = `
### File review mode (user asked to CHECK / REVIEW a file)
You are reviewing code — you are NOT implementing fixes in this turn.

STRICT rules:
- Do NOT rewrite the file or paste a full replacement
- Do NOT say "Let me fix" and then dump code — that is Implement mode
- Do NOT use large code blocks (max ~15 lines in a snippet, only to illustrate a specific problem)
- Analyze what exists today: purpose, what works, what is missing, incomplete, or risky
- If the file is half-done or truncated, say exactly which methods/sections are missing or cut off
- Compare against what a complete version would need (list gaps as bullets, not code)
- End "## Suggested next steps" with: say **"implement"** or **"finish <filename>"** to complete the file in the project automatically (Cursor-style)
`;
