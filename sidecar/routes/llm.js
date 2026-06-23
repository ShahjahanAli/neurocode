import { Router } from 'express';
import { LLMRouter } from '../core/LLMRouter.js';
import { resolveModelId } from '../core/ModelSelector.js';

const router = Router();

router.get('/models', async (_req, res) => {
	try {
		const models = await LLMRouter.listModels();
		const cfg = LLMRouter._readEnvConfig();
		res.json({
			success: true,
			data: {
				models,
				mode: cfg.mode,
				defaultModel: cfg.model,
				provider: LLMRouter.getActiveProvider(),
			},
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

router.post('/resolve', async (req, res) => {
	try {
		const {
			modelSelection = 'auto',
			selectedModel,
			task = '',
			chatMode = 'auto',
			intent,
		} = req.body ?? {};

		const models = await LLMRouter.listModels();
		const cfg = LLMRouter._readEnvConfig();
		const model = resolveModelId(models, {
			modelSelection,
			selectedModel,
			task,
			chatMode,
			intent,
			defaultModel: cfg.model,
		});

		res.json({
			success: true,
			data: {
				model,
				auto: modelSelection !== 'manual',
				candidates: models.map((m) => m.id),
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
