import express from 'express';
import fs from 'fs';
import path from 'path';
import { getDb, closeDb } from './db/sqlite.js';
import { LLMRouter } from './core/LLMRouter.js';
import { RunPodLifecycleManager } from './core/RunPodLifecycleManager.js';
import { ShardManager } from './core/ShardManager.js';
import { VectorStore } from './vector/VectorStore.js';
import { ProjectMemoryGraph } from './core/ProjectMemoryGraph.js';
import { CrossRepoIndexer } from './core/CrossRepoIndexer.js';
import { SemanticDriftDetector } from './core/SemanticDriftDetector.js';
import { EditGenomeCollector } from './genome/EditGenomeCollector.js';
import { AirGapModeManager } from './core/AirGapModeManager.js';
import { services } from './core/services.js';
import { countProjectFiles } from './core/pathUtils.js';
import { mountRoutes } from './routes/index.js';

const PORT = parseInt(process.env.NEUROCODE_PORT || '39291', 10);
const PROJECT_PATH = process.env.NEUROCODE_PROJECT || process.cwd();
const AIRGAP = process.env.NEUROCODE_AIRGAP === 'true';

export let runpodManager = null;

global.indexStatus = { done: false, fileCount: 0 };

if (AIRGAP && PROJECT_PATH) {
	const airgap = new AirGapModeManager(PROJECT_PATH, process.env.NEUROCODE_AIRGAP_AUDIT !== 'false');
	airgap.enforce();
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', async (req, res) => {
	try {
		const adapter = await LLMRouter.getAdapter().catch(() => null);
		const available = adapter ? await adapter.isAvailable().catch(() => false) : false;
		const modelInfo = available ? await adapter.getModelInfo().catch(() => null) : null;
		const provider = LLMRouter.getActiveProvider();
		const tokenBudget = LLMRouter.getTokenBudget();

		let podState = 'not-configured';
		let idleRemainingMs = null;
		if (runpodManager) {
			const podStatus = await runpodManager.getStatus().catch(() => ({ podState: 'unknown' }));
			podState = podStatus.podState;
			idleRemainingMs = podStatus.idleRemainingMs ?? null;
		} else if (provider === 'vllm' && available) {
			podState = 'direct-vllm';
		}

		const projectPath = String(req.query.projectPath ?? '');
		let fileCount = global.indexStatus?.fileCount ?? 0;
		let indexed = global.indexStatus?.done ?? false;
		if (projectPath && services.db) {
			fileCount = countProjectFiles(services.db, projectPath);
			indexed = fileCount > 0;
		}

		res.json({
			success: true,
			data: {
				status: 'ok',
				airgap: AIRGAP,
				provider,
				model: modelInfo,
				tokenBudget,
				podState,
				idleRemainingMs,
				indexed,
				fileCount,
			},
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

const db = getDb(PROJECT_PATH);
services.db = db;
services.projectPath = PROJECT_PATH;

const vectorStore = new VectorStore();
const vectorPath = path.join(PROJECT_PATH || process.cwd(), '.neurocode', 'vectors');
fs.mkdirSync(vectorPath, { recursive: true });
await vectorStore.init(vectorPath);
services.vectorStore = vectorStore;

services.shardManager = new ShardManager(db, vectorStore);

mountRoutes(app);

if (PROJECT_PATH) {
	services.memoryGraph = new ProjectMemoryGraph(PROJECT_PATH);
	services.genomeCollector = new EditGenomeCollector(PROJECT_PATH);
	services.driftDetector = new SemanticDriftDetector(PROJECT_PATH, db);
	services.driftDetector.start();
}

const sharedIndexPath = process.env.NEUROCODE_CROSSREPO_PATH;
if (sharedIndexPath && process.env.NEUROCODE_CROSSREPO_ENABLED === 'true') {
	services.crossRepoIndexer = new CrossRepoIndexer(sharedIndexPath, db);
	await services.crossRepoIndexer.init();
}

const POD_ID = process.env.NEUROCODE_RUNPOD_POD_ID;
const RUNPOD_KEY = process.env.NEUROCODE_RUNPOD_KEY;

if (POD_ID && RUNPOD_KEY && !AIRGAP) {
	runpodManager = new RunPodLifecycleManager({
		podId: POD_ID,
		apiKey: RUNPOD_KEY,
		vllmUrl: process.env.NEUROCODE_VLLM_URL || '',
		vllmApiKey: process.env.NEUROCODE_VLLM_KEY || '',
		idleTimeoutMs: parseInt(process.env.NEUROCODE_RUNPOD_IDLE_MS || '1800000', 10),
		autoStop: process.env.NEUROCODE_RUNPOD_AUTO_STOP !== 'false',
		db,
	});
	services.runpodManager = runpodManager;

	if (process.env.NEUROCODE_RUNPOD_AUTO_START === 'true') {
		runpodManager.start().catch((err) => {
			console.error('[RunPod] Auto-start failed:', err.message);
		});
	}
} else if (POD_ID && RUNPOD_KEY) {
	console.log('[RunPod] Pod configured but air-gap mode prevents lifecycle manager');
}

const server = app.listen(PORT, '127.0.0.1', () => {
	console.log(`[NeuroCode] Sidecar listening on 127.0.0.1:${PORT}`);
	console.log(`[NeuroCode] Project: ${PROJECT_PATH || '(none)'}`);
	console.log(`[NeuroCode] Air-gap: ${AIRGAP}`);
});

function shutdown() {
	console.log('[NeuroCode] Shutting down sidecar...');
	services.genomeCollector?.getStatus();
	services.driftDetector?.destroy();
	runpodManager?.destroy();
	services.memoryGraph?.close();
	closeDb();
	server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
