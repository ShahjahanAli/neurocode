/**
 * RunPod / vLLM connection smoke test.
 * Usage: VLLM_URL=... VLLM_KEY=... VLLM_MODEL=... node sidecar/scripts/test-runpod.js
 */

const baseUrl = (process.env.VLLM_URL || '').replace(/\/$/, '');
const apiKey = process.env.VLLM_KEY || '';
const model = process.env.VLLM_MODEL || '';

async function test(name, fn) {
	try {
		await fn();
		console.log(`✓ ${name}`);
	} catch (err) {
		console.error(`✗ ${name}:`, err.message);
		process.exitCode = 1;
	}
}

await test('GET /models', async () => {
	const res = await fetch(`${baseUrl}/models`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = await res.json();
	if (!data.data?.some((m) => m.id === model)) {
		throw new Error(`Model ${model} not in list`);
	}
});

await test('POST /chat/completions', async () => {
	const res = await fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model,
			messages: [{ role: 'user', content: 'ready' }],
			max_tokens: 5,
		}),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
});

console.log('All RunPod tests passed');
