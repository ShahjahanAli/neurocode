import { Router } from 'express';
import { services } from '../core/services.js';

const router = Router();

router.get('/status', (_req, res) => {
	try {
		const status = services.driftDetector?.getStatus() ?? { driftedFunctions: [] };
		res.json({ success: true, data: status });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

router.post('/acknowledge/:alertId', (req, res) => {
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
