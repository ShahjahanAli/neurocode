import {
	isFileReviewTask,
	shouldAutoFixOnCheck,
	buildAutoFixTask,
} from './FileReview.js';

/** @typedef {'chat' | 'plan' | 'edit'} ChatIntent */

/**
 * @typedef {object} IntentResolution
 * @property {ChatIntent} intent
 * @property {string} effectiveTask
 * @property {boolean} autoFixed
 * @property {boolean} agentic
 * @property {string} [reason]
 */

/** Short social replies — never trigger implement. */
const SOCIAL_ACK_RE =
	/^(thanks?|thank you|thx|ty|cheers|appreciated|much appreciated|got it|cool|nice|perfect|great|awesome|lovely|wonderful|good to know|noted|ok thanks|okay thanks)\b[!. ]*$/i;

/** Clear consent to proceed with code changes — NOT gratitude. */
const CONSENT_RE =
	/^(yes|yep|yeah|yup|ok|okay|sure|do it|go ahead|go for it|sounds good|that works|let'?s do it|make it happen|please do|do that|do this|apply it|ship it|implement it)\b/i;

const NEGATIVE_RE = /^(no|nope|don'?t|wait|stop|not yet|hold on)\b/i;

const QUESTION_START_RE =
	/^(how|what|why|when|where|who|which|can you explain|could you explain|tell me|is there|are there|should i|would it)\b/i;

const EXPLAIN_RE =
	/\b(explain|describe|what does|what is|what are|how does|how do|walk me through|help me understand|overview of|summary of|thoughts on|feedback on|tell me about)\b/i;

const REVIEW_RE =
	/\b(check|review|inspect|audit|look at|read|analyze|analyse|assess|evaluate|scan)\b/i;

const PLAN_RE =
	/\b(plan|roadmap|break down|step.by.step|multi.?step|outline|strategy|approach|migration plan|how should (?:we|i)|what should (?:we|i) do|phases? for|design doc)\b/i;

const AGENT_RE =
	/\b(end.to.end|handle (?:this|it|everything)|take care of|do (?:this|it) (?:all|for me)|full(?:y)? implement|agentic|autonomous|run (?:the|this) plan|execute (?:the|this) plan|work through)\b/i;

const EDIT_RE =
	/\b(add|implement|fix|refactor|change|update|create|remove|delete|modify|write|rename|move|build|complete|finish|repair|patch|correct|resolve|hook up|wire up|integrate|replace|migrate to|convert to|set up|setup)\b/i;

const BROKEN_RE =
	/\b(broken|buggy|incomplete|half.?done|half.?finished|unfinished|truncated|cut off|syntax error|won'?t compile|doesn'?t work|not working|missing (?:parts?|methods?|exports?)|has errors?|is wrong|needs? (?:a )?fix)\b/i;

const FIX_REQUEST_RE =
	/\b(can you fix|please fix|help me fix|fix (?:this|it|the)|make it work|get (?:this|it) working)\b/i;

const OPTION_PICK_RE =
	/\b(option|choice|number|#|item|feature|step)\s*#?\s*(\d+)\b/i;

/**
 * @param {string} message
 * @returns {boolean}
 */
function isLikelyQuestion(message) {
	const m = message.trim();
	return m.endsWith('?') || QUESTION_START_RE.test(m);
}

/**
 * @param {Array<{role: string, content: string}>} history
 * @returns {{ role: string, content: string } | undefined}
 */
function lastAssistantTurn(history) {
	if (!Array.isArray(history)) {
		return undefined;
	}
	for (let i = history.length - 1; i >= 0; i--) {
		if (history[i].role === 'assistant') {
			return history[i];
		}
	}
	return undefined;
}

/**
 * @param {Array<{role: string, content: string}>} history
 * @returns {{ role: string, content: string } | undefined}
 */
function lastUserTurn(history) {
	if (!Array.isArray(history)) {
		return undefined;
	}
	for (let i = history.length - 1; i >= 0; i--) {
		if (history[i].role === 'user') {
			return history[i];
		}
	}
	return undefined;
}

/**
 * @param {string} content
 * @returns {boolean}
 */
function isWorkCompleteMessage(content) {
	const lower = content.toLowerCase();
	return (
		lower.includes('applied to your project') ||
		lower.includes('written to project') ||
		lower.includes('agent complete') ||
		lower.includes('all plan steps are complete')
	);
}

/**
 * Assistant message is offering a next action — not reporting finished work.
 * @param {string} content
 * @returns {boolean}
 */
function isPendingImplementOffer(content) {
	if (isWorkCompleteMessage(content)) {
		return false;
	}

	const lower = content.toLowerCase();
	return (
		lower.includes('suggested next steps') ||
		lower.includes('say **implement') ||
		lower.includes('say **yes') ||
		lower.includes('go for it') ||
		/\b(would you like me to|shall i|want me to|should i implement|ready to implement|want me to proceed)\b/.test(lower) ||
		/\d+\.\s+\*\*[^*]+\*\*/.test(content)
	);
}

/**
 * Infers implement task from conversation when user affirms or picks an option.
 * @param {string} message
 * @param {Array<{role: string, content: string}>} history
 * @returns {string | null}
 */
function inferFollowUpTask(message, history) {
	const trimmed = message.trim();
	const lastAssistant = lastAssistantTurn(history);
	if (!lastAssistant) {
		return null;
	}

	if (SOCIAL_ACK_RE.test(trimmed)) {
		return null;
	}

	if (NEGATIVE_RE.test(trimmed)) {
		return null;
	}

	const optionMatch = trimmed.match(OPTION_PICK_RE);
	if (optionMatch) {
		return `Implement option ${optionMatch[2]} from your previous response. Use the conversation context and write the code into the project.`;
	}

	if (!CONSENT_RE.test(trimmed) && trimmed.split(/\s+/).length > 6) {
		return null;
	}

	if (!CONSENT_RE.test(trimmed)) {
		return null;
	}

	if (!isPendingImplementOffer(lastAssistant.content)) {
		return null;
	}

	if (lastAssistant.content.toLowerCase().includes('plan')) {
		return 'Execute the plan you outlined — implement the first actionable steps in the codebase.';
	}

	const lastUser = lastUserTurn(history);
	return lastUser?.content
		? `Proceed with the implementation discussed. Original request: ${lastUser.content}`
		: 'Proceed with the implementation you suggested in your last message. Write code into the project.';
}

/**
 * Scores how strongly a message maps to each intent.
 * @param {string} message
 * @param {Array<{role: string, content: string}>} history
 * @returns {{ chat: number, plan: number, edit: number, agentic: number }}
 */
function scoreIntents(message, history) {
	const m = message.toLowerCase().trim();
	const scores = { chat: 0, plan: 0, edit: 0, agentic: 0 };
	const question = isLikelyQuestion(message);

	if (EXPLAIN_RE.test(m) || (question && !EDIT_RE.test(m) && !BROKEN_RE.test(m))) {
		scores.chat += 3;
	}

	if (REVIEW_RE.test(m) || isFileReviewTask(message)) {
		scores.chat += 2;
	}

	if (PLAN_RE.test(m)) {
		scores.plan += 4;
	}

	if (AGENT_RE.test(m)) {
		scores.agentic += 5;
		scores.plan += 2;
	}

	if (/\b(migrate|rebuild|rewrite|overhaul|entire (?:app|system|auth|api)|whole (?:project|codebase))\b/.test(m)) {
		scores.plan += 2;
		scores.agentic += 2;
	}

	if (BROKEN_RE.test(m) || FIX_REQUEST_RE.test(m)) {
		scores.edit += 4;
	}

	if (EDIT_RE.test(m)) {
		scores.edit += question ? 1 : 3;
	}

	if (
		/\b(go for|implement|build it|code it|apply it|do it now|ship it|write the code)\b/.test(m) ||
		/^implement\b/.test(m) ||
		/^finish\b/.test(m) ||
		/^continue\b/.test(m)
	) {
		scores.edit += 5;
	}

	if (/\b(yes|go ahead|do it|sounds good)\b/.test(m) && !SOCIAL_ACK_RE.test(m)) {
		const followUp = inferFollowUpTask(message, history);
		if (followUp) {
			scores.edit += 6;
		}
	}

	if (SOCIAL_ACK_RE.test(m)) {
		scores.chat += 8;
	}

	// Short imperative commands without question marks → likely edit
	if (!question && m.split(/\s+/).length <= 12 && EDIT_RE.test(m)) {
		scores.edit += 2;
	}

	// Pure conversational with no signals
	if (scores.chat === 0 && scores.plan === 0 && scores.edit === 0) {
		scores.chat += 2;
	}

	return scores;
}

/**
 * Picks winning intent from scores.
 * @param {{ chat: number, plan: number, edit: number, agentic: number }} scores
 * @returns {ChatIntent}
 */
function pickIntent(scores) {
	const ranked = [
		['edit', scores.edit],
		['plan', scores.plan],
		['chat', scores.chat],
	].sort((a, b) => b[1] - a[1]);

	return /** @type {ChatIntent} */ (ranked[0][0]);
}

/**
 * Resolves user intent from natural language and conversation context.
 * @param {string} task
 * @param {object} [options]
 * @param {Array<{role: string, content: string}>} [options.history]
 * @param {Array} [options.shards]
 * @param {boolean} [options.fixOnCheck=true]
 * @param {import('./ChatOrchestrator.js').ChatMode | string} [options.chatMode='auto']
 * @returns {IntentResolution}
 */
export function resolveUserIntent(task, options = {}) {
	const {
		history = [],
		shards = [],
		fixOnCheck = true,
		chatMode = 'auto',
	} = options;

	if (chatMode === 'explain') {
		return { intent: 'chat', effectiveTask: task, autoFixed: false, agentic: false, reason: 'mode:explain' };
	}
	if (chatMode === 'plan') {
		return { intent: 'plan', effectiveTask: task, autoFixed: false, agentic: false, reason: 'mode:plan' };
	}
	if (chatMode === 'implement') {
		return { intent: 'edit', effectiveTask: task, autoFixed: false, agentic: false, reason: 'mode:implement' };
	}
	if (chatMode === 'agent') {
		return { intent: 'plan', effectiveTask: task, autoFixed: false, agentic: true, reason: 'mode:agent' };
	}

	const trimmed = task.trim();
	if (SOCIAL_ACK_RE.test(trimmed)) {
		return {
			intent: 'chat',
			effectiveTask: task,
			autoFixed: false,
			agentic: false,
			reason: 'social:acknowledgment',
		};
	}

	const followUpTask = inferFollowUpTask(task, history);
	if (followUpTask) {
		return {
			intent: 'edit',
			effectiveTask: followUpTask,
			autoFixed: false,
			agentic: false,
			reason: 'conversation:follow-up',
		};
	}

	if (shouldAutoFixOnCheck(task, shards, fixOnCheck)) {
		return {
			intent: 'edit',
			effectiveTask: buildAutoFixTask(task, shards),
			autoFixed: true,
			agentic: false,
			reason: 'context:incomplete-file',
		};
	}

	const scores = scoreIntents(task, history);
	const intent = pickIntent(scores);
	const agentic = scores.agentic >= 4 && (intent === 'plan' || scores.plan >= scores.edit);

	return {
		intent,
		effectiveTask: task,
		autoFixed: false,
		agentic,
		reason: `scores:chat=${scores.chat},plan=${scores.plan},edit=${scores.edit}`,
	};
}
