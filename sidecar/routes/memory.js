import { Router } from 'express';
import { services } from '../core/services.js';

const router = Router();

router.post('/record', async (req, res) => {
	try {
		if (!services.memoryGraph) {
			return res.status(503).json({ success: false, error: 'Memory not initialized' });
		}

		const {
			taskDescription,
			filesEdited,
			diffAccepted,
			latencyMs,
			modelUsed,
			provider,
		} = req.body ?? {};

		const memoryId = await services.memoryGraph.record({
			taskDescription,
			filesEdited,
			diffAccepted,
			latencyMs,
			modelUsed,
			provider,
		});

		res.json({ success: true, data: { memoryId } });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

router.get('/query', async (req, res) => {
	try {
		const { task, topK } = req.query;
		const memories = await services.memoryGraph.query(String(task), parseInt(String(topK || '5'), 10));
		res.json({ success: true, data: { memories } });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

router.get('/top', (req, res) => {
	try {
		const limit = parseInt(String(req.query.limit || '20'), 10);
		const memories = services.memoryGraph.top(limit);
		res.json({ success: true, data: { memories } });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

router.delete('/:memoryId', (req, res) => {
	try {
		services.memoryGraph.delete(req.params.memoryId);
		res.json({ success: true, data: { deleted: true } });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

export default router;
