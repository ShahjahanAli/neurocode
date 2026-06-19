import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { EmbeddingService } from './EmbeddingService.js';
import { VectorStore } from '../vector/VectorStore.js';
import {
	walkProjectFiles, indexFile, extractImportPaths, extractSymbols, storeDependencies, storeSymbols,
} from './CodeGraph.js';

/**
 * Shared index across multiple repositories.
 */
export class CrossRepoIndexer {
	/**
	 * @param {string} sharedIndexPath
	 * @param {import('node:sqlite').DatabaseSync} db
	 */
	constructor(sharedIndexPath, db) {
		this.sharedIndexPath = sharedIndexPath;
		this.db = db;
		this.vectorStore = new VectorStore();
	}

	async init() {
		fs.mkdirSync(this.sharedIndexPath, { recursive: true });
		await this.vectorStore.init(path.join(this.sharedIndexPath, 'vectors'));
	}

	/**
	 * @param {string} projectPath
	 * @param {string} projectId
	 * @param {string} projectName
	 */
	async registerRepo(projectPath, projectId, projectName) {
		let fileCount = 0;
		const exclude = JSON.parse(process.env.NEUROCODE_INDEX_EXCLUDE || '[]');

		for await (const filePath of walkProjectFiles(projectPath, exclude)) {
			const { fileId, content, language } = indexFile(filePath, projectPath, this.db);
			const imports = extractImportPaths(content, language, filePath, projectPath);
			storeDependencies(fileId, imports, this.db);
			storeSymbols(fileId, extractSymbols(content, language), this.db);

			const snippet = content.slice(0, 2000);
			try {
				const vec = await EmbeddingService.embed(snippet);
				await this.vectorStore.addItem(`${projectId}:${filePath}`, vec, {
					file: filePath,
					relativeFile: path.relative(projectPath, filePath),
					content: snippet,
					projectId,
					projectName,
				});
			} catch {
				// skip embedding
			}
			fileCount++;
		}

		this.db.prepare(`
			INSERT INTO registered_repos (id, name, path, file_count, last_indexed)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET file_count = excluded.file_count, last_indexed = excluded.last_indexed
		`).run(projectId, projectName, projectPath, fileCount, Date.now());

		return { fileCount };
	}

	/**
	 * @param {string} query
	 * @param {number} topK
	 * @param {string} [excludeProjectPath]
	 */
	async searchAcrossRepos(query, topK = 3, excludeProjectPath = '') {
		const emb = await EmbeddingService.embed(query);
		const results = await this.vectorStore.query(emb, topK * 2);

		return results
			.filter((r) => {
				if (!excludeProjectPath) {
					return true;
				}
				const file = r.item.metadata?.file;
				return !String(file).startsWith(excludeProjectPath);
			})
			.slice(0, topK)
			.map((r) => ({
				file: r.item.metadata?.file,
				relativeFile: r.item.metadata?.relativeFile,
				content: r.item.metadata?.content,
				projectName: r.item.metadata?.projectName,
				tokenCount: Math.ceil(String(r.item.metadata?.content).length / 4),
				score: r.score,
			}));
	}

	list() {
		return this.db.prepare('SELECT * FROM registered_repos ORDER BY last_indexed DESC').all();
	}
}
