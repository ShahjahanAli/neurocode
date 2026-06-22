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

/**
 * Manages automatic and on-demand project indexing via the sidecar.
 */
export class AutoIndexer {
	private static inFlight = new Map<string, Promise<number>>();

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

		const currentCount = await AutoIndexer.getProjectFileCount(sidecar, projectPath);
		if (currentCount > 0) {
			return currentCount;
		}

		const job = AutoIndexer.runIndex(sidecar, projectPath, { ...options, silent: true });
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
	 * Kicks off background indexing for the first workspace folder, if any.
	 * @param sidecar - Sidecar manager.
	 * @param onProgress - Optional status-bar progress hook.
	 */
	static voidAutoIndexWorkspace(
		sidecar: SidecarManager,
		onProgress?: (progress: IndexProgress | null) => void,
	): void {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
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
				}
			})
			.catch((err: unknown) => {
				onProgress?.(null);
				const msg = err instanceof Error ? err.message : String(err);
				logger.warn(`Auto-index failed: ${msg}`);
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
		const res = await sidecar.client.get<{ indexed: boolean; fileCount: number }>(
			`/index/project-status?projectPath=${encodeURIComponent(projectPath)}`,
		);
		return res.data?.fileCount ?? 0;
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
				if (!options.silent) {
					void vscode.window.showInformationMessage(
						`NeuroCode: Indexed ${status.data.filesProcessed} files`,
					);
				}
				return status.data.filesProcessed;
			}
			if (status.data.status === 'failed') {
				throw new Error('Indexing failed');
			}
		}

		throw new Error('Indexing timed out');
	}
}
