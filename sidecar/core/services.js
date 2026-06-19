/** Shared sidecar service instances — populated by server.js at startup. */
export const services = {
	db: null,
	vectorStore: null,
	shardManager: null,
	memoryGraph: null,
	runpodManager: null,
	crossRepoIndexer: null,
	driftDetector: null,
	genomeCollector: null,
	projectPath: '',
};
