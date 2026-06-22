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
 * @param {Array<{ relativeFile: string, content: string, reason?: string }>} shards
 * @param {string} task
 * @returns {string}
 */
export function buildReviewNotes(shards, task) {
	const hint = extractFileHintFromTask(task)?.toLowerCase() ?? '';
	const primary =
		shards.find((s) => hint && s.relativeFile.toLowerCase().includes(hint)) ??
		shards.find((s) => s.reason === 'requested file') ??
		shards.find((s) => s.reason === 'active file') ??
		shards[0];

	if (!primary) {
		return 'No source file was loaded. Ask the user to open the file or run **Index Project**.';
	}

	const analysis = analyzeFileCompleteness(primary.content);
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
