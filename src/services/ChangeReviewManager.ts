import * as vscode from 'vscode';
import {
	applyAllCodeBlocks,
	createOrApplyFile,
	parseCodeBlocks,
	resolveFileUri,
	showDiff,
	type ParseCodeBlocksOptions,
	type ParsedCodeBlock,
} from '../utils/DiffApplier';

/** Status of a single proposed file change. */
export type FileChangeStatus = 'pending' | 'accepted' | 'rejected';

/** One file in a change set. */
export interface PendingFileChange {
	file: string;
	status: FileChangeStatus;
	proposedUri?: string;
}

/** Summary sent to the chat webview. */
export interface ChangeReviewSummary {
	messageId: string;
	files: PendingFileChange[];
	reviewStatus: 'pending' | 'accepted' | 'rejected' | 'partial';
}

interface InternalChange {
	file: string;
	code: string;
	status: FileChangeStatus;
	proposedUri?: vscode.Uri;
}

interface ChangeSet {
	messageId: string;
	workspaceRoot: string;
	files: InternalChange[];
}

/**
 * Tracks proposed edits and powers Accept / Reject / Review (Cursor-style).
 */
export class ChangeReviewManager {
	private static readonly sets = new Map<string, ChangeSet>();
	private static activeDiffMessageId?: string;
	private static activeDiffFile?: string;

	/**
	 * Registers parsed code blocks as a pending change set for a chat message.
	 * @param messageId - Chat message id.
	 * @param blocks - Parsed code blocks from the LLM.
	 * @param workspaceRoot - Workspace folder path.
	 * @returns Review summary for the webview.
	 */
	static register(
		messageId: string,
		blocks: ParsedCodeBlock[],
		workspaceRoot: string,
	): ChangeReviewSummary {
		const files: InternalChange[] = blocks
			.filter((b) => b.filename && b.code.trim())
			.map((b) => ({
				file: b.filename!,
				code: b.code,
				status: 'pending' as FileChangeStatus,
			}));

		if (files.length === 0) {
			this.sets.delete(messageId);
			void this.syncContext();
			return { messageId, files: [], reviewStatus: 'pending' };
		}

		this.sets.set(messageId, { messageId, workspaceRoot, files });
		void this.syncContext();
		return this.toSummary(messageId);
	}

	/**
	 * @param messageId - Chat message id.
	 * @param text - Raw assistant text.
	 * @param workspaceRoot - Workspace root.
	 * @param options - Parse options.
	 * @returns Review summary.
	 */
	static registerFromText(
		messageId: string,
		text: string,
		workspaceRoot: string,
		options: ParseCodeBlocksOptions = {},
	): ChangeReviewSummary {
		const blocks = parseCodeBlocks(text, { ...options, workspaceRoot });
		return this.register(messageId, blocks, workspaceRoot);
	}

	/**
	 * Marks files as accepted after auto-apply.
	 * @param messageId - Chat message id.
	 * @param appliedFiles - Files written by auto-apply.
	 */
	static markAutoApplied(
		messageId: string,
		appliedFiles: Array<{ file: string }>,
	): ChangeReviewSummary | undefined {
		const set = this.sets.get(messageId);
		if (!set) {
			return undefined;
		}
		const applied = new Set(appliedFiles.map((f) => f.file));
		for (const f of set.files) {
			if (applied.has(f.file)) {
				f.status = 'accepted';
			}
		}
		void this.closeDiffsForMessage(messageId);
		void this.syncContext();
		return this.toSummary(messageId);
	}

	/**
	 * Opens side-by-side diff for one file (or the first pending file).
	 * @param messageId - Chat message id.
	 * @param file - Optional relative file path.
	 */
	static async review(messageId: string, file?: string): Promise<void> {
		const set = this.sets.get(messageId);
		if (!set) {
			void vscode.window.showWarningMessage('NeuroCode: No pending changes for this message.');
			return;
		}

		const target = this.resolveTargetFile(set, file);
		if (!target) {
			void vscode.window.showWarningMessage('NeuroCode: No file to review.');
			return;
		}

		const originalUri = resolveFileUri(target.file, set.workspaceRoot);
		if (!originalUri) {
			void vscode.window.showWarningMessage(`NeuroCode: Could not resolve path: ${target.file}`);
			return;
		}

		let original = originalUri;
		try {
			await vscode.workspace.fs.stat(originalUri);
		} catch {
			const empty = await vscode.workspace.openTextDocument({
				content: '',
				language: languageIdForPath(target.file),
			});
			original = empty.uri;
		}

		const proposed = await vscode.workspace.openTextDocument({
			content: target.code,
			language: languageIdForPath(target.file),
		});
		target.proposedUri = proposed.uri;
		this.activeDiffMessageId = messageId;
		this.activeDiffFile = target.file;
		void this.syncContext();

		await vscode.commands.executeCommand(
			'vscode.diff',
			original,
			proposed.uri,
			`NeuroCode: ${target.file}`,
			{ preview: false },
		);
	}

