import {
	isFileReviewTask,
	shouldAutoFixOnCheck,
	buildAutoFixTask,
} from './FileReview.js';

/** @typedef {'chat' | 'plan' | 'edit'} ChatIntent */
/** @typedef {'auto' | 'explain' | 'plan' | 'implement' | 'agent'} ChatMode */

/**
 * @typedef {object} IntentResolution
 * @property {ChatIntent} intent
 * @property {string} effectiveTask
 * @property {boolean} autoFixed
 * @property {boolean} agentic
 * @property {boolean} readOnly — no disk writes / auto-apply
 * @property {boolean} allowWrites — write_file + auto-apply allowed
 * @property {boolean} investigate — read-only tool loop (read/search/reply)
 * @property {'high' | 'medium' | 'low'} confidence
 * @property {string} [reason]
 */

const SOCIAL_ACK_RE =
	/^(thanks?|thank you|thx|ty|cheers|appreciated|much appreciated|got it|cool|nice|perfect|great|awesome|lovely|wonderful|good to know|noted|ok thanks|okay thanks)\b[!. ]*$/i;

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

/** Debug / config questions — investigate, do not rewrite files. */
const INVESTIGATE_RE =
	/\b(why|how come|root cause|what causes|what caused|debug|diagnos|figure out|not resolved|still (?:fail|broken|wrong)|env(?:ironment)?(?:\s+file)?|\.env|dotenv|environment variable|config(?:uration)?|settings?|payload|api\s*key|which model|wrong model|default (?:model|setting)|hardcoded|should (?:it|we) (?:use|read)|check (?:the |my )?(?:env|config|settings|\.env)|reading from env|from env)\b/i;

const EXPLICIT_WRITE_RE =
	/\b(implement|apply|write (?:the )?code|change (?:the )?code|update (?:the )?file|edit (?:the )?file|create (?:the )?file|go ahead and (?:fix|implement)|please (?:fix|implement|update)|just fix)\b/i;

