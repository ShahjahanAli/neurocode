# NeuroCode Enterprise Deployment

## LLM Gateway (recommended)

NeuroCode routes all chat through an **OpenAI-compatible API**. Point it at your corporate gateway, LiteLLM proxy, or self-hosted vLLM — not at a vendor-specific SDK.

```json
{
  "neurocode.llm.mode": "gateway",
  "neurocode.llm.apiBaseUrl": "https://llm-gateway.internal.company.com/v1",
  "neurocode.llm.apiKey": "YOUR_SERVICE_TOKEN",
  "neurocode.llm.model": "qwen3-coder",
  "neurocode.llm.modelSelection": "auto",
  "neurocode.llm.fallbackToOllama": false
}
```

Verify: `curl -s https://llm-gateway.internal.company.com/v1/models -H "Authorization: Bearer YOUR_TOKEN"`

**Model selection:** set `modelSelection` to `manual` and `selectedModel` to pin a specific model id from your gateway.

## RunPod / GPU Pod Setup (optional)

RunPod (or similar) is **only** for optional GPU pod lifecycle — start/stop/warmup/cost tracking. The LLM URL is still `neurocode.llm.apiBaseUrl` (the pod's vLLM proxy).

1. Deploy a pod with vLLM serving your model (e.g. Qwen3-Coder)
2. Set gateway settings to the pod proxy URL (`https://POD_ID-8000.proxy.runpod.net/v1`)
3. Optionally configure `neurocode.runpod.*` for auto-start/stop

```json
{
  "neurocode.llm.mode": "gateway",
  "neurocode.llm.apiBaseUrl": "https://POD_ID-8000.proxy.runpod.net/v1",
  "neurocode.llm.apiKey": "YOUR_PROXY_KEY",
  "neurocode.llm.model": "qwen3-coder",
  "neurocode.runpod.apiKey": "YOUR_RUNPOD_API_KEY",
  "neurocode.runpod.podId": "YOUR_POD_ID",
  "neurocode.runpod.autoStart": true,
  "neurocode.runpod.autoStop": true
}
```

## Team Deployment (Docker)

```bash
docker compose up -d
```

Each developer installs the VS Code extension and points `neurocode.sidecar.port` at the shared sidecar. Centralize `apiBaseUrl` via workspace settings or a shared `.vscode/settings.json`.

## Air-Gap Deployment

1. Set `neurocode.airgap.enabled: true`
2. Set `neurocode.llm.mode: "ollama"`
3. Run Ollama locally with `qwen2.5-coder:7b` and `nomic-embed-text`
4. Use Helm values file `charts/neurocode/values-airgap.yaml`

In air-gap mode, only Ollama is allowed for LLM calls; gateway URLs are blocked unless on a LAN address.

## Cost Optimization

- Use `neurocode.llm.modelSelection: "auto"` to route simple asks to smaller/faster models
- Set `neurocode.runpod.idleTimeoutMinutes` (default 30) when using optional pod lifecycle
- Use **NeuroCode: GPU Pod Cost Report** to track session spend
- Stop pod manually with **NeuroCode: Stop GPU Pod** when done coding
- Prefer local Ollama for embeddings-only workloads (embeddings always use Ollama)
