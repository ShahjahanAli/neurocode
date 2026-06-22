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
}

const FILE_HEADER_RE =
	/^\s*(?:\/\/|#)\s*(?:filename|file|path)\s*:\s*(.+?)\s*$/i;
const BLOCK_COMMENT_HEADER_RE =
	/^\s*\/\*\s*(?:filename|file|path)\s*:\s*(.+?)\s*\*\/\s*$/i;

/**
 * Removes NeuroCode status appendices from a stored assistant message.
 * @param text - Assistant message text.
 * @returns LLM source text suitable for parsing.
 */
export function stripNeuroCodeAppendix(text: string): string {
	const markers = [
		'\n---\n**Applied to your project:**',
		'\n---\n**Note:**',
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
		.replace(/^\.\//, '');
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

	const afterColon = trimmed.includes(':')
		? trimmed.split(':').slice(1).join(':').trim()
		: trimmed;

	if (
		/\/|\\/.test(afterColon) ||
		/\.(tsx?|jsx?|py|go|rs|java|php|vue|svelte|css|scss|json|md)$/i.test(afterColon)
	) {
		return normalizeFilename(afterColon);
	}

	return undefined;
}

/**
 * @param lines - Code block body lines.
 * @returns Filename and index where code content starts.
 */
function extractFilenameFromBody(lines: string[]): { filename?: string; codeStart: number } {
	for (let i = 0; i < Math.min(lines.length, 4); i++) {
		const line = lines[i] ?? '';
		const slash = line.match(FILE_HEADER_RE);
		if (slash) {
			return { filename: normalizeFilename(slash[1]), codeStart: i + 1 };
		}
		const block = line.match(BLOCK_COMMENT_HEADER_RE);
		if (block) {
			return { filename: normalizeFilename(block[1]), codeStart: i + 1 };
		}
	}
	return { codeStart: 0 };
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
 * Extracts code blocks from LLM responses (Qwen3 and generic formats).
 * @param text - Raw LLM response text.
 * @param options - Parsing options.
 * @returns Array of parsed code blocks.
 */
export function parseCodeBlocks(text: string, options: ParseCodeBlocksOptions = {}): ParsedCodeBlock[] {
	const source = stripNeuroCodeAppendix(text);
	const blocks: ParsedCodeBlock[] = [];
	const closedRe = /```([^\n`]*)\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;

	while ((match = closedRe.exec(source)) !== null) {
		blocks.push(parseBlockBody(match[1], match[2]));
	}

	if (options.allowIncomplete) {
		const fenceCount = (source.match(/```/g) ?? []).length;
		if (fenceCount % 2 !== 0) {
			const lastOpen = source.lastIndexOf('```');
			const tail = source.slice(lastOpen + 3);
			const newline = tail.indexOf('\n');
			const tag = newline === -1 ? tail.trim() : tail.slice(0, newline).trim();
			const body = newline === -1 ? '' : tail.slice(newline + 1);
			if (tag || body.trim()) {
				blocks.push(parseBlockBody(tag, body));
			}
		}
	}

	if (blocks.length === 1 && !blocks[0].filename && options.fallbackFilename) {
		blocks[0].filename = normalizeFilename(options.fallbackFilename);
	}

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
		await applyEdit(uri, content);
		return 'updated';
	} catch {
		try {
			await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
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
	const blocks = parseCodeBlocks(text, options);
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

	return { applied, failed, unresolved };
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
	if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
		return vscode.Uri.file(normalized);
	}
	return vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), normalized);
}