	/**
	 * Accepts one file or all pending files in a change set.
	 * @param messageId - Chat message id.
	 * @param file - Optional single file path.
	 * @returns Applied files and updated summary.
	 */
	static async accept(
		messageId: string,
		file?: string,
	): Promise<{ applied: Array<{ file: string; action: 'created' | 'updated' }>; summary: ChangeReviewSummary }> {
		const set = this.sets.get(messageId);
		if (!set) {
			return { applied: [], summary: { messageId, files: [], reviewStatus: 'pending' } };
		}

		const targets = file
			? set.files.filter((f) => f.file === file && f.status === 'pending')
			: set.files.filter((f) => f.status === 'pending');

		const applied: Array<{ file: string; action: 'created' | 'updated' }> = [];
		for (const target of targets) {
			const result = await createOrApplyFile(set.workspaceRoot, target.file, target.code);
			if (result === 'failed') {
				void vscode.window.showWarningMessage(`NeuroCode: Failed to apply ${target.file}`);
				continue;
			}
			target.status = 'accepted';
			applied.push({ file: target.file, action: result });
		}

		if (file) {
			await this.closeDiffForFile(messageId, file);
		} else {
			await this.closeDiffsForMessage(messageId);
		}

		void this.syncContext();
		const summary = this.toSummary(messageId);
		if (applied.length > 0) {
			void vscode.window.showInformationMessage(
				`NeuroCode: Accepted ${applied.length} file change(s)`,
			);
		}
		return { applied, summary };
	}

	/**
	 * Rejects one file or all pending files (discards without writing).
	 * @param messageId - Chat message id.
	 * @param file - Optional single file path.
	 * @returns Updated summary.
	 */
	static async reject(messageId: string, file?: string): Promise<ChangeReviewSummary> {
		const set = this.sets.get(messageId);
		if (!set) {
			return { messageId, files: [], reviewStatus: 'pending' };
		}

		const targets = file
			? set.files.filter((f) => f.file === file && f.status === 'pending')
			: set.files.filter((f) => f.status === 'pending');

		for (const target of targets) {
			target.status = 'rejected';
		}

		if (file) {
			await this.closeDiffForFile(messageId, file);
		} else {
			await this.closeDiffsForMessage(messageId);
		}

		void this.syncContext();
		const summary = this.toSummary(messageId);
		if (targets.length > 0) {
			void vscode.window.showInformationMessage(
				file
					? `NeuroCode: Rejected changes to ${file}`
					: `NeuroCode: Rejected ${targets.length} file change(s)`,
			);
		}
		return summary;
	}

	/**
	 * @returns Active diff editor target, if any.
	 */
	static getActiveDiff(): { messageId?: string; file?: string } {
		return {
			messageId: this.activeDiffMessageId,
			file: this.activeDiffFile,
		};
	}

	/**
	 * Accepts the file currently open in a NeuroCode diff editor.
	 * @returns Whether a change was applied.
	 */
	static async acceptActiveDiff(): Promise<boolean> {
		if (!this.activeDiffMessageId || !this.activeDiffFile) {
			return false;
		}
		const { applied } = await this.accept(this.activeDiffMessageId, this.activeDiffFile);
		return applied.length > 0;
	}

	/**
	 * Rejects the file currently open in a NeuroCode diff editor.
	 */
	static async rejectActiveDiff(): Promise<void> {
		if (!this.activeDiffMessageId || !this.activeDiffFile) {
			return;
		}
		await this.reject(this.activeDiffMessageId, this.activeDiffFile);
	}

	/**
	 * @param messageId - Chat message id.
	 * @returns Summary or undefined.
	 */
	static getSummary(messageId: string): ChangeReviewSummary | undefined {
		if (!this.sets.has(messageId)) {
			return undefined;
		}
		return this.toSummary(messageId);
	}

