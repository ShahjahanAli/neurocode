import * as vscode from 'vscode';

/** Parsed code block from LLM output. */
export interface ParsedCodeBlock {
	filename?: string;
	language: string;
	code: string;
}

/**
 * Extracts code blocks from LLM responses (Qwen3 and generic formats).
 * @param text - Raw LLM response text.
 * @returns Array of parsed code blocks.
 */
export function parseCodeBlocks(text: string): ParsedCodeBlock[] {
	const blocks: ParsedCodeBlock[] = [];
	const re = /```(\w*)\n([\s\S]*?)```/g;
	let match;

	while ((match = re.exec(text)) !== null) {
		const language = match[1] || 'plaintext';
		const body = match[2];
		const lines = body.split('\n');
		let filename: string | undefined;
		let codeStart = 0;

		const fileLine = lines[0]?.match(/^\s*\/\/\s*(?:filename|file):\s*(.+)/i);
		if (fileLine) {
			filename = fileLine[1].trim();
			codeStart = 1;
		}

		blocks.push({
			filename,
			language,
			code: lines.slice(codeStart).join('\n').trim(),
		});
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
 * Resolves a filename from LLM output to a workspace URI.
 * @param filename - Relative or absolute path from code block.
 * @param workspaceRoot - Workspace folder path.
 * @returns Resolved URI or undefined.
 */
export function resolveFileUri(filename: string, workspaceRoot: string): vscode.Uri | undefined {
	if (!filename) {
		return undefined;
	}
	const normalized = filename.replace(/\\/g, '/');
	if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
		return vscode.Uri.file(normalized);
	}
	return vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), normalized);
}
