/**
 * Lists and auto-selects LLM models (Cursor-style).
 */

/** @typedef {{ id: string, label?: string, owned_by?: string }} ListedModel */

/**
 * @param {string} id
 * @returns {number}
 */
function coderScore(id) {
	const lower = id.toLowerCase();
	let score = 0;
	if (lower.includes('coder')) score += 40;
	if (lower.includes('code')) score += 20;
	if (lower.includes('instruct')) score += 10;
	if (/(32b|70b|72b|34b)/.test(lower)) score += 25;
	if (/(14b|13b)/.test(lower)) score += 15;
	if (/(7b|8b)/.test(lower)) score += 8;
	if (/(mini|small|flash|haiku|lite)/.test(lower)) score -= 5;
	return score;
}

/**
 * @param {string} id
 * @returns {number}
 */
function fastScore(id) {
	const lower = id.toLowerCase();
	let score = 0;
	if (/(mini|small|flash|haiku|lite|7b|8b)/.test(lower)) score += 30;
	if (/(32b|70b|72b)/.test(lower)) score -= 15;
	if (lower.includes('embed')) score -= 100;
	return score;
}

/**
 * @param {string} task
 * @returns {'light' | 'code' | 'agent'}
 */
function inferWorkload(task) {
	const t = String(task ?? '').toLowerCase();
	if (/\b(agent|end to end|full feature|migrate entire|refactor whole)\b/.test(t)) {
		return 'agent';
	}
	if (/\b(implement|write|fix|add|create|update|patch|diff|code)\b/.test(t)) {
		return 'code';
	}
	return 'light';
}

/**
 * @param {ListedModel[]} models
 * @param {object} ctx
 * @param {'auto' | 'manual'} ctx.modelSelection
 * @param {string} [ctx.selectedModel]
 * @param {string} [ctx.task]
 * @param {string} [ctx.chatMode]
 * @param {string} [ctx.intent]
 * @param {string} [ctx.defaultModel]
 * @returns {string}
 */
export function resolveModelId(models, ctx) {
	const ids = models.map((m) => m.id).filter(Boolean);
	const fallback = ctx.defaultModel || ids[0] || '';

	if (ctx.modelSelection === 'manual' && ctx.selectedModel) {
		if (ids.includes(ctx.selectedModel)) {
			return ctx.selectedModel;
		}
		return ctx.selectedModel;
	}

	if (ids.length === 0) {
		return fallback;
	}

	const chatMode = ctx.chatMode ?? 'auto';
	const intent = ctx.intent;
	let workload = 'light';

	if (chatMode === 'agent' || intent === 'edit' && chatMode === 'implement') {
		workload = 'agent';
	} else if (chatMode === 'implement' || intent === 'edit') {
		workload = 'code';
	} else if (chatMode === 'plan') {
		workload = 'code';
	} else if (chatMode === 'explain') {
		workload = 'light';
	} else if (chatMode === 'auto') {
		workload = inferWorkload(ctx.task);
	}

	const ranked = [...ids].sort((a, b) => {
		const scoreA = workload === 'light' ? fastScore(a) : coderScore(a);
		const scoreB = workload === 'light' ? fastScore(b) : coderScore(b);
		if (scoreB !== scoreA) {
			return scoreB - scoreA;
		}
		if (a === ctx.defaultModel) return -1;
		if (b === ctx.defaultModel) return 1;
		return a.localeCompare(b);
	});

	return ranked[0] ?? fallback;
}
