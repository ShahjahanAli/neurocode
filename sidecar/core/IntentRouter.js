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
	/^(yes|yep|yeah|yup|ok|okay|sure|do it|go ahead|go for it|sounds good|that works|let'?s do it|make it happen|please do|do that|do this|apply it|ship it|implement it|implement|fix it|fix this)\b/i;

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
	/\b(why (?:is|does|am i|are|did|would|can)|how come|can you check why|check why|root cause|what causes|what caused|debug|diagnos|figure out|not resolved|still (?:not )?(?:working|resolved|fixed|correct|solved)|still (?:getting|seeing|have)|not working|doesn'?t work|didn'?t work|not solving|same (?:issue|problem|payload|error)|env(?:ironment)?(?:\s+file)?|\.env|dotenv|environment variable|config(?:uration)?|settings?|payload|api\s*key|which model|wrong model|default (?:model|setting)|hardcoded|should (?:it|we) (?:use|read)|check (?:the |my )?(?:env|config|settings|\.env)|reading from env|from env|go over|walk (?:me )?through|trace (?:through)?|review (?:the )?(?:full |whole )?(?:system|flow|stack)|full system|entire (?:flow|stack)|end.to.end|test message|why am i seeing)\b/i;

const EXPLICIT_WRITE_RE =
	/\b(implement|apply|write (?:the )?code|change (?:the )?code|update (?:the )?file|edit (?:the )?file|create (?:the )?file|go ahead and (?:fix|implement)|please (?:fix|implement|update)|just fix|solve this|fix this)\b/i;

/** User wants the agent to apply a fix (Cursor-style), not manual instructions. */
const DELEGATE_FIX_RE =
	/\b(you (?:fix|update|change|apply|do|solve|resolve)|fix (?:it|this)(?: for me)?|solve (?:it|this)(?: for me)?|resolve (?:it|this)(?: for me)?|update it(?: for me| accordingly)?|apply (?:the )?fix|make the change|do the fix|you should (?:fix|update|change|solve|resolve))\b/i;

const FIX_ERROR_RE =
	/\b(solve|fix|resolve|repair)\b[\s\S]{0,48}\b(error|issue|bug)\b|\b(error|issue|bug)\b[\s\S]{0,48}\b(solve|fix|resolve|repair)\b/i;

const REJECT_MANUAL_FIX_RE =
	/\b(why should i|why do i have to|why must i|you update|you fix|you change|not me|don't tell me)\b/i;

const OPTION_PICK_RE =
	/\b(option|choice|number|#|item|feature|step)\s*#?\s*(\d+)\b/i;

const ROUTER_MODE = (process.env.NEUROCODE_INTENT_ROUTER || 'llm').toLowerCase();

const LLM_ROUTER_PROMPT = `You are the intent router for NeuroCode — a Cursor-style AI coding assistant in VS Code.
Classify the user's latest message using conversation context. This runs BEFORE any tools, file reads, or code writes.

Return ONLY valid JSON (no markdown fences):
{
  "intent": "chat" | "plan" | "edit",
  "investigate": boolean,
  "allow_writes": boolean,
  "effective_task": string,
  "confidence": number,
  "reason": string
}

Field meanings:
- intent "chat": explain, discuss, answer questions
- intent "plan": multi-step feature/refactor roadmap (no code writes yet)
- intent "edit": produce code changes
- investigate true: use read-only tools first (read_file, search) — debug/trace errors, inspect config/env, understand before acting
- allow_writes true: agent may write/apply files to disk (implement mode)
- effective_task: one clear instruction for the worker (include filenames from stack traces when present)

Cursor-style routing (use judgment, not keywords):
- User wants a fix applied ("fix", "solve", "you update", "you do it", "why should I change" after you suggested a fix) → intent edit, allow_writes true, investigate false — agent will read files then write
- User pasted an error/stack trace and wants it resolved → intent edit, allow_writes true, investigate false unless they only ask "why" or "explain"
- User asks why/how/debug/env/payload/check (no fix requested) → intent chat, investigate true, allow_writes false — read-only tool loop
- Greeting/thanks/small talk → intent chat, investigate false, allow_writes false — brief friendly reply, no tools
- Large feature / migration / "build X like Y" → intent plan, investigate false, allow_writes false
- When ambiguous: investigate true if reading code first helps; allow_writes true only when user clearly wants changes applied

## CRITICAL follow-up rule
If the assistant already diagnosed a bug and suggested a concrete code change, and the user now says anything like solve, resolve, fix, apply, implement, "do it", "you fix", or "resolve this" — you MUST return intent "edit", investigate false, allow_writes true. Never return chat/explain for those messages.

## Examples
User: [React error: Element type is invalid... app/page.tsx ChatInterface]
→ {"intent":"edit","investigate":false,"allow_writes":true,"effective_task":"Fix ChatInterface import/export mismatch in app/page.tsx","confidence":0.9,"reason":"error needs code fix"}

User: "solve this issue" (assistant previously said change default import in app/page.tsx)
→ {"intent":"edit","investigate":false,"allow_writes":true,"effective_task":"Change app/page.tsx to default-import ChatInterface from @/components/chat/ChatInterface","confidence":0.95,"reason":"user wants fix applied"}

User: "why does this error happen?"
→ {"intent":"chat","investigate":true,"allow_writes":false,"effective_task":"Explain root cause of Element type invalid error","confidence":0.9,"reason":"diagnosis only"}

effective_task must be actionable (bad: "help user"; good: "Fix import/export mismatch between app/page.tsx and ChatInterface").`;

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
export function isInvestigateTask(message, history = []) {
	if (wantsAgentToFix(message, history)) {
		return false;
	}
	const m = message.trim().toLowerCase();
	if (INVESTIGATE_RE.test(m)) {
		return true;
	}
	if (isLikelyQuestion(message) && /\b(error|payload|env|config|setting|model|api|gateway|choices|null|undefined|seeing|message)\b/i.test(m)) {
		return true;
	}
	if (/\bnot resolved\b/i.test(m) || /\bstill\b/i.test(m) && /\b(not working|broken|wrong|resolved|fixed|seeing)\b/i.test(m)) {
		return true;
	}
	return false;
}

/**
 * User reports a prior fix or explanation did not work — read-only investigation only.
 * @param {string} message
 * @param {Array<{role: string, content: string}>} [history]
 * @returns {boolean}
 */
export function isRegressionReport(message, history = []) {
	if (wantsAgentToFix(message, history)) {
		return false;
	}
	const m = message.trim().toLowerCase();
	if (isInvestigateTask(message, history)) {
		return true;
	}
	if (!/\b(still|not working|not resolved|not solving|still not solved|didn'?t work|doesn'?t work|same problem|same issue|why you|why are you not)\b/i.test(m)) {
		return false;
	}
	if (/\b(payload|model|env|error|issue|fix)\b/i.test(m)) {
		return true;
	}
	return history.some((t) => t.role === 'assistant');
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

function isAssistantFixInstruction(content) {
	if (!content) {
		return false;
	}
	const lower = content.toLowerCase();
	return (
		lower.includes('to fix this') ||
		lower.includes('change the import') ||
		lower.includes('change the export') ||
		lower.includes('you need to change') ||
		lower.includes('resolve the') ||
		(lower.includes('import ') && lower.includes('from') && (lower.includes('change') || lower.includes('fix')))
	);
}

/**
 * @param {string} message
 * @param {Array<{role: string, content: string}>} [history]
 * @returns {boolean}
 */
export function wantsAgentToFix(message, history = []) {
	const trimmed = message.trim();
	if (DELEGATE_FIX_RE.test(trimmed) || FIX_ERROR_RE.test(trimmed)) {
		return true;
	}
	if (/\b(solve|resolve)\b/i.test(trimmed) && history.some((t) => t.role === 'assistant')) {
		return true;
	}
	if (EXPLICIT_WRITE_RE.test(trimmed) && /\b(error|fix|import|export|element type)\b/i.test(trimmed)) {
		return true;
	}
	const lastAssistant = lastAssistantTurn(history);
	if (lastAssistant && isAssistantFixInstruction(lastAssistant.content)) {
		if (REJECT_MANUAL_FIX_RE.test(trimmed) || DELEGATE_FIX_RE.test(trimmed)) {
			return true;
		}
		if (CONSENT_RE.test(trimmed)) {
			return true;
		}
	}
	return false;
}

/**
 * @param {string} userTask
 * @param {string} [assistantContext]
 * @returns {string}
 */
function buildDelegateFixTask(userTask, assistantContext = '') {
	const base = assistantContext
		? `Apply the fix from your previous message. User now says: ${userTask}\n\nPrior analysis:\n${assistantContext.slice(0, 2500)}`
		: userTask;
	return `${base}

Requirements (Cursor-style — write files, do not tell the user to edit manually):
- Read the relevant files first (e.g. app/page.tsx, components/chat/ChatInterface.tsx)
- Output FULL corrected file(s) in fenced code blocks
- First line inside each block MUST be: // filename: relative/path.tsx
- Fix import/export mismatches consistently (default export ↔ default import)
- Do not only show a one-line import snippet — write the complete file`;
}

function isPendingImplementOffer(content) {
	if (isWorkCompleteMessage(content)) {
		return false;
	}
	if (isAssistantFixInstruction(content)) {
		return true;
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

	if (lastAssistant && isAssistantFixInstruction(lastAssistant.content)) {
		if (DELEGATE_FIX_RE.test(trimmed) || REJECT_MANUAL_FIX_RE.test(trimmed) || CONSENT_RE.test(trimmed)) {
			return buildDelegateFixTask(trimmed, lastAssistant.content);
		}
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
	const investigate = isInvestigateTask(message, history);

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

	if (/\b(still not|not working|not resolved)\b/.test(m)) {
		scores.chat += 8;
		scores.edit = Math.max(0, scores.edit - 4);
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

	if (wantsAgentToFix(task, history)) {
		const lastA = lastAssistantTurn(history);
		return finalizeResolution({
			intent: 'edit',
			effectiveTask: buildDelegateFixTask(task, lastA?.content ?? ''),
			readOnly: false,
			allowWrites: true,
			investigate: false,
			confidence: 'high',
			reason: 'user:delegate-fix',
		});
	}

	const followUpTask = inferFollowUpTask(task, history);
	if (followUpTask && !isRegressionReport(task, history)) {
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

	if (isRegressionReport(task, history) && !EXPLICIT_WRITE_RE.test(trimmed)) {
		return finalizeResolution({
			intent: 'chat',
			effectiveTask: task,
			readOnly: true,
			allowWrites: false,
			investigate: true,
			confidence: 'high',
			reason: 'regression:investigate',
		});
	}

	if (isInvestigateTask(task, history) && !EXPLICIT_WRITE_RE.test(trimmed)) {
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
		!isRegressionReport(task, history) &&
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
		((!question && scores.edit >= 4) || scores.edit >= 6) &&
		!isRegressionReport(task, history)
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
 * Safe default when the LLM router is unavailable (gateway down).
 * @param {string} task
 * @returns {IntentResolution}
 */
function fallbackResolution(task) {
	return finalizeResolution({
		intent: 'chat',
		effectiveTask: task,
		readOnly: true,
		allowWrites: false,
		investigate: true,
		confidence: 'low',
		reason: 'fallback:llm-unavailable',
	});
}

/**
 * User pasted a runtime/stack error — treat as fix request unless they only ask why.
 * @param {string} message
 * @returns {boolean}
 */
function isPastedRuntimeError(message) {
	const m = message.trim();
	if (m.length < 40) {
		return false;
	}
	if (/\b(why|explain|what causes|how come)\b/i.test(m) && !/\b(fix|solve|resolve)\b/i.test(m)) {
		return false;
	}
	return (
		/\belement type is invalid\b/i.test(m) ||
		/\bexpected a string \(for built-in components\)/i.test(m) ||
		/\b(TypeError|ReferenceError|SyntaxError|Unhandled Runtime Error)\b/.test(m) ||
		(/\.tsx?\s*\(\d+:\d+\)/.test(m) && /\bat\s+\w+/i.test(m))
	);
}

/**
 * @param {object} parsed
 * @param {string} task
 * @returns {{ intent: string, investigate: boolean, allowWrites: boolean, effectiveTask: string }}
 */
function normalizeLlmRouterOutput(parsed, task) {
	const intent = ['chat', 'plan', 'edit'].includes(parsed.intent) ? parsed.intent : 'chat';
	let investigate = Boolean(parsed.investigate);
	let allowWrites = Boolean(parsed.allow_writes);
	const effectiveTask =
		typeof parsed.effective_task === 'string' && parsed.effective_task.trim()
			? parsed.effective_task.trim()
			: task;

	if (intent === 'edit') {
		investigate = false;
		allowWrites = true;
	} else if (investigate) {
		allowWrites = false;
	} else if (allowWrites) {
		investigate = false;
	}

	return { intent, investigate, allowWrites, effectiveTask };
}

/**
 * Cursor-style LLM intent classifier — sole router for Auto mode.
 * @param {import('../adapters/OpenAICompatibleAdapter.js').OpenAICompatibleAdapter | import('../adapters/OllamaAdapter.js').OllamaAdapter} adapter
 * @param {string} task
 * @param {Array<{role: string, content: string}>} history
 * @returns {Promise<IntentResolution | null>}
 */
async function resolveWithLlm(adapter, task, history) {
	try {
		const lastAssistant = lastAssistantTurn(history);
		const recent = history.slice(-6).map((t) => `${t.role}: ${t.content.slice(0, 1200)}`).join('\n');
		const assistantBlock = lastAssistant
			? `\n\n=== LAST ASSISTANT MESSAGE (may contain the fix to apply) ===\n${lastAssistant.content.slice(0, 4000)}`
			: '';

		const raw = await adapter.chat(
			[
				{ role: 'system', content: LLM_ROUTER_PROMPT },
				{
					role: 'user',
					content: `Recent conversation:\n${recent || '(none)'}${assistantBlock}\n\nLatest user message:\n${task}`,
				},
			],
			{ temperature: 0, max_tokens: 400 },
		);
		const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
		const parsed = JSON.parse(cleaned);
		const { intent, investigate, allowWrites, effectiveTask } = normalizeLlmRouterOutput(parsed, task);

		let resolution = finalizeResolution({
			intent,
			effectiveTask,
			readOnly: !allowWrites,
			allowWrites,
			investigate,
			agentic: false,
			confidence: typeof parsed.confidence === 'number' && parsed.confidence >= 0.75 ? 'high' : 'medium',
			reason: `llm:${parsed.reason ?? 'router'}`,
		});

		if (!resolution.allowWrites && resolution.intent === 'chat' && wantsAgentToFix(task, history)) {
			const lastA = lastAssistantTurn(history);
			resolution = finalizeResolution({
				intent: 'edit',
				effectiveTask: buildDelegateFixTask(task, lastA?.content ?? ''),
				readOnly: false,
				allowWrites: true,
				investigate: false,
				agentic: false,
				confidence: 'high',
				reason: 'escalation:fix-follow-up',
			});
		}

		if (!resolution.allowWrites && isPastedRuntimeError(task)) {
			resolution = finalizeResolution({
				intent: 'edit',
				effectiveTask: `Fix this error in the codebase:\n${task.slice(0, 2500)}`,
				readOnly: false,
				allowWrites: true,
				investigate: false,
				agentic: false,
				confidence: 'high',
				reason: 'escalation:pasted-error',
			});
		}

		return resolution;
	} catch (err) {
		console.warn('[IntentRouter] LLM router failed:', err instanceof Error ? err.message : err);
		return null;
	}
}

/**
 * Resolves intent for Auto mode via LLM only (Cursor-style). Heuristic regex is legacy/debug only.
 * @param {string} task
 * @param {object} options
 * @param {import('../adapters/OpenAICompatibleAdapter.js').OpenAICompatibleAdapter | import('../adapters/OllamaAdapter.js').OllamaAdapter | null} [adapter]
 * @returns {Promise<IntentResolution>}
 */
export async function resolveIntentPermissions(task, options = {}, adapter = null) {
	const mode = options.chatMode ?? 'auto';

	const modeResult = resolveFromMode(mode, task);
	if (modeResult) {
		return modeResult;
	}

	// Auto (+ hybrid/llm): LLM classifies intent BEFORE tools/shards — no regex scoring.
	if (mode === 'auto' && ROUTER_MODE !== 'heuristic') {
		if (adapter) {
			const llmResult = await resolveWithLlm(adapter, task, options.history ?? []);
			if (llmResult) {
				return llmResult;
			}
		}
		return fallbackResolution(task);
	}

	// Legacy heuristic mode (neurocode.chat.intentRouter = heuristic) for offline debugging only.
	return resolveUserIntent(task, options);
}

/** @deprecated Use resolveUserIntent — kept for imports */
export { resolveUserIntent as classifyIntentLegacy };
