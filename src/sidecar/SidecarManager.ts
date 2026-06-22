import * as cp from 'child_process';
import * as vscode from 'vscode';
import { SidecarClient } from './SidecarClient';
import { getConfig } from '../utils/config';
import { logger } from '../utils/logger';

/**
 * Spawns and manages the NeuroCode Node.js sidecar child process.
 */
export class SidecarManager {
	private process: cp.ChildProcess | null = null;
	private restartAttempts = 0;
	private readonly maxRestarts = 3;

	/** HTTP client bound to the running sidecar instance. */
	public readonly client: SidecarClient;

	/**
	 * @param context - VS Code extension context for resolving bundled sidecar path.
	 */
	constructor(private readonly context: vscode.ExtensionContext) {
		const cfg = getConfig();
		this.client = new SidecarClient(`http://127.0.0.1:${cfg.sidecar.port}`);
	}

	/**
	 * Spawns the sidecar process and waits until /health responds.
	 * @returns Resolves when the sidecar is ready.
	 */
	async start(): Promise<void> {
		if (this.process) {
			return;
		}

		const cfg = getConfig();
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
		const sidecarUri = vscode.Uri.joinPath(this.context.extensionUri, 'sidecar', 'server.js');

		this.process = cp.spawn('node', [sidecarUri.fsPath], {
			cwd: workspaceRoot || undefined,
			env: {
				...process.env,
				NEUROCODE_PORT: String(cfg.sidecar.port),
				NEUROCODE_PROJECT: workspaceRoot,
				NEUROCODE_LLM_PROVIDER: cfg.llm.provider,
				NEUROCODE_OLLAMA_URL: cfg.llm.ollamaUrl,
				NEUROCODE_OLLAMA_MODEL: cfg.llm.ollamaModel,
				NEUROCODE_VLLM_URL: cfg.llm.vllmUrl,
				NEUROCODE_VLLM_KEY: cfg.llm.vllmApiKey,
				NEUROCODE_VLLM_MODEL: cfg.llm.vllmModel,
				NEUROCODE_LLM_FALLBACK: String(cfg.llm.fallbackToOllama),
				SHARD_MAX_TOKENS: String(cfg.shard.maxTokens),
				NEUROCODE_RUNPOD_KEY: cfg.runpod.apiKey,
				NEUROCODE_RUNPOD_POD_ID: cfg.runpod.podId,
				NEUROCODE_RUNPOD_AUTO_START: String(cfg.runpod.autoStart),
				NEUROCODE_RUNPOD_AUTO_STOP: String(cfg.runpod.autoStop),
				NEUROCODE_RUNPOD_IDLE_MS: String(cfg.runpod.idleTimeoutMinutes * 60 * 1000),
				NEUROCODE_AIRGAP: String(cfg.airgap.enabled),
				NEUROCODE_AIRGAP_AUDIT: String(cfg.airgap.auditLog),
				NEUROCODE_INDEX_EXCLUDE: JSON.stringify(cfg.indexing.excludePatterns),
				NEUROCODE_GENOME_ENABLED: String(cfg.genome.enabled),
				NEUROCODE_CROSSREPO_ENABLED: String(cfg.crossrepo.enabled),
				NEUROCODE_CROSSREPO_PATH: cfg.crossrepo.sharedIndexPath,
				NEUROCODE_DRIFT_THRESHOLD: String(cfg.drift.threshold),
				NEUROCODE_REVIEW_AGENTS: JSON.stringify(cfg.review.agents),
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		this.process.stdout?.on('data', (chunk: Buffer) => {
			logger.log(`[sidecar] ${chunk.toString().trimEnd()}`);
		});

		this.process.stderr?.on('data', (chunk: Buffer) => {
			logger.error(`[sidecar] ${chunk.toString().trimEnd()}`);
		});

		this.process.on('exit', (code) => {
			this.process = null;
			if (code !== 0 && code !== null && this.restartAttempts < this.maxRestarts) {
				this.restartAttempts++;
				logger.warn(
					`Sidecar exited (${code}), restarting (${this.restartAttempts}/${this.maxRestarts})...`,
				);
				setTimeout(() => {
					void this.start().catch((err: unknown) => {
						const msg = err instanceof Error ? err.message : String(err);
						logger.error(`Sidecar restart failed: ${msg}`);
					});
				}, 2000);
			}
		});

		await this.waitForHealth(10_000);
		this.restartAttempts = 0;
		logger.log('Sidecar ready');
	}

	/**
	 * Sends SIGTERM to the sidecar process.
	 */
	stop(): void {
		if (this.process) {
			this.process.kill('SIGTERM');
			this.process = null;
		}
	}

	/**
	 * Restarts the sidecar (e.g. when the workspace folder changes).
	 * @returns Resolves when the sidecar is ready again.
	 */
	async restart(): Promise<void> {
		this.stop();
		await this.start();
	}

	/**
	 * @returns Whether the sidecar process is running.
	 */
	isRunning(): boolean {
		return this.process !== null;
	}

	/**
	 * Polls /health until success or timeout.
	 * @param timeoutMs - Maximum wait time in milliseconds.
	 */
	private async waitForHealth(timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				const res = await this.client.health();
				if (res.success) {
					return;
				}
			} catch {
				// Sidecar not ready yet
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		throw new Error('NeuroCode sidecar failed to start within 10 seconds');
	}
}