	/**
	 * Applies all blocks via DiffApplier (legacy accept-all path).
	 * @param text - LLM output.
	 * @param workspaceRoot - Workspace root.
	 * @param options - Parse options.
	 */
	static async acceptAllFromText(
		text: string,
		workspaceRoot: string,
		options: ParseCodeBlocksOptions = {},
	): Promise<{ applied: Array<{ file: string; action: 'created' | 'updated' }>; failed: string[] }> {
		const result = await applyAllCodeBlocks(text, workspaceRoot, options);
		return { applied: result.applied, failed: result.failed };
	}

	private static resolveTargetFile(set: ChangeSet, file?: string): InternalChange | undefined {
		if (file) {
			return set.files.find((f) => f.file === file);
		}
		return set.files.find((f) => f.status === 'pending') ?? set.files[0];
	}

	private static toSummary(messageId: string): ChangeReviewSummary {
		const set = this.sets.get(messageId);
		if (!set) {
			return { messageId, files: [], reviewStatus: 'pending' };
		}

		const files: PendingFileChange[] = set.files.map((f) => ({
			file: f.file,
			status: f.status,
			proposedUri: f.proposedUri?.toString(),
		}));

		const pending = files.filter((f) => f.status === 'pending').length;
		const accepted = files.filter((f) => f.status === 'accepted').length;
		const rejected = files.filter((f) => f.status === 'rejected').length;

		let reviewStatus: ChangeReviewSummary['reviewStatus'] = 'pending';
		if (pending === 0 && accepted > 0 && rejected === 0) {
			reviewStatus = 'accepted';
		} else if (pending === 0 && rejected > 0 && accepted === 0) {
			reviewStatus = 'rejected';
		} else if (pending === 0 && accepted > 0 && rejected > 0) {
			reviewStatus = 'partial';
		} else if (pending === 0 && files.length === 0) {
			reviewStatus = 'pending';
		}

		return { messageId, files, reviewStatus };
	}

	private static async closeDiffsForMessage(messageId: string): Promise<void> {
		const set = this.sets.get(messageId);
		if (!set) {
			return;
		}
		for (const f of set.files) {
			if (f.proposedUri) {
				await this.closeTabWithUri(f.proposedUri);
			}
		}
		if (this.activeDiffMessageId === messageId) {
			this.activeDiffMessageId = undefined;
			this.activeDiffFile = undefined;
		}
	}

	private static async closeDiffForFile(messageId: string, file: string): Promise<void> {
		const set = this.sets.get(messageId);
		const entry = set?.files.find((f) => f.file === file);
		if (entry?.proposedUri) {
			await this.closeTabWithUri(entry.proposedUri);
		}
		if (this.activeDiffMessageId === messageId && this.activeDiffFile === file) {
			this.activeDiffMessageId = undefined;
			this.activeDiffFile = undefined;
		}
		void this.syncContext();
	}

	private static async closeTabWithUri(uri: vscode.Uri): Promise<void> {
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				const input = tab.input;
				if (input instanceof vscode.TabInputTextDiff) {
					if (input.modified.toString() === uri.toString()
						|| input.original.toString() === uri.toString()) {
						await vscode.window.tabGroups.close(tab);
					}
				} else if (input instanceof vscode.TabInputText) {
					if (input.uri.toString() === uri.toString()) {
						await vscode.window.tabGroups.close(tab);
					}
				}
			}
		}
	}

	private static async syncContext(): Promise<void> {
		const hasPending = [...this.sets.values()].some((s) =>
			s.files.some((f) => f.status === 'pending'),
		);
		await vscode.commands.executeCommand('setContext', 'neurocode.hasPendingChanges', hasPending);
		await vscode.commands.executeCommand(
			'setContext',
			'neurocode.activeDiffChange',
			Boolean(this.activeDiffMessageId && this.activeDiffFile),
		);
	}
}

/**
 * @param filePath - Relative file path.
 * @returns VS Code language id for diff documents.
 */
function languageIdForPath(filePath: string): string {
	const lower = filePath.toLowerCase();
	if (lower.endsWith('.tsx')) {
		return 'typescriptreact';
	}
	if (lower.endsWith('.ts')) {
		return 'typescript';
	}
	if (lower.endsWith('.jsx')) {
		return 'javascriptreact';
	}
	if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
		return 'javascript';
	}
	if (lower.endsWith('.py')) {
		return 'python';
	}
	if (lower.endsWith('.json')) {
		return 'json';
	}
	if (lower.endsWith('.css')) {
		return 'css';
	}
	if (lower.endsWith('.html')) {
		return 'html';
	}
	if (lower.endsWith('.md')) {
		return 'markdown';
	}
	return 'plaintext';
}

// Re-export for diff from legacy path
export { showDiff };
