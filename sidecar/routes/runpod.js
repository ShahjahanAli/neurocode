import { Router } from 'express';
import { runpodManager } from '../server.js';
import { services } from '../core/services.js';

const router = Router();

router.get('/status', async (_req, res) => {
	if (!runpodManager) {
		return res.json({ success: true, data: { podState: 'not-configured' } });
	}
	const status = await runpodManager.getStatus();
	res.json({ success: true, data: status });
});

router.post('/start', async (_req, res) => {
	if (!runpodManager) {
		return res.status(400).json({ success: false, error: 'RunPod not configured' });
	}
	runpodManager.start().catch((err) => console.error('[runpod/start]', err));
	res.json({ success: true, data: { podState: 'starting' } });
});

router.post('/stop', async (_req, res) => {
	if (!runpodManager) {
		return res.status(400).json({ success: false, error: 'RunPod not configured' });
	}
	runpodManager.stop().catch((err) => console.error('[runpod/stop]', err));
	res.json({ success: true, data: { podState: 'stopping' } });
});

router.post('/warmup', async (_req, res) => {
	if (!runpodManager) {
		return res.status(400).json({ success: false, error: 'RunPod not configured' });
	}
	const result = await runpodManager.warmup();
	res.json({ success: true, data: result });
});

router.get('/cost', async (_req, res) => {
	if (!runpodManager) {
		return res.json({ success: true, data: { estimatedCostUsd: 0 } });
	}
	const status = await runpodManager.getStatus();
	const session = services.db?.prepare(`
		SELECT SUM(llm_calls) as calls FROM runpod_sessions WHERE stopped_at IS NULL OR stopped_at > ?
	`).get(Date.now() - 86400000);

	res.json({
		success: true,
		data: {
			sessionMinutes: status.sessionMinutes,
			estimatedCostUsd: status.estimatedCostUsd,
			llmCalls: session?.calls ?? 0,
			currency: 'USD',
		},
	});
});

router.get('/sessions', (_req, res) => {
	if (!services.db) {
		return res.json({ success: true, data: { sessions: [] } });
	}
	const sessions = services.db.prepare(`
		SELECT id, pod_id, started_at, stopped_at, cost_per_hr, llm_calls, tokens_generated
		FROM runpod_sessions ORDER BY started_at DESC LIMIT 50
	`).all();

	const enriched = sessions.map((s) => {
		const durationMin = s.stopped_at
			? Math.round((s.stopped_at - s.started_at) / 60000)
			: Math.round((Date.now() - s.started_at) / 60000);
		const cost = (durationMin / 60) * (s.cost_per_hr || 0.44);
		return { ...s, durationMin, estimatedCostUsd: cost };
	});

	res.json({ success: true, data: { sessions: enriched } });
});

export default router;
