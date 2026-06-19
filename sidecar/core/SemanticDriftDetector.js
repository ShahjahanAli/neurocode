import fs from 'fs';
import path from 'path';
import chokidar from 'chokidar';
import { EmbeddingService, cosineDistance } from './EmbeddingService.js';

/**
 * Detects semantic drift in symbols after git commits.
 */
export class SemanticDriftDetector {
	/**
	 * @param {string} projectPath
	 * @param {import('node:sqlite').DatabaseSync} db
	 */
	constructor(projectPath, db) {
		this.projectPath = projectPath;
		this.db = db;
		this.threshold = parseFloat(process.env.NEUROCODE_DRIFT_THRESHOLD || '0.15');
		/** @type {import('chokidar').FSWatcher | null} */
		this.watcher = null;
	}

	start() {
		const commitMsg = path.join(this.projectPath, '.git', 'COMMIT_EDITMSG');
		const gitDir = path.join(this.projectPath, '.git');
		if (!fs.existsSync(gitDir)) {
			return;
		}

		this.watcher = chokidar.watch([commitMsg, path.join(gitDir, 'logs', 'HEAD')], {
			ignoreInitial: true,
		});

		this.watcher.on('change', () => {
			setTimeout(() => this.checkDrift(), 2000);
		});
	}

	async checkDrift() {
		const symbols = this.db.prepare(`
			SELECT s.id, s.name, s.signature, s.embedding, f.path
			FROM symbols s JOIN files f ON f.id = s.file_id
			WHERE s.embedding IS NOT NULL
		`).all();

		for (const sym of symbols) {
			try {
				const content = fs.readFileSync(sym.path, 'utf8');
				const newEmb = await EmbeddingService.embed(sym.signature || sym.name);
				const oldEmb = new Float32Array(sym.embedding.buffer);
				const dist = cosineDistance(newEmb, Array.from(oldEmb));

				if (dist > this.threshold) {
					this.db.prepare(`
						INSERT INTO drift_alerts (symbol_id, drift_score, detected_at)
						VALUES (?, ?, ?)
					`).run(sym.id, dist, Date.now());
				}
			} catch {
				// skip symbol
			}
		}
	}

	getStatus() {
		const rows = this.db.prepare(`
			SELECT da.drift_score, da.detected_at, s.name, f.path
			FROM drift_alerts da
			JOIN symbols s ON s.id = da.symbol_id
			JOIN files f ON f.id = s.file_id
			WHERE da.acknowledged = 0
			ORDER BY da.detected_at DESC
			LIMIT 50
		`).all();

		return {
			driftedFunctions: rows.map((r) => ({
				file: r.path,
				name: r.name,
				distance: r.drift_score,
				detectedAt: r.detected_at,
			})),
		};
	}

	destroy() {
		this.watcher?.close();
	}
}
