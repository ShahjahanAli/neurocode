import fs from 'fs';

/**
 * Limits concurrent file reads during indexing and shard assembly.
 */
export class FileQueue {
	/**
	 * @param {number} [maxConcurrent]
	 */
	constructor(maxConcurrent = 4) {
		this.maxConcurrent = maxConcurrent;
		this.running = 0;
		/** @type {Array<{ filePath: string, encoding: BufferEncoding, resolve: (v: string) => void, reject: (e: Error) => void }>} */
		this.queue = [];
	}

	/**
	 * Queued UTF-8 file read.
	 * @param {string} filePath
	 * @param {BufferEncoding} [encoding]
	 * @returns {Promise<string>}
	 */
	readFile(filePath, encoding = 'utf8') {
		return new Promise((resolve, reject) => {
			this.queue.push({ filePath, encoding, resolve, reject });
			this._pump();
		});
	}

	_pump() {
		while (this.running < this.maxConcurrent && this.queue.length > 0) {
			const job = this.queue.shift();
			if (!job) {
				break;
			}
			this.running++;
			fs.readFile(job.filePath, job.encoding, (err, data) => {
				this.running--;
				if (err) {
					job.reject(err);
				} else {
					job.resolve(String(data));
				}
				this._pump();
			});
		}
	}
}

/** Shared queue for indexer and shard reads. */
export const fileQueue = new FileQueue(4);
