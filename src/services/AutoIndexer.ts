import * as vscode from 'vscode';
import type { SidecarManager } from '../sidecar/SidecarManager';
import { getConfig } from '../utils/config';
import { logger } from '../utils/logger';

/** Indexing progress callback payload. */
export interface IndexProgress {
	filesProcessed: number;
	totalFiles: number;
}

/** Options for background or interactive indexing. */
export interface IndexOptions {
	/** Fires on each poll while the index job runs. */
	onProgress?: (progress: IndexProgress) => void;
	/** When true, skips notification toasts (used for auto-index on open). */
	silent?: boolean;
}

const RETRY_DELAYS_MS = [0, 2000, 5000, 10000, 20000];

/**
 * Manages automatic and on-demand project indexing via the sidecar.
 */
export class AutoIndexer {
	private static inFlight = new Map<string, Promise<number>>();
	private static scheduled = new Set<string>();

	/**
	 * Indexes the workspace if it has no files in the sidecar DB yet.
	 * @param sidecar - Sidecar manager.
	 * @param projectPath - Absolute workspace root.
	 * @param options - Progress and notification options.
	 * @returns Number of files indexed.
	 */
	static async ensureIndexed(
		sidecar: SidecarManager,
		projectPath: string,
		options: IndexOptions = {},
	): Promise<number> {
		const cfg = getConfig();
		if (!cfg.indexing.autoIndex) {
			return AutoIndexer.getProjectFileCount(sidecar, projectPath);
		}

		const existing = AutoIndexer.inFlight.get(projectPath);
		if (existing) {
			return existing;
		}

		await AutoIndexer.waitForSidecar(sidecar);

		const currentCount = await AutoIndexer.getProjectFileCount(sidecar, projectPath);
		if (currentCount > 0) {
			return currentCount;
		}

		const job = AutoIndexer.runIndex(sidecar, projectPath, { ...options, silent: options.silent ?? true });
		AutoIndexer.inFlight.set(projectPath, job);
		try {
			return await job;
		} finally {
			AutoIndexer.inFlight.delete(projectPath);
		}
	}

	/**
	 * Starts indexing and waits until the job completes.
	 * @param sidecar - Sidecar manager.
	 * @param projectPath - Absolute workspace root.
	 * @param options - Progress and notification options.
	 * @returns Number of files indexed.
	 */
	static async runIndex(
		sidecar: SidecarManager,
		projectPath: string,
		options: IndexOptions = {},
	): Promise<number> {
		const existing = AutoIndexer.inFlight.get(projectPath);
		if (existing) {
			return existing;
		}

		const job = AutoIndexer.executeIndex(sidecar, projectPath, options);
		AutoIndexer.inFlight.set(projectPath, job);
		try {
			return await job;
		} finally {
			AutoIndexer.inFlight.delete(projectPath);
		}
	}

	/**
	 * Schedules background indexing with retries until the workspace and sidecar are ready.
	 * @param sidecar - Sidecar manager.
	 * @param onProgress - Optional status-bar progress hook.
	 * @param context - Extension context for disposable timers.
	 */
	static scheduleWorkspaceAutoIndex(
		sidecar: SidecarManager,
		onProgress?: (progress: IndexProgress | null) => void,
		context?: vscode.ExtensionContext,
	): void {
		const cfg = getConfig();
		if (!cfg.indexing.autoIndex) {
			return;
		}

		const folder = vscode.workspace.workspaceFolders?.[0];
		const scheduleKey = folder?.uri.fsPath.toLowerCase() ?? '';
		if (!scheduleKey || AutoIndexer.scheduled.has(scheduleKey)) {
			return;
		}
		AutoIndexer.scheduled.add(scheduleKey);

		let attempt = 0;
		const runAttempt = (): void => {
			const currentFolder = vscode.workspace.workspaceFolders?.[0];
			if (!currentFolder) {
				attempt++;
				if (attempt < RETRY_DELAYS_MS.length) {
					const timer = setTimeout(runAttempt, RETRY_DELAYS_MS[attempt]);
					context?.subscriptions.push({ dispose: () => clearTimeout(timer) });
				} else {
					AutoIndexer.scheduled.delete(scheduleKey);
				}
				return;
			}

			AutoIndexer.voidAutoIndexWorkspace(sidecar, onProgress, () => {
				AutoIndexer.scheduled.delete(scheduleKey);
			});
		};

		runAttempt();
	}

