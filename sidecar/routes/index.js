import agentRoutes from './agent.js';
import indexerRoutes from './indexer.js';
import shardsRoutes from './shards.js';
import memoryRoutes from './memory.js';
import reviewRoutes from './review.js';
import debugRoutes from './debug.js';
import genomeRoutes from './genome.js';
import crossrepoRoutes from './crossrepo.js';
import runpodRoutes from './runpod.js';
import driftRoutes from './drift.js';

/**
 * Mounts all NeuroCode sidecar API routes on an Express app.
 * @param {import('express').Express} app
 */
export function mountRoutes(app) {
	app.use('/agent', agentRoutes);
	app.use('/index', indexerRoutes);
	app.use('/shards', shardsRoutes);
	app.use('/memory', memoryRoutes);
	app.use('/review', reviewRoutes);
	app.use('/debug', debugRoutes);
	app.use('/genome', genomeRoutes);
	app.use('/crossrepo', crossrepoRoutes);
	app.use('/runpod', runpodRoutes);
	app.use('/drift', driftRoutes);
}
