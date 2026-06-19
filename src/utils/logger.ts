import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

/**
 * Returns the singleton NeuroCode output channel.
 * @returns VS Code output channel named "NeuroCode".
 */
function getChannel(): vscode.OutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel('NeuroCode');
	}
	return channel;
}

/**
 * Formats a log line with an ISO timestamp prefix.
 * @param level - Log severity label.
 * @param message - Message to log.
 * @returns Formatted log string.
 */
function formatLine(level: string, message: string): string {
	return `[${new Date().toISOString()}] [${level}] ${message}`;
}

/** NeuroCode extension logger writing to the Output panel. */
export const logger = {
	/**
	 * Writes an informational log line.
	 * @param message - Message to log.
	 */
	log(message: string): void {
		getChannel().appendLine(formatLine('INFO', message));
	},

	/**
	 * Writes a warning log line.
	 * @param message - Warning message.
	 */
	warn(message: string): void {
		getChannel().appendLine(formatLine('WARN', message));
	},

	/**
	 * Writes an error log line.
	 * @param message - Error message.
	 */
	error(message: string): void {
		getChannel().appendLine(formatLine('ERROR', message));
	},

	/**
	 * Shows the NeuroCode output channel in the editor.
	 */
	show(): void {
		getChannel().show(true);
	},
};
