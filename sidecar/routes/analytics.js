import { Router } from 'express';
import { services } from '../core/services.js';

const router = Router();

router.get('/summary', (req, res) => {
	try {
		const hours = parseInt(String(req.query.hours ?? '24'), 10);
		const sinceMs = Date.now() - Math.max(1, hours) * 3_600_000;
		const summary = services.analytics?.getSummary(sinceMs) ?? {};
		res.json({ success: true, data: summary });
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

router.get('/recent', (req, res) => {
	try {
		const limit = Math.min(100, parseInt(String(req.query.limit ?? '25'), 10));
		const events = services.analytics?.getRecentEvents(limit) ?? [];
		res.json({ success: true, data: { events } });
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

router.get('/feedback', (req, res) => {
	try {
		const limit = Math.min(50, parseInt(String(req.query.limit ?? '15'), 10));
		const items = services.analytics?.getRecentFeedback(limit) ?? [];
		res.json({ success: true, data: { items } });
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

router.post('/feedback', (req, res) => {
	try {
		const {
			rating,
			comment,
			messageId,
			taskPreview,
			responsePreview,
			intent,
			provider,
			modelUsed,
			tokensUsed,
			latencyMs,
			diagnostics,
		} = req.body ?? {};

		if (!rating || !['positive', 'negative'].includes(rating)) {
			return res.status(400).json({ success: false, error: 'rating must be positive or negative' });
		}

		const id = services.analytics?.recordFeedback({
			rating,
			comment,
			messageId,
			taskPreview,
			responsePreview,
			intent,
			provider,
			modelUsed,
			tokensUsed,
			latencyMs,
			diagnostics,
		});

		res.json({ success: true, data: { feedbackId: id } });
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

export default router;
