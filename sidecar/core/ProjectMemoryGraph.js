import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { EmbeddingService } from './EmbeddingService.js';

/**
 * Per-project persistent memory of accepted/rejected edits.
 */
export class ProjectMemoryGraph {
	/**
	 * @param {string} projectPath
	 */
	constructor(projectPath) {
		const neuroDir = path.join(projectPath, '.neurocode');
		fs.mkdirSync(neuroDir, { recursive: true });
		this.db = new DatabaseSync(path.join(neuroDir, 'memory.db'));
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS memory_records (
				id TEXT PRIMARY KEY,
				task_description TEXT NOT NULL,
				task_embedding BLOB,
				files_edited TEXT,
				diff_accepted INTEGER,
				weight REAL DEFAULT 1.0,
				model_used TEXT,
				provider TEXT,
				latency_ms INTEGER,
				created_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_memory_weight ON memory_records(weight DESC);
		`);
	}

	/**
	 * @param {object} record
	 */
	async record(record) {
		const id = randomUUID();
		let embedding = null;
		try {
			const vec = await EmbeddingService.embed(record.taskDescription);
			embedding = Buffer.from(new Float32Array(vec).buffer);
		} catch {
			// embeddings optional
		}

		const weight = record.diffAccepted ? 1.5 : 0.5;
		this.db.prepare(`
			INSERT INTO memory_records
			(id, task_description, task_embedding, files_edited, diff_accepted, weight, model_used, provider, latency_ms, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			id,
			record.taskDescription,
			embedding,
			JSON.stringify(record.filesEdited ?? []),
			record.diffAccepted ? 1 : 0,
			weight,
			record.modelUsed ?? '',
			record.provider ?? '',
			record.latencyMs ?? 0,
			Date.now(),
		);

		return id;
	}

	/**
	 * @param {string} task
	 * @param {number} topK
	 */
	async query(task, topK = 5) {
		const rows = this.db.prepare(
			'SELECT * FROM memory_records ORDER BY weight DESC LIMIT 100',
		).all();

		try {
			const taskEmb = await EmbeddingService.embed(task);
			const scored = rows.map((row) => {
				let score = row.weight;
				if (row.task_embedding) {
					const stored = new Float32Array(row.task_embedding.buffer);
					const dist = cosineSimilarity(taskEmb, Array.from(stored));
					score += dist;
				}
				return { ...row, score };
			});
			return scored.sort((a, b) => b.score - a.score).slice(0, topK);
		} catch {
			return rows.slice(0, topK);
		}
	}

	/**
	 * @param {number} limit
	 */
	top(limit = 20) {
		return this.db.prepare(
			'SELECT * FROM memory_records ORDER BY weight DESC, created_at DESC LIMIT ?',
		).all(limit);
	}

	/**
	 * @param {string} memoryId
	 */
	delete(memoryId) {
		this.db.prepare('DELETE FROM memory_records WHERE id = ?').run(memoryId);
	}

	close() {
		this.db.close();
	}
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}
