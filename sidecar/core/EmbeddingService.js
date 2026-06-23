import axios from 'axios';

const MODEL = 'nomic-embed-text';
const CACHE_MAX = 100;

/** @type {Map<string, number[]>} */
const cache = new Map();

/**
 * Embedding service — uses local Ollama (independent of chat LLM gateway).
 */
export class EmbeddingService {
	/**
	 * @returns {string}
	 */
	static get ollamaUrl() {
		return (process.env.NEUROCODE_OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
	}

	/**
	 * @param {string} text
	 * @returns {Promise<number[]>}
	 */
	static async embed(text) {
		const key = text.slice(0, 500);
		if (cache.has(key)) {
			return cache.get(key);
		}

		const res = await axios.post(
			`${EmbeddingService.ollamaUrl}/api/embed`,
			{ model: MODEL, input: text },
			{ timeout: 30_000 },
		);

		const vector = res.data.embeddings?.[0] ?? res.data.embedding;
		if (!vector) {
			throw new Error('Embedding failed — is nomic-embed-text pulled in Ollama?');
		}

		if (cache.size >= CACHE_MAX) {
			const first = cache.keys().next().value;
			cache.delete(first);
		}
		cache.set(key, vector);
		return vector;
	}

	/**
	 * @returns {Promise<boolean>}
	 */
	static async isAvailable() {
		try {
			const res = await axios.get(`${EmbeddingService.ollamaUrl}/api/tags`, { timeout: 5000 });
			return res.data.models?.some((m) =>
				m.name === MODEL || m.name.startsWith(`${MODEL}:`),
			);
		} catch {
			return false;
		}
	}
}

/**
 * Cosine distance between two vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosineDistance(a, b) {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const sim = dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
	return 1 - sim;
}
