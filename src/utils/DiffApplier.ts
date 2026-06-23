import * as vscode from 'vscode';

/** Parsed code block from LLM output. */
export interface ParsedCodeBlock {
	filename?: string;
	language: string;
	code: string;
}

/** Options for parsing and applying code blocks. */
export interface ParseCodeBlocksOptions {
	/** When true, includes the final unclosed fenced block (truncated LLM output). */
	allowIncomplete?: boolean;
	/** Used when a single block has no detectable path (e.g. active editor file). */
	fallbackFilename?: string;
	/** Shard / context file paths to assign when blocks lack explicit paths. */
	hintFilenames?: string[];
	/** Workspace root for relativizing absolute hint paths. */
	workspaceRoot?: string;
}

const CODE_EXT =
	/\.(tsx?|jsx?|py|go|rs|java|php|vue|svelte|css|scss|json|md|html|mjs|cjs)$/i;

const FILE_HEADER_RE =
	/^\s*(?:\/\/|#)\s*(?:filename|file|path)\s*:\s*(.+?)\s*$/i;
const BLOCK_COMMENT_HEADER_RE =
	/^\s*\/\*\s*(?:filename|file|path)\s*:\s*(.+?)\s*\*\/\s*$/i;
const PLAIN_PATH_COMMENT_RE =
	/^\s*\/\/\s*([\w./@-]+\.[a-z0-9]+)\s*$/i;
const PLAIN_PATH_HASH_RE =
	/^\s*#\s*([\w./@-]+\.[a-z0-9]+)\s*$/i;
const FILE_LABEL_RE =
	/^\s*(?:\/\/|#|\/\*)?\s*(?:file|path)\s*:\s*(.+?)\s*(?:\*\/)?\s*$/i;
const AT_FILE_RE = /^\s*@file\s+(.+?)\s*$/i;

const PATH_IN_TEXT_RE =
	/(?:filename|file|path)\s*:\s*[`"']?([^\s`"'\n]+)/gi;
const BACKTICK_PATH_RE = /`((?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]+)`/gi;
const LOOSE_PATH_RE =
	/\b((?:src|app|lib|components|pages|api|server|sidecar|webview-ui)\/[\w./-]+\.[a-z0-9]+)\b/gi;

/**
 * Removes NeuroCode status appendices from a stored assistant message.
 * @param text - Assistant message text.
 * @returns LLM source text suitable for parsing.
 */
export function stripNeuroCodeAppendix(text: string): string {
	const markers = [
		'\n---\n**Applied to your project:**',
		'\n---\n**Note:**',
		'\n\n⚠️ **Response was cut off.**',
		'\n\n⚠️ **Response may be truncated.**',
		'\n\n**Failed to write:**',
	];
	let result = text;
	for (const marker of markers) {
		const idx = result.indexOf(marker);
		if (idx !== -1) {
			result = result.slice(0, idx);
		}
	}
	return result.trim();
}

/**
 * @param raw - Raw path string from LLM output.
 * @returns Normalized relative path.
 */
function normalizeFilename(raw: string): string {
	return raw
		.trim()
		.replace(/^['"`]+|['"`]+$/g, '')
		.replace(/\\/g, '/')
		.replace(/^\.\//, '')
		.replace(/^\/+/, '');
}

/**
 * @param filePath - Absolute or relative path.
 * @param workspaceRoot - Workspace root for relativizing.
 * @returns Normalized project-relative path.
 */
function relativizePath(filePath: string, workspaceRoot?: string): string {
	const normalized = normalizeFilename(filePath);
	if (!workspaceRoot) {
		return normalized;
	}
	const root = workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
	const candidate = normalized.replace(/\\/g, '/');
	if (/^[A-Za-z]:/.test(candidate) || candidate.startsWith('/')) {
		const lower = candidate.toLowerCase();
		if (lower.startsWith(`${root}/`)) {
			return candidate.slice(root.length + 1);
		}
	}
	return normalized;
}

/**
 * @param path - Candidate file path.
 * @returns Whether the string looks like a source file path.
 */
function looksLikeFilePath(path: string): boolean {
	const p = normalizeFilename(path);
	return Boolean(p) && (p.includes('/') || CODE_EXT.test(p));
}

/**
 * @param tag - Opening fence info string (e.g. typescript or src/app/page.tsx).
 * @returns Filename inferred from the fence tag, if any.
 */
function filenameFromFenceTag(tag: string): string | undefined {
	const trimmed = tag.trim();
	if (!trimmed) {
		return undefined;
	}

	if (trimmed.includes(':')) {
		const afterColon = trimmed.split(':').slice(1).join(':').trim();
		if (looksLikeFilePath(afterColon)) {
			return normalizeFilename(afterColon);
		}
	}

	if (looksLikeFilePath(trimmed) && !/^(typescript|javascript|tsx|jsx|python|json|bash|sh|sql|html|css)$/i.test(trimmed)) {
		return normalizeFilename(trimmed);
	}

	return undefined;
}

/**
 * @param line - Single source line.
 * @returns Extracted path if present.
 */
function extractPathFromLine(line: string): string | undefined {
	const checks = [
		FILE_HEADER_RE,
		BLOCK_COMMENT_HEADER_RE,
		AT_FILE_RE,
		FILE_LABEL_RE,
		PLAIN_PATH_COMMENT_RE,
		PLAIN_PATH_HASH_RE,
	];

	for (const re of checks) {
		const m = line.match(re);
		if (m?.[1] && looksLikeFilePath(m[1])) {
			return normalizeFilename(m[1]);
		}
	}

	const bold = line.match(/\*\*([^*]+\.[a-z0-9]+)\*\*/i);
	if (bold?.[1] && looksLikeFilePath(bold[1])) {
		return normalizeFilename(bold[1]);
	}

	const inline = line.match(/`([^`]+\.[a-z0-9]+)`/i);
	if (inline?.[1] && looksLikeFilePath(inline[1])) {
		return normalizeFilename(inline[1]);
	}

	return undefined;
}

/**
 * @param lines - Code block body lines.
 * @returns Filename and index where code content starts.
 */
function extractFilenameFromBody(lines: string[]): { filename?: string; codeStart: number } {
	for (let i = 0; i < Math.min(lines.length, 6); i++) {
		const path = extractPathFromLine(lines[i] ?? '');
		if (path) {
			return { filename: path, codeStart: i + 1 };
		}
	}
	return { codeStart: 0 };
}

/**
 * @param preamble - Text appearing immediately before a fenced code block.
 * @returns Inferred filename, if any.
 */
function filenameFromPreamble(preamble: string): string | undefined {
	const tail = preamble.slice(-1200);
	const lines = tail.split('\n').reverse();
	for (const line of lines) {
		const path = extractPathFromLine(line);
		if (path) {
			return path;
		}
	}
	return undefined;
}

/**
 * @param text - Full response text.
 * @returns Ordered unique path mentions found in prose.
 */
function extractMentionedPaths(text: string): string[] {
	const found: string[] = [];
	const seen = new Set<string>();

	const add = (raw: string): void => {
		const path = normalizeFilename(raw);
		if (!looksLikeFilePath(path) || seen.has(path)) {
			return;
		}
		seen.add(path);
		found.push(path);
	};

	let match: RegExpExecArray | null;
	PATH_IN_TEXT_RE.lastIndex = 0;
	while ((match = PATH_IN_TEXT_RE.exec(text)) !== null) {
		add(match[1]);
	}

	BACKTICK_PATH_RE.lastIndex = 0;
	while ((match = BACKTICK_PATH_RE.exec(text)) !== null) {
		add(match[1]);
	}

	LOOSE_PATH_RE.lastIndex = 0;
	while ((match = LOOSE_PATH_RE.exec(text)) !== null) {
		add(match[1]);
	}

	return found;
}

/**
 * @param tag - Fence tag string.
 * @param body - Code block body.
 * @returns Parsed block.
 */
function parseBlockBody(tag: string, body: string): ParsedCodeBlock {
	const language = tag.split(':')[0]?.trim() || 'plaintext';
	const lines = body.replace(/\r\n/g, '\n').split('\n');
	const fromTag = filenameFromFenceTag(tag);
	const { filename: fromBody, codeStart } = extractFilenameFromBody(lines);

	return {
		filename: fromBody ?? fromTag,
		language,
		code: lines.slice(codeStart).join('\n').trimEnd(),
	};
}

/**
 * Parses unfenced sections that start with // filename: headers (Qwen raw output).
 * @param source - Response text.
 * @returns Parsed blocks without fences.
 */
function parseUnfencedFileSections(source: string): ParsedCodeBlock[] {
	const blocks: ParsedCodeBlock[] = [];
	const headerPatterns = [
		/(?:^|\n)\/\/\s*(?:filename|file|path)\s*:\s*(.+)\r?\n/g,
		/(?:^|\n)\/\/\s*([\w./@-]+\.[a-z0-9]+)\s*\r?\n/g,
	];

	for (const headerRe of headerPatterns) {
		const matches = [...source.matchAll(headerRe)];
		if (matches.length === 0) {
			continue;
		}

		for (let i = 0; i < matches.length; i++) {
			const m = matches[i];
			const filename = normalizeFilename(m[1]);
			if (!looksLikeFilePath(filename)) {
				continue;
			}
			const start = (m.index ?? 0) + m[0].length;
			const end = i + 1 < matches.length ? (matches[i + 1].index ?? source.length) : source.length;
			let code = source.slice(start, end).trim();
			if (code.includes('```')) {
				continue;
			}
			// Stop at markdown section headers after the code
			const sectionBreak = code.search(/\n#{2,}\s+[A-Z]/);
			if (sectionBreak > 0) {
				code = code.slice(0, sectionBreak).trim();
			}
			if (code) {
				blocks.push({ filename, language: 'plaintext', code });
			}
		}

		if (blocks.length > 0) {
			return blocks;
		}
	}

	return blocks;
}

/**
 * Assigns filenames to blocks using hints and mentioned paths.
 * @param blocks - Parsed blocks (mutated in place).
 * @param options - Parsing options.
 * @param source - Full source text for path mention extraction.
 */
function resolveBlockFilenames(
	blocks: ParsedCodeBlock[],
	options: ParseCodeBlocksOptions,
	source: string,
): void {
	const mentioned = extractMentionedPaths(source);
	const hints = (options.hintFilenames ?? [])
		.map((f) => relativizePath(f, options.workspaceRoot))
		.filter(looksLikeFilePath);
	const pool = [...mentioned, ...hints.filter((h) => !mentioned.includes(h))];

	for (const block of blocks) {
		if (block.filename || !block.code.trim()) {
			continue;
		}
		const next = pool.shift();
		if (next) {
			block.filename = next;
		}
	}

	if (blocks.length === 1 && !blocks[0].filename && options.fallbackFilename) {
		blocks[0].filename = relativizePath(options.fallbackFilename, options.workspaceRoot);
	}
}

/**
 * Extracts code blocks from LLM responses (Qwen3 and generic formats).
 * @param text - Raw LLM response text.
 * @param options - Parsing options.
 * @returns Array of parsed code blocks.
 */
export function parseCodeBlocks(text: string, options: ParseCodeBlocksOptions = {}): ParsedCodeBlock[] {
	const source = stripNeuroCodeAppendix(text);
	const blocks: ParsedCodeBlock[] = [];
	const closedRe = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	let lastEnd = 0;

	while ((match = closedRe.exec(source)) !== null) {
		const preamble = source.slice(lastEnd, match.index);
		const block = parseBlockBody(match[1], match[2]);
		if (!block.filename) {
			block.filename = filenameFromPreamble(preamble);
		}
		if (block.code.trim()) {
			blocks.push(block);
		}
		lastEnd = match.index + match[0].length;
	}

	if (blocks.length === 0) {
		blocks.push(...parseUnfencedFileSections(source));
	}

	if (options.allowIncomplete) {
		const fenceCount = (source.match(/```/g) ?? []).length;
		if (fenceCount % 2 !== 0) {
			const lastOpen = source.lastIndexOf('```');
			const preamble = source.slice(lastEnd, lastOpen);
			const tail = source.slice(lastOpen + 3);
			const newline = tail.indexOf('\n');
			const tag = newline === -1 ? tail.trim() : tail.slice(0, newline).trim();
			const body = newline === -1 ? '' : tail.slice(newline + 1);
			if (tag || body.trim()) {
				const block = parseBlockBody(tag, body);
				if (!block.filename) {
					block.filename = filenameFromPreamble(preamble);
				}
				if (block.code.trim()) {
					blocks.push(block);
				}
			}
		}
	}

	resolveBlockFilenames(blocks, options, source);
	return blocks;
}

/**
 * Opens a diff editor comparing original file with proposed content.
 * @param originalUri - URI of the original file.
 * @param newContent - Proposed new file content.
 * @param title - Diff editor title.
 */
export async function showDiff(
	originalUri: vscode.Uri,
	newContent: string,
	title: string,
): Promise<void> {
	const rightDoc = await vscode.workspace.openTextDocument({
		content: newContent,
		language: originalUri.path.endsWith('.ts') ? 'typescript' : 'plaintext',
	});

	await vscode.commands.executeCommand(
		'vscode.diff',
		originalUri,
		rightDoc.uri,
		title,
	);
}

/**
 * Applies new content to a workspace file via WorkspaceEdit.
 * @param fileUri - Target file URI.
 * @param newContent - Full new file content.
 * @returns Whether the edit was applied.
 */
export async function applyEdit(fileUri: vscode.Uri, newContent: string): Promise<boolean> {
	const edit = new vscode.WorkspaceEdit();
	const doc = await vscode.workspace.openTextDocument(fileUri);
	const fullRange = new vscode.Range(
		doc.positionAt(0),
		doc.positionAt(doc.getText().length),
	);
	edit.replace(fileUri, fullRange, newContent);
	return vscode.workspace.applyEdit(edit);
}

/**
 * Ensures parent directories exist for a workspace-relative file path.
 * @param workspaceRoot - Workspace folder path.
 * @param filename - Relative file path.
 */
async function ensureParentDirectories(workspaceRoot: string, filename: string): Promise<void> {
	const parts = filename.replace(/\\/g, '/').split('/').filter(Boolean);
	if (parts.length <= 1) {
		return;
	}
	let current = vscode.Uri.file(workspaceRoot);
	for (let i = 0; i < parts.length - 1; i++) {
		current = vscode.Uri.joinPath(current, parts[i]);
		try {
			await vscode.workspace.fs.createDirectory(current);
		} catch {
			// directory may already exist
		}
	}
}

/**
 * Creates or overwrites a file in the workspace.
 * @param workspaceRoot - Workspace folder path.
 * @param filename - Relative path from LLM output.
 * @param content - Full file content.
 * @returns Whether the file was created, updated, or failed.
 */
export async function createOrApplyFile(
	workspaceRoot: string,
	filename: string,
	content: string,
): Promise<'created' | 'updated' | 'failed'> {
	const uri = resolveFileUri(filename, workspaceRoot);
	if (!uri) {
		return 'failed';
	}

	await ensureParentDirectories(workspaceRoot, filename);
	const encoder = new TextEncoder();

	try {
		await vscode.workspace.fs.stat(uri);
		const applied = await applyEdit(uri, content);
		if (applied) {
			await saveWorkspaceUri(uri);
		}
		return applied ? 'updated' : 'failed';
	} catch {
		try {
			await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
			await saveWorkspaceUri(uri);
			return 'created';
		} catch {
			return 'failed';
		}
	}
}

/** Result of applying multiple code blocks. */
export interface ApplyBlocksResult {
	applied: Array<{ file: string; action: 'created' | 'updated' }>;
	failed: string[];
	unresolved: number;
}

/**
 * Applies all code blocks from an LLM response to the workspace.
 * @param text - Raw LLM response.
 * @param workspaceRoot - Workspace folder path.
 * @param options - Parsing options.
 * @returns Summary of applied and failed files.
 */
export async function applyAllCodeBlocks(
	text: string,
	workspaceRoot: string,
	options: ParseCodeBlocksOptions = {},
): Promise<ApplyBlocksResult> {
	const blocks = parseCodeBlocks(text, {
		...options,
		workspaceRoot: options.workspaceRoot ?? workspaceRoot,
	});
	const applied: ApplyBlocksResult['applied'] = [];
	const failed: string[] = [];
	let unresolved = 0;

	for (const block of blocks) {
		if (!block.filename) {
			unresolved++;
			continue;
		}
		if (!block.code.trim()) {
			unresolved++;
			continue;
		}

		const result = await createOrApplyFile(workspaceRoot, block.filename, block.code);
		if (result === 'failed') {
			failed.push(block.filename);
		} else {
			applied.push({ file: block.filename, action: result });
		}
	}

	if (applied.length > 0) {
		await autoSaveAppliedFiles(applied, workspaceRoot);
	}

	return { applied, failed, unresolved };
}

/**
 * @returns Whether neurocode.chat.autoSave is enabled.
 */
export function isAutoSaveEnabled(): boolean {
	return vscode.workspace.getConfiguration('neurocode').get<boolean>('chat.autoSave', true);
}

/**
 * Saves an open workspace document if it has unsaved changes.
 * @param fileUri - Target file URI.
 * @returns Whether the file was saved or already clean.
 */
export async function saveWorkspaceUri(fileUri: vscode.Uri): Promise<boolean> {
	if (!isAutoSaveEnabled()) {
		return false;
	}

	const doc = vscode.workspace.textDocuments.find(
		(d) => d.uri.toString() === fileUri.toString(),
	);
	if (!doc) {
		return true;
	}
	if (!doc.isDirty) {
		return true;
	}
	return doc.save();
}

/**
 * Auto-saves files NeuroCode just applied (open dirty buffers only).
 * @param applied - Relative paths written to the workspace.
 * @param workspaceRoot - Workspace folder path.
 * @returns Number of files saved.
 */
export async function autoSaveAppliedFiles(
	applied: Array<{ file: string }>,
	workspaceRoot: string,
): Promise<number> {
	if (!isAutoSaveEnabled() || applied.length === 0) {
		return 0;
	}

	let saved = 0;
	for (const { file } of applied) {
		const uri = resolveFileUri(file, workspaceRoot);
		if (!uri) {
			continue;
		}
		if (await saveWorkspaceUri(uri)) {
			saved += 1;
		}
	}
	return saved;
}

/**
 * Resolves a filename from LLM output to a workspace URI.
 * @param filename - Relative or absolute path from code block.
 * @param workspaceRoot - Workspace folder path.
 * @returns Resolved URI or undefined.
 */
export function resolveFileUri(filename: string, workspaceRoot: string): vscode.Uri | undefined {
	if (!filename) {
		return undefined;
	}
	const normalized = normalizeFilename(filename);
	if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith('/')) {
		const root = workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
		const lower = normalized.toLowerCase();
		if (lower.startsWith(`${root}/`)) {
			return vscode.Uri.file(normalized);
		}
		return vscode.Uri.file(normalized);
	}
	return vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), normalized);
}
