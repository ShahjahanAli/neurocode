import { LocalIndex } from 'vectra';

/**
 * Wrapper around vectra LocalIndex for semantic code search.
 */
export class VectorStore {
	constructor() {
		/** @type {LocalIndex | null} */
		this.index = null;
	}

	/**
	 * @param {string} indexPath - Directory for vector index files.
	 */
	async init(indexPath) {
		this.index = new LocalIndex(indexPath);
		const exists = await this.index.isIndexCreated();
		if (!exists) {
			await this.index.createIndex({ version: 1 });
		}
	}

	/**
	 * @param {string} id
	 * @param {number[]} vector
	 * @param {Record<string, unknown>} metadata
	 */
	async addItem(id, vector, metadata) {
		if (!this.index) {
			throw new Error('VectorStore not initialized');
		}
		await this.index.upsertItem({ id, vector, metadata });
	}

	/**
	 * @param {number[]} vector
	 * @param {number} topK
	 * @returns {Promise<Array<{item: import('vectra').IndexItem, score: number}>>}
	 */
	async query(vector, topK) {
		if (!this.index) {
			return [];
		}
		const results = await this.index.queryItems(vector, topK);
		return results.map((r) => ({ item: r.item, score: r.score }));
	}

	/**
	 * @param {string} id
	 */
	async deleteItem(id) {
		if (!this.index) {
			return;
		}
		try {
			await this.index.deleteItem(id);
		} catch {
			// item may not exist
		}
	}
}
