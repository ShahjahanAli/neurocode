import { Router } from 'express';
import { services } from '../core/services.js';

const router = Router();

router.post('/register', async (req, res) => {
	try {
		const { projectPath, projectId, projectName } = req.body ?? {};
		if (!projectPath || !projectId) {
			return res.status(400).json({ success: false, error: 'projectPath and projectId required' });
		}

		const result = await services.crossRepoIndexer.registerRepo(
			projectPath,
			projectId,
			projectName ?? projectId,
		);

		res.json({ success: true, data: result });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

router.get('/list', (_req, res) => {
	try {
		const projects = services.crossRepoIndexer?.list() ?? [];
		res.json({ success: true, data: { projects } });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

router.post('/search', async (req, res) => {
	try {
		const { query, topK, excludeProjectId } = req.body ?? {};
		const results = await services.crossRepoIndexer.searchAcrossRepos(
			query,
			topK ?? 5,
			excludeProjectId,
		);
		res.json({ success: true, data: { results } });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

export default router;
