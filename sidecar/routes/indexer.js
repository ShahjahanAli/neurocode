import { Router } from 'express';
import { randomUUID } from 'crypto';
import chokidar from 'chokidar';
import path from 'path';
import {
	walkProjectFiles,
	indexFile,
	extractImportPaths,
	extractSymbols,
	storeDependencies,
	storeSymbols,
} from '../core/CodeGraph.js';
import { EmbeddingService } from '../core/EmbeddingService.js';
import { services } from '../core/services.js';
import { countProjectFiles, normalizePathKey } from '../core/pathUtils.js';

const router = Router();

/** @type {Map<string, { status: string, filesProcessed: number, totalFiles: number }>} */
const jobs = new Map();

/** @type {import('chokidar').FSWatcher | null} */
let watcher = null;

/**
 * @param {string} projectPath
 */
function startWatcher(projectPath) {
	if (watcher) {
		watcher.close();
	}

	const exclude = JSON.parse(process.env.NEUROCODE_INDEX_EXCLUDE || '[]');
	watcher = chokidar.watch(projectPath, {
		ignored: exclude,
		ignoreInitial: true,
	});

	watcher.on('change', (filePath) => {
		void reindexFile(filePath, projectPath);
	});

	watcher.on('unlink', (filePath) => {
		services.db?.prepare('DELETE FROM files WHERE path = ?').run(filePath);
		void services.vectorStore?.deleteItem(filePath);
	});
}

/**
 * @param {string} filePath
 * @param {string} projectPath
 */
async function reindexFile(filePath, projectPath) {
	if (!services.db) {
		return;
	}

	const { fileId, content, language } = await indexFile(filePath, projectPath, services.db);
	const imports = extractImportPaths(content, language, filePath, projectPath);
	storeDependencies(fileId, imports, services.db);
	storeSymbols(fileId, extractSymbols(content, language), services.db);

	try {
		const snippet = content.slice(0, 2000);
		const vec = await EmbeddingService.embed(snippet);
		await services.vectorStore?.addItem(filePath, vec, {
			file: filePath,
			relativeFile: path.relative(projectPath, filePath).replace(/\\/g, '/'),
			content: snippet,
		});
	} catch {
		// embedding optional
	}
}

router.post('/', async (req, res) => {
	const { projectPath } = req.body ?? {};
	if (!projectPath) {
		return res.status(400).json({ success: false, error: 'projectPath required' });
	}
	if (!services.db) {
		return res.status(503).json({ success: false, error: 'Database not ready' });
	}

	const jobId = randomUUID();
	const exclude = JSON.parse(process.env.NEUROCODE_INDEX_EXCLUDE || '[]');

	const files = [];
	for await (const f of walkProjectFiles(projectPath, exclude)) {
		files.push(f);
	}

	jobs.set(jobId, { status: 'running', filesProcessed: 0, totalFiles: files.length });

	void (async () => {
		try {
			for (let i = 0; i < files.length; i++) {
				await reindexFile(files[i], projectPath);
				jobs.set(jobId, {
					status: 'running',
					filesProcessed: i + 1,
					totalFiles: files.length,
				});
			}

			const storedCount = countProjectFiles(services.db, projectPath);
			if (files.length > 0 && storedCount === 0) {
				jobs.set(jobId, {
					status: 'failed',
					filesProcessed: 0,
					totalFiles: files.length,
				});
				return;
			}

			jobs.set(jobId, {
				status: 'done',
				filesProcessed: storedCount || files.length,
				totalFiles: files.length,
			});
			global.indexStatus = {
				done: true,
				fileCount: storedCount || files.length,
				projectPath: normalizePathKey(projectPath),
			};
			startWatcher(projectPath);
		} catch (err) {
			jobs.set(jobId, {
				status: 'failed',
				filesProcessed: 0,
				totalFiles: files.length,
			});
			console.error('[indexer] Job failed:', err instanceof Error ? err.message : err);
		}
	})();

	res.json({ success: true, data: { jobId } });
});

router.get('/project-status', (req, res) => {
	try {
		const projectPath = String(req.query.projectPath ?? '');
		if (!projectPath || !services.db) {
			return res.json({ success: true, data: { indexed: false, fileCount: 0 } });
		}

		const fileCount = countProjectFiles(services.db, projectPath);
		res.json({
			success: true,
			data: {
				indexed: fileCount > 0,
				fileCount,
				projectPath: normalizePathKey(projectPath),
			},
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

router.get('/status/:jobId', (req, res) => {
	const job = jobs.get(req.params.jobId);
	if (!job) {
		return res.status(404).json({ success: false, error: 'Job not found' });
	}
	res.json({ success: true, data: job });
});

export default router;
