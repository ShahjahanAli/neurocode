import { Router } from 'express';
import { services } from '../core/services.js';

const router = Router();

router.get('/preview', async (req, res) => {
	try {
		const { task, activeFile, projectPath } = req.query;
		if (!task || !projectPath) {
			return res.status(400).json({ success: false, error: 'task and projectPath required' });
		}

		const result = await services.shardManager.assembleContext(
			String(task),
			activeFile ? String(activeFile) : undefined,
			String(projectPath),
			services.memoryGraph,
			services.crossRepoIndexer,
		);

		res.json({
			success: true,
			data: {
				shards: result.shards.map((s) => ({
					file: s.relativeFile,
					reason: s.reason,
					tokenCount: s.tokenCount,
					priority: s.priority,
				})),
				totalTokens: result.totalTokens,
				budget: result.budget,
				provider: result.provider,
			},
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

export default router;
