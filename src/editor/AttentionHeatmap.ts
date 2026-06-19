import * as vscode from 'vscode';
import type { AgentAskData } from '../sidecar/types';

interface LineRange {
	file: string;
	lineStart: number;
	lineEnd: number;
}

interface AttentionMap {
	inContext: LineRange[];
	cited: LineRange[];
	missed: LineRange[];
}

/**
 * Renders attention heatmap decorations in the editor gutter.
 */
export class AttentionHeatmap {
	private inContextDecoration: vscode.TextEditorDecorationType;
	private citedDecoration: vscode.TextEditorDecorationType;
	private missedDecoration: vscode.TextEditorDecorationType;
	private lastMap: AttentionMap | null = null;
	private lastFile: string | null = null;

	/**
	 * @param context - Extension context for resource paths.
	 */
	constructor(context: vscode.ExtensionContext) {
		this.inContextDecoration = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(124, 111, 247, 0.08)',
			isWholeLine: true,
			gutterIconPath: context.asAbsolutePath('media/gutter-in-context.svg'),
			gutterIconSize: '70%',
		});

		this.citedDecoration = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(124, 111, 247, 0.25)',
			isWholeLine: true,
			fontWeight: 'bold',
			gutterIconPath: context.asAbsolutePath('media/gutter-cited.svg'),
			gutterIconSize: '70%',
		});

		this.missedDecoration = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(255, 155, 74, 0.06)',
			isWholeLine: true,
			gutterIconPath: context.asAbsolutePath('media/gutter-missed.svg'),
			gutterIconSize: '70%',
		});
	}

	/**
	 * Applies attention decorations from an agent response.
	 * @param attentionMap - Map from sidecar /agent/ask response.
	 * @param activeFile - Current editor file path.
	 */
	apply(attentionMap: AgentAskData['attentionMap'], activeFile?: string): void {
		if (!attentionMap) {
			return;
		}

		this.lastMap = attentionMap;
		this.lastFile = activeFile ?? null;

		const editor = vscode.window.activeTextEditor;
		if (!editor || (activeFile && editor.document.uri.fsPath !== activeFile)) {
			return;
		}

		this.applyToEditor(editor, attentionMap);
	}

	/** Re-applies last map when switching editors. */
	reapplyIfNeeded(): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor || !this.lastMap || !this.lastFile) {
			return;
		}
		if (editor.document.uri.fsPath === this.lastFile) {
			this.applyToEditor(editor, this.lastMap);
		}
	}

	/** Removes all heatmap decorations. */
	clear(): void {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			editor.setDecorations(this.inContextDecoration, []);
			editor.setDecorations(this.citedDecoration, []);
			editor.setDecorations(this.missedDecoration, []);
		}
		this.lastMap = null;
		this.lastFile = null;
	}

	/** Disposes decoration types on extension deactivate. */
	dispose(): void {
		this.inContextDecoration.dispose();
		this.citedDecoration.dispose();
		this.missedDecoration.dispose();
	}

	/**
	 * @param editor - Active text editor.
	 * @param map - Attention line ranges.
	 */
	private applyToEditor(editor: vscode.TextEditor, map: AttentionMap): void {
		editor.setDecorations(this.inContextDecoration, this.toRanges(editor, map.inContext));
		editor.setDecorations(this.citedDecoration, this.toRanges(editor, map.cited));
		editor.setDecorations(this.missedDecoration, this.toRanges(editor, map.missed));
	}

	/**
	 * @param editor - Text editor.
	 * @param ranges - Line ranges for current file only.
	 */
	private toRanges(editor: vscode.TextEditor, ranges: LineRange[]): vscode.DecorationOptions[] {
		const file = editor.document.uri.fsPath;
		return ranges
			.filter((r) => r.file === file || r.file.endsWith(editor.document.fileName))
			.map((r) => ({
				range: new vscode.Range(r.lineStart - 1, 0, r.lineEnd - 1, Number.MAX_SAFE_INTEGER),
			}));
	}

	/**
	 * Highlights root cause line in red for debug agent.
	 * @param file - Absolute file path.
	 * @param line - 1-based line number.
	 */
	static highlightRootCause(file: string, line: number): void {
		const decoration = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(255, 74, 74, 0.3)',
			isWholeLine: true,
		});

		const editor = vscode.window.visibleTextEditors.find(
			(e) => e.document.uri.fsPath === file,
		);

		if (editor) {
			editor.setDecorations(decoration, [
				{ range: new vscode.Range(line - 1, 0, line - 1, Number.MAX_SAFE_INTEGER) },
			]);
		}
	}
}
