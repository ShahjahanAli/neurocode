import { stripNeuroCodeAppendix } from './DiffApplier';

/** Tail length passed to the model so it can resume mid-stream. */
const CONTINUE_TAIL_CHARS = 3000;

/**
 * @param response - LLM response text.
 * @returns Whether the response ends with an unclosed code fence.
 */
export function isTruncatedResponse(response: string): boolean {
	const source = stripNeuroCodeAppendix(response);
	const fences = (source.match(/```/g) ?? []).length;
	return fences % 2 !== 0;
}

/**
 * Strips common preamble the model repeats on continuation turns.
 * @param text - Continuation segment.
 * @returns Trimmed continuation body.
 */
function stripContinuationPreamble(text: string): string {
	let next = text.trim();
	const preamblePatterns = [
		/^here(?:'s| is) the (?:rest|continuation|remaining)[\s\S]*?\n+/i,
		/^continuing (?:from|where)[\s\S]*?\n+/i,
		/^as requested[\s\S]*?\n+/i,
	];

	for (const pattern of preamblePatterns) {
		next = next.replace(pattern, '');
	}

	return next.trim();
}

/**
 * Merges a continuation segment into the accumulated implement output.
 * @param previous - Text generated so far in this batch.
 * @param continuation - New segment from the next LLM call.
 * @returns Combined response text.
 */
export function mergeContinuation(previous: string, continuation: string): string {
	const prev = stripNeuroCodeAppendix(previous).trimEnd();
	let next = stripContinuationPreamble(continuation);
	if (!next) {
		return prev;
	}

	if (isTruncatedResponse(prev)) {
		return prev + next;
	}

	return `${prev}\n\n${next}`;
}

/**
 * Builds the sidecar task prompt for an automatic continuation round.
 * @param accumulated - Full text generated in prior batch rounds.
 * @returns Continuation task for the LLM.
 */
export function buildContinuePrompt(accumulated: string): string {
	const tail = accumulated.slice(-CONTINUE_TAIL_CHARS);
	return `Continue EXACTLY where you left off in the previous assistant message. Do not restart files that are already complete.

Your previous output ended with:
---
${tail}
---

Rules:
- Output ONLY the continuation (finish any truncated code fence, then any remaining files)
- Each file must use a fenced block with // filename: relative/path as the first line inside the block
- Output COMPLETE file contents — never stop mid-function
- Do not repeat prose or files that were already fully written`;
}
