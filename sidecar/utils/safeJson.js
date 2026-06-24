/**
 * Strips non-JSON-safe values (circular refs, sockets, axios artifacts).
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @returns {unknown}
 */
export function sanitizeForJson(value, seen = new WeakSet()) {
	if (value === null || value === undefined) {
		return value;
	}
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
		return undefined;
	}
	if (value instanceof Error) {
		return { name: value.name, message: value.message };
	}
	if (typeof value !== 'object') {
		return String(value);
	}
	if (seen.has(value)) {
		return '[Circular]';
	}
	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((item) => sanitizeForJson(item, seen));
	}

	const SKIP_KEYS = new Set([
		'socket', 'parser', '_httpMessage', 'req', 'res', 'request', 'config', 'agent', '_events',
	]);

	/** @type {Record<string, unknown>} */
	const out = {};
	for (const [key, nested] of Object.entries(value)) {
		if (SKIP_KEYS.has(key)) {
			continue;
		}
		const cleaned = sanitizeForJson(nested, seen);
		if (cleaned !== undefined) {
			out[key] = cleaned;
		}
	}
	return out;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function safeJsonStringify(value) {
	try {
		return JSON.stringify(sanitizeForJson(value));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return JSON.stringify({ type: 'error', message });
	}
}
