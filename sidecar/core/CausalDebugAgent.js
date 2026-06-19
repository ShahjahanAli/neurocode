import { LLMRouter } from './LLMRouter.js';
import fs from 'fs';

const MAX_FRAMES = 15;

/**
 * Causal debug agent — stack trace to root cause analysis.
 */
export class CausalDebugAgent {
	/**
	 * @param {string} stackTrace
	 * @param {string} projectPath
	 * @param {string} [errorMessage]
	 */
	constructor(stackTrace, projectPath, errorMessage = '') {
		this.stackTrace = stackTrace;
		this.projectPath = projectPath;
		this.errorMessage = errorMessage;
	}

	/**
	 * @returns {Array<{frame: number, file: string, line: number, fn: string}>}
	 */
	parseStackTrace() {
		const frames = [];
		const lines = this.stackTrace.split('\n');

		const patterns = [
			/at\s+(\S+)\s+\(([^:]+):(\d+):(\d+)\)/,
			/at\s+([^:]+):(\d+):(\d+)/,
			/File\s+"([^"]+)",\s+line\s+(\d+)/,
		];

		for (const line of lines) {
			for (const re of patterns) {
				const m = line.match(re);
				if (m) {
					const file = m[2] ?? m[1];
					const lineNum = parseInt(m[3] ?? m[2], 10);
					if (file && !isNaN(lineNum)) {
						frames.push({
							frame: frames.length + 1,
							file: file.replace(/^file:\/\//, ''),
							line: lineNum,
							fn: m[1] ?? 'unknown',
						});
					}
					break;
				}
			}
			if (frames.length >= MAX_FRAMES) {
				break;
			}
		}

		return frames;
	}

	/**
	 * @param {{file: string, line: number}} frame
	 * @returns {string}
	 */
	buildFrameShard(frame) {
		try {
			const content = fs.readFileSync(frame.file, 'utf8');
			const lines = content.split('\n');
			const start = Math.max(0, frame.line - 11);
			const end = Math.min(lines.length, frame.line + 10);
			return lines.slice(start, end).join('\n').slice(0, 800);
		} catch {
			return `// Could not read ${frame.file}`;
		}
	}

	/**
	 * @param {import('../core/services.js').services} services
	 */
	async analyze(services) {
		if (services.runpodManager) {
			try {
				await services.runpodManager.ensureReady();
			} catch {
				// fallback to ollama
			}
		}

		const frames = this.parseStackTrace();
		const frameShards = frames.map((f) => ({
			...f,
			snippet: this.buildFrameShard(f),
		}));

		const chain = frameShards
			.map((f) => `Frame ${f.frame}: ${f.fn} at ${f.file}:${f.line}\n${f.snippet}`)
			.join('\n\n');

		const adapter = await LLMRouter.getAdapter();
		const response = await adapter.chat(
			[
				{
					role: 'system',
					content: `Analyze the stack trace and identify root cause.
Return JSON only: {
  "rootCauseFile": string,
  "rootCauseLine": number,
  "explanation": string,
  "fix": { "diff": string, "targetFile": string },
  "causalChain": [{ "frame": number, "file": string, "line": number, "contribution": string }]
}`,
				},
				{
					role: 'user',
					content: `Error: ${this.errorMessage}\n\nStack trace:\n${this.stackTrace}\n\nCode frames:\n${chain}`,
				},
			],
			{ temperature: 0.3, max_tokens: 1500 },
		);

		if (services.runpodManager) {
			services.runpodManager.resetIdleTimer();
		}

		const cleaned = response.replace(/```json\n?|\n?```/g, '').trim();
		try {
			return JSON.parse(cleaned);
		} catch {
			return {
				rootCauseFile: frames[frames.length - 1]?.file ?? '',
				rootCauseLine: frames[frames.length - 1]?.line ?? 0,
				explanation: response,
				fix: { diff: '', targetFile: '' },
				causalChain: frameShards.map((f) => ({
					frame: f.frame,
					file: f.file,
					line: f.line,
					contribution: f.fn,
				})),
			};
		}
	}
}