	/**
	 * Kicks off background indexing for the first workspace folder, if any.
	 * @param sidecar - Sidecar manager.
	 * @param onProgress - Optional status-bar progress hook.
	 * @param onComplete - Optional completion hook.
	 */
	static voidAutoIndexWorkspace(
		sidecar: SidecarManager,
		onProgress?: (progress: IndexProgress | null) => void,
		onComplete?: () => void,
	): void {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			onComplete?.();
			return;
		}

		const projectPath = folder.uri.fsPath;
		void AutoIndexer.ensureIndexed(sidecar, projectPath, {
			silent: true,
			onProgress,
		})
			.then((count) => {
				onProgress?.(null);
				if (count > 0) {
					logger.log(`NeuroCode auto-indexed ${count} files`);
					void vscode.window.setStatusBarMessage(
						`$(database) NeuroCode: Indexed ${count} files`,
						4000,
					);
				} else {
					logger.warn('Auto-index finished with 0 files — check sidecar logs');
				}
				onComplete?.();
			})
			.catch((err: unknown) => {
				onProgress?.(null);
				const msg = err instanceof Error ? err.message : String(err);
				logger.warn(`Auto-index failed: ${msg}`);
				void vscode.window.showWarningMessage(`NeuroCode: Auto-index failed — ${msg}`);
				onComplete?.();
			});
	}

	/**
	 * @param sidecar - Sidecar manager.
	 * @param projectPath - Absolute workspace root.
	 * @returns Indexed file count for this project.
	 */
	static async getProjectFileCount(
		sidecar: SidecarManager,
		projectPath: string,
	): Promise<number> {
		try {
			await AutoIndexer.waitForSidecar(sidecar, 5000);
			const res = await sidecar.client.get<{ indexed: boolean; fileCount: number }>(
				`/index/project-status?projectPath=${encodeURIComponent(projectPath)}`,
			);
			return res.data?.fileCount ?? 0;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn(`Project status check failed: ${msg}`);
			return 0;
		}
	}

	/**
	 * Waits until the sidecar health endpoint responds.
	 * @param sidecar - Sidecar manager.
	 * @param timeoutMs - Maximum wait time.
	 */
	static async waitForSidecar(sidecar: SidecarManager, timeoutMs = 15000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				const res = await sidecar.client.health();
				if (res.success) {
					return;
				}
			} catch {
				// Sidecar not ready yet
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		throw new Error('Sidecar not ready');
	}

	/**
	 * @param sidecar - Sidecar manager.
	 * @param projectPath - Absolute workspace root.
	 * @param options - Progress and notification options.
	 * @returns Number of files indexed.
	 */
	private static async executeIndex(
		sidecar: SidecarManager,
		projectPath: string,
		options: IndexOptions,
	): Promise<number> {
		await AutoIndexer.waitForSidecar(sidecar);

		const start = await sidecar.client.startIndex(projectPath);
		if (!start.success || !start.data?.jobId) {
			throw new Error(start.error ?? 'Failed to start indexing');
		}

		const jobId = start.data.jobId;
		for (let i = 0; i < 600; i++) {
			await new Promise((r) => setTimeout(r, 1000));
			const status = await sidecar.client.indexStatus(jobId);
			if (!status.success || !status.data) {
				throw new Error(status.error ?? 'Index status failed');
			}

			options.onProgress?.({
				filesProcessed: status.data.filesProcessed,
				totalFiles: status.data.totalFiles,
			});

			if (status.data.status === 'done') {
				const storedCount = await AutoIndexer.getProjectFileCount(sidecar, projectPath);
				const finalCount = storedCount > 0 ? storedCount : status.data.filesProcessed;
				if (finalCount === 0 && status.data.totalFiles > 0) {
					throw new Error('Indexing finished but no files were stored');
				}
				if (!options.silent) {
					void vscode.window.showInformationMessage(
						`NeuroCode: Indexed ${finalCount} files`,
					);
				}
				return finalCount;
			}
			if (status.data.status === 'failed') {
				throw new Error('Indexing failed');
			}
		}

		throw new Error('Indexing timed out');
	}
}
