# NeuroCode Enterprise Deployment

## RunPod Setup

1. Deploy a RunPod pod with **L4 24GB** and vLLM serving `Qwen/Qwen2.5-Coder-32B-Instruct-AWQ`
2. Note the proxy URL (`https://POD_ID-8000.proxy.runpod.net/v1`) and API key
3. Configure VS Code settings (`neurocode.llm.*` and `neurocode.runpod.*`)

Verify: `node sidecar/scripts/test-runpod.js`

## Team Deployment (Docker)

```bash
docker compose up -d
```

Each developer installs the VS Code extension and points `neurocode.sidecar.port` at the shared sidecar.

## Air-Gap Deployment

1. Set `neurocode.airgap.enabled: true`
2. Run Ollama locally with `qwen2.5-coder:7b` and `nomic-embed-text`
3. Use Helm values file `charts/neurocode/values-airgap.yaml`

## Cost Optimization

- Set `neurocode.runpod.idleTimeoutMinutes` (default 30)
- Use `neurocode.showCostReport` to track session spend
- Stop pod manually with **NeuroCode: Stop RunPod** when done coding
