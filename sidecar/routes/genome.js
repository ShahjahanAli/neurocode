import { Router } from 'express';
import { services } from '../core/services.js';

const router = Router();

router.post('/consent', (req, res) => {
	const { accepted } = req.body ?? {};
	services.genomeCollector?.setConsent(Boolean(accepted));
	res.json({ success: true, data: { accepted: Boolean(accepted) } });
});

router.get('/status', (_req, res) => {
	res.json({ success: true, data: services.genomeCollector?.getStatus() ?? { enabled: false, recordCount: 0 } });
});

router.get('/stats', (_req, res) => {
	res.json({ success: true, data: services.genomeCollector?.getStats() ?? {} });
});

router.post('/export', (_req, res) => {
	try {
		const path = services.genomeCollector?.export();
		res.json({ success: true, data: { exportPath: path } });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

export default router;