const OPTION_PICK_RE =
	/\b(option|choice|number|#|item|feature|step)\s*#?\s*(\d+)\b/i;

const ROUTER_MODE = (process.env.NEUROCODE_INTENT_ROUTER || 'hybrid').toLowerCase();

const LLM_ROUTER_PROMPT = `You route messages for a VS Code coding assistant (Cursor-style).
Return ONLY valid JSON (no markdown):
{"intent":"chat"|"plan"|"edit","investigate":boolean,"allow_writes":boolean,"confidence":0.0-1.0,"reason":"short"}

Rules:
- Questions about why/how/errors/config/env/payload/models → intent chat, investigate true, allow_writes false
- Explicit requests to implement/fix/write code → intent edit, investigate false, allow_writes true
- Multi-step feature design → intent plan, investigate false, allow_writes false
- "thanks" / social → intent chat, investigate false, allow_writes false
- When unsure, prefer chat + investigate over edit (do not write files)`;

/**
 * @param {string} message
 * @returns {boolean}
 */
export function isLikelyQuestion(message) {
	const m = message.trim();
	return m.endsWith('?') || QUESTION_START_RE.test(m);
}

/**
 * @param {string} message
 * @returns {boolean}
 */
export function isInvestigateTask(message) {
	const m = message.trim().toLowerCase();
	if (INVESTIGATE_RE.test(m)) {
		return true;
	}
	if (isLikelyQuestion(message) && /\b(error|payload|env|config|setting|model|api|gateway|choices|null|undefined)\b/i.test(m)) {
		return true;
	}
	if (/\bnot resolved\b/i.test(m) || /\bstill (?:getting|seeing|have)\b/i.test(m)) {
		return true;
	}
	return false;
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

function isWorkCompleteMessage(content) {
	const lower = content.toLowerCase();
	return (
		lower.includes('applied to your project') ||
		lower.includes('written to project') ||
		lower.includes('agent complete') ||
		lower.includes('all plan steps are complete')
	);
}

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

function inferFollowUpTask(message, history) {
	const trimmed = message.trim();
	const lastAssistant = lastAssistantTurn(history);
	if (!lastAssistant) {
		return null;
	}
	if (SOCIAL_ACK_RE.test(trimmed) || NEGATIVE_RE.test(trimmed)) {
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
 * @param {string} message
 * @param {Array<{role: string, content: string}>} history
 * @returns {{ chat: number, plan: number, edit: number, agentic: number }}
 */
function scoreIntents(message, history) {
	const m = message.toLowerCase().trim();
	const scores = { chat: 0, plan: 0, edit: 0, agentic: 0 };
	const question = isLikelyQuestion(message);
	const investigate = isInvestigateTask(message);

	if (investigate) {
		scores.chat += 10;
		return scores;
	}

	if (EXPLAIN_RE.test(m) || (question && !EDIT_RE.test(m) && !BROKEN_RE.test(m))) {
		scores.chat += 3;
	}

	if (REVIEW_RE.test(m) || isFileReviewTask(message)) {
		scores.chat += question ? 4 : 2;
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

	if ((BROKEN_RE.test(m) || FIX_REQUEST_RE.test(m)) && !question) {
		scores.edit += 4;
	} else if (BROKEN_RE.test(m) && question) {
		scores.chat += 2;
	}

	if (EDIT_RE.test(m)) {
		scores.edit += question && !EXPLICIT_WRITE_RE.test(m) ? 1 : 3;
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
		if (inferFollowUpTask(message, history)) {
			scores.edit += 6;
		}
	}

	if (SOCIAL_ACK_RE.test(m)) {
		scores.chat += 8;
	}

	if (!question && m.split(/\s+/).length <= 12 && EDIT_RE.test(m) && EXPLICIT_WRITE_RE.test(m)) {
		scores.edit += 2;
	}

	if (scores.chat === 0 && scores.plan === 0 && scores.edit === 0) {
		scores.chat += 2;
	}

	return scores;
}

function pickIntent(scores) {
	const ranked = [
		['edit', scores.edit],
		['plan', scores.plan],
		['chat', scores.chat],
	].sort((a, b) => b[1] - a[1]);
	return /** @type {ChatIntent} */ (ranked[0][0]);
}

/**
 * @param {IntentResolution} partial
 * @returns {IntentResolution}
 */
function finalizeResolution(partial) {
	const readOnly = partial.readOnly ?? !partial.allowWrites;
	return {
		readOnly,
		allowWrites: partial.allowWrites ?? !readOnly,
		investigate: partial.investigate ?? false,
		confidence: partial.confidence ?? 'high',
		autoFixed: partial.autoFixed ?? false,
		agentic: partial.agentic ?? false,
		intent: partial.intent,
		effectiveTask: partial.effectiveTask,
		reason: partial.reason,
	};
}

/**
 * Cursor-style permissions from explicit mode pills.
 * @param {ChatMode} chatMode
 * @param {string} task
 * @returns {IntentResolution | null}
 */
function resolveFromMode(chatMode, task) {
	switch (chatMode) {
		case 'explain':
			return finalizeResolution({
				intent: 'chat',
				effectiveTask: task,
				readOnly: true,
				allowWrites: false,
				investigate: true,
				confidence: 'high',
				reason: 'mode:explain',
			});
		case 'plan':
			return finalizeResolution({
				intent: 'plan',
				effectiveTask: task,
				readOnly: true,
				allowWrites: false,
				investigate: false,
				confidence: 'high',
				reason: 'mode:plan',
			});
		case 'implement':
			return finalizeResolution({
				intent: 'edit',
				effectiveTask: task,
				readOnly: false,
				allowWrites: true,
				investigate: false,
				confidence: 'high',
				reason: 'mode:implement',
			});
		case 'agent':
			return finalizeResolution({
				intent: 'plan',
				effectiveTask: task,
				readOnly: false,
				allowWrites: true,
				investigate: false,
				agentic: true,
				confidence: 'high',
				reason: 'mode:agent',
			});
		default:
			return null;
	}
}

/**
 * Heuristic intent + permissions (sync).
 * @param {string} task
 * @param {object} [options]
 * @returns {IntentResolution}
 */
export function resolveUserIntent(task, options = {}) {
	const {
		history = [],
		shards = [],
		fixOnCheck = true,
		chatMode = 'auto',
	} = options;

	const modeResult = resolveFromMode(chatMode, task);
	if (modeResult) {
		return modeResult;
	}

	const trimmed = task.trim();

	if (SOCIAL_ACK_RE.test(trimmed)) {
		return finalizeResolution({
			intent: 'chat',
			effectiveTask: task,
			readOnly: true,
			allowWrites: false,
			investigate: false,
			confidence: 'high',
			reason: 'social:acknowledgment',
		});
	}

	const followUpTask = inferFollowUpTask(task, history);
	if (followUpTask) {
		return finalizeResolution({
			intent: 'edit',
			effectiveTask: followUpTask,
			readOnly: false,
			allowWrites: true,
			investigate: false,
			confidence: 'high',
			reason: 'conversation:follow-up',
		});
	}

	if (isInvestigateTask(task) && !EXPLICIT_WRITE_RE.test(trimmed)) {
		return finalizeResolution({
			intent: 'chat',
			effectiveTask: task,
			readOnly: true,
			allowWrites: false,
			investigate: true,
			confidence: 'high',
			reason: 'investigate:debug-or-config',
		});
	}

	if (
		fixOnCheck &&
		!isInvestigateTask(task) &&
		!isLikelyQuestion(task) &&
		shouldAutoFixOnCheck(task, shards, fixOnCheck)
	) {
		return finalizeResolution({
			intent: 'edit',
			effectiveTask: buildAutoFixTask(task, shards),
			autoFixed: true,
			readOnly: false,
			allowWrites: true,
			investigate: false,
			confidence: 'medium',
			reason: 'context:incomplete-file',
		});
	}

	const scores = scoreIntents(task, history);
	const intent = pickIntent(scores);
	const agentic = scores.agentic >= 4 && (intent === 'plan' || scores.plan >= scores.edit);
	const question = isLikelyQuestion(task);

	const allowWrites = intent === 'edit' && (
		EXPLICIT_WRITE_RE.test(trimmed) ||
		(!question && scores.edit >= 4) ||
		scores.edit >= 6
	);

	const investigate =
		intent === 'chat' && (
			isInvestigateTask(task) ||
			(question && scores.edit < 5) ||
			(REVIEW_RE.test(trimmed.toLowerCase()) && question)
		);

	const confidence =
		Math.max(scores.chat, scores.plan, scores.edit) >= 5 ? 'high' : 'medium';

	if (intent === 'edit' && !allowWrites) {
		return finalizeResolution({
			intent: 'chat',
			effectiveTask: task,
			readOnly: true,
			allowWrites: false,
			investigate: true,
			agentic: false,
			confidence: 'medium',
			reason: `weak-edit→investigate: scores chat=${scores.chat},edit=${scores.edit}`,
		});
	}

	return finalizeResolution({
		intent,
		effectiveTask: task,
		readOnly: !allowWrites,
		allowWrites,
		investigate,
		agentic,
		confidence,
		reason: `scores:chat=${scores.chat},plan=${scores.plan},edit=${scores.edit}`,
	});
}

/**
 * Optional LLM classifier for ambiguous Auto messages.
 * @param {import('../adapters/OpenAICompatibleAdapter.js').OpenAICompatibleAdapter | import('../adapters/OllamaAdapter.js').OllamaAdapter} adapter
 * @param {string} task
 * @param {Array<{role: string, content: string}>} history
 * @returns {Promise<IntentResolution | null>}
 */
async function resolveWithLlm(adapter, task, history) {
	try {
		const recent = history.slice(-4).map((t) => `${t.role}: ${t.content.slice(0, 400)}`).join('\n');
		const raw = await adapter.chat(
			[
				{ role: 'system', content: LLM_ROUTER_PROMPT },
				{
					role: 'user',
					content: `Recent conversation:\n${recent || '(none)'}\n\nLatest user message:\n${task}`,
				},
			],
			{ temperature: 0, max_tokens: 120 },
		);
		const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
		const parsed = JSON.parse(cleaned);
		const intent = ['chat', 'plan', 'edit'].includes(parsed.intent) ? parsed.intent : 'chat';
		const investigate = Boolean(parsed.investigate);
		const allowWrites = Boolean(parsed.allow_writes) && !investigate;
		return finalizeResolution({
			intent,
			effectiveTask: task,
			readOnly: !allowWrites,
			allowWrites,
			investigate,
			agentic: false,
			confidence: typeof parsed.confidence === 'number' && parsed.confidence >= 0.75 ? 'high' : 'medium',
			reason: `llm:${parsed.reason ?? 'router'}`,
		});
	} catch (err) {
		console.warn('[IntentRouter] LLM router failed:', err instanceof Error ? err.message : err);
		return null;
	}
}

/**
 * Resolves intent with optional LLM assist (hybrid mode).
 * @param {string} task
 * @param {object} options
 * @param {import('../adapters/OpenAICompatibleAdapter.js').OpenAICompatibleAdapter | import('../adapters/OllamaAdapter.js').OllamaAdapter | null} [adapter]
 * @returns {Promise<IntentResolution>}
 */
export async function resolveIntentPermissions(task, options = {}, adapter = null) {
	const heuristic = resolveUserIntent(task, options);
	const mode = options.chatMode ?? 'auto';

	if (mode !== 'auto' || ROUTER_MODE === 'heuristic') {
		return heuristic;
	}

	const ambiguous =
		heuristic.confidence !== 'high' ||
		(heuristic.intent === 'edit' && isLikelyQuestion(task) && !EXPLICIT_WRITE_RE.test(task.trim()));

	if (ROUTER_MODE === 'llm' || (ROUTER_MODE === 'hybrid' && ambiguous)) {
		if (adapter) {
			const llmResult = await resolveWithLlm(adapter, task, options.history ?? []);
			if (llmResult) {
				return llmResult;
			}
		}
	}

	return heuristic;
}

/** @deprecated Use resolveUserIntent — kept for imports */
export { resolveUserIntent as classifyIntentLegacy };
