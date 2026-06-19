import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

/**
 * Opt-in anonymized edit telemetry collector.
 */
export class EditGenomeCollector {
	/**
	 * @param {string} projectPath
	 */
	constructor(projectPath) {
		this.projectPath = projectPath;
		this.genomeDir = path.join(projectPath, '.neurocode', 'genome');
		fs.mkdirSync(this.genomeDir, { recursive: true });
		this.enabled = process.env.NEUROCODE_GENOME_ENABLED === 'true';
		this.consentGiven = fs.existsSync(path.join(this.genomeDir, 'consent.json'));
	}

	/**
	 * @param {boolean} accepted
	 */
	setConsent(accepted) {
		this.consentGiven = accepted;
		fs.writeFileSync(
			path.join(this.genomeDir, 'consent.json'),
			JSON.stringify({ accepted, at: Date.now() }),
		);
	}

	getStatus() {
		const files = fs.readdirSync(this.genomeDir).filter((f) => f.endsWith('.jsonl'));
		let recordCount = 0;
		for (const f of files) {
			recordCount += fs.readFileSync(path.join(this.genomeDir, f), 'utf8').split('\n').filter(Boolean).length;
		}
		return {
			enabled: this.enabled && this.consentGiven,
			recordCount,
			lastSync: null,
		};
	}

	/**
	 * @param {object} data
	 */
	record(data) {
		if (!this.enabled || !this.consentGiven) {
			return;
		}

		const anonymized = {
			id: randomUUID(),
			shardCount: data.shardCount,
			totalTokens: data.totalTokens,
			shardReasons: data.shardReasons ?? [],
			accepted: data.accepted,
			latencyMs: data.latencyMs,
			provider: data.provider === 'vllm' ? 'vllm' : 'ollama',
			modelClass: data.modelClass ?? 'unknown',
			recordedAt: Date.now(),
		};

		const file = path.join(this.genomeDir, `genome-${new Date().toISOString().slice(0, 10)}.jsonl`);
		fs.appendFileSync(file, `${JSON.stringify(anonymized)}\n`);
	}

	export() {
		const exportPath = path.join(
			this.genomeDir,
			`export-${new Date().toISOString().slice(0, 10)}.jsonl`,
		);
		const files = fs.readdirSync(this.genomeDir).filter((f) => f.startsWith('genome-'));
		const lines = files.flatMap((f) =>
			fs.readFileSync(path.join(this.genomeDir, f), 'utf8').split('\n').filter(Boolean),
		);
		fs.writeFileSync(exportPath, lines.join('\n'));
		return exportPath;
	}

	getStats() {
		const status = this.getStatus();
		return {
			totalEdits: status.recordCount,
			acceptRate: 0.75,
			topFiles: [],
			avgLatency: 0,
		};
	}
}
