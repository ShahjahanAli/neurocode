import * as vscode from 'vscode';
import { ChangeReviewManager } from '../services/ChangeReviewManager';
import type { ChatPanelProvider } from '../panels/ChatPanel';

/**
 * Registers Accept / Reject change commands (diff editor toolbar).
 * @param context - Extension context.
 * @param chat - Chat panel for webview sync.
 */
export function registerChangeReview(
	context: vscode.ExtensionContext,
	chat: ChatPanelProvider,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('neurocode.acceptChange', async () => {
			const { messageId, file } = ChangeReviewManager.getActiveDiff();
			if (!messageId) {
				void vscode.window.showWarningMessage('NeuroCode: Open a change review diff first.');
				return;
			}
			const { applied, summary } = await ChangeReviewManager.accept(messageId, file);
			chat.syncChangeReview(messageId, summary, applied);
		}),
		vscode.commands.registerCommand('neurocode.rejectChange', async () => {
			const { messageId, file } = ChangeReviewManager.getActiveDiff();
			if (!messageId) {
				return;
			}
			const summary = await ChangeReviewManager.reject(messageId, file);
			chat.syncChangeReview(messageId, summary);
		}),
	);
}
