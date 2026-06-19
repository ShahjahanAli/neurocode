import { Router } from 'express';
import { MultiAgentRunner, storeReviewSession } from '../core/MultiAgentRunner.js';
import { services } from '../core/services.js';
import { LLMRouter } from '../core/LLMRouter.js';

const router = Router();

router.post('/start', async (req, res) => {
	try {
		const { activeFile, projectPath } = req.body ?? {};
		if (!activeFile || !projectPath) {
			return res.status(400).json({ success: false, error: 'activeFile and projectPath required' });
		}

		if (services.runpodManager) {
			try {
				await services.runpodManager.ensureReady();
			} catch {
				// fallback
			}
		}

		const { shards } = await services.shardManager.assembleContext(
			'Review this file for issues',
			activeFile,
			projectPath,
			null,
			null,
		);

		const contextBlock = shards.map((s) => s.content).join('\n\n');
		const agents = JSON.parse(process.env.NEUROCODE_REVIEW_AGENTS || '["architect","security","performance","test"]');
		const results = await MultiAgentRunner.runAll(contextBlock, agents);
		const reviewId = storeReviewSession(services.db, activeFile, results);

		if (services.runpodManager) {
			services.runpodManager.resetIdleTimer();
		}

		res.json({
			success: true,
			data: {
				reviewId,
				agents,
				provider: LLMRouter.getActiveProvider(),
				results,
			},
		});
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

router.get('/:reviewId/stream', (req, res) => {
	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache');
	res.flushHeaders();

	const findings = services.db.prepare(
		'SELECT * FROM review_findings WHERE session_id = ?',
	).all(req.params.reviewId);

	for (const f of findings) {
		res.write(`data: ${JSON.stringify({ agentType: f.agent_type, status: 'done', result: f })}\n\n`);
	}
	res.write('data: [DONE]\n\n');
	res.end();
});

export default router;
