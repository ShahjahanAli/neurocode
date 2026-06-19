import { Router } from 'express';
import { CausalDebugAgent } from '../core/CausalDebugAgent.js';
import { services } from '../core/services.js';

const router = Router();

router.post('/cause', async (req, res) => {
	try {
		const { stackTrace, errorMessage, projectPath } = req.body ?? {};
		if (!stackTrace || !projectPath) {
			return res.status(400).json({ success: false, error: 'stackTrace and projectPath required' });
		}

		const agent = new CausalDebugAgent(stackTrace, projectPath, errorMessage ?? '');
		const result = await agent.analyze(services);

		res.json({ success: true, data: result });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

router.get('/drift/status', (_req, res) => {
	try {
		const status = services.driftDetector?.getStatus() ?? { driftedFunctions: [] };
		res.json({ success: true, data: status });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

router.post('/drift/acknowledge/:alertId', (req, res) => {
	try {
		services.db.prepare(
			'UPDATE drift_alerts SET acknowledged = 1 WHERE id = ?',
		).run(req.params.alertId);
		res.json({ success: true, data: { acknowledged: true } });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

export default router;
