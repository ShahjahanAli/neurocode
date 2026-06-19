# NeuroCode

**Agentic coding for VS Code** — intelligent context shards, local or cloud LLMs, and a full agent loop on modest hardware.

[![GitHub](https://img.shields.io/github/stars/ShahjahanAli/neurocode?style=social)](https://github.com/ShahjahanAli/neurocode)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.120-blue)](https://code.visualstudio.com/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-green)](https://nodejs.org/)

NeuroCode is a VS Code extension that routes only the *relevant* parts of your codebase to an LLM before every agent call. It runs a local Node.js **sidecar** for indexing, embeddings, shard assembly, and orchestration, while the extension host handles the UI, editor integration, and diff review.

Primary backend: **vLLM on RunPod** (Qwen3-Coder). Automatic fallback: **Ollama** on your machine. Embeddings always stay local via Ollama (`nomic-embed-text`).

---

## Why NeuroCode?

Most coding assistants stuff entire repos into context or depend on 32K+ context windows. NeuroCode takes a different approach:

1. **Shard architecture** — Assembles a small, ranked context pack (active file → imports → callers → memory → semantic matches) within a strict token budget (3.5K Ollama / 6K RunPod).
2. **Pluggable LLM routing** — Tries RunPod vLLM first, falls back to Ollama silently when the pod is offline.
3. **RunPod lifecycle** — Auto-start, warmup, idle auto-stop, and cost tracking so you only pay when coding.
4. **Acquisition-grade features** — Multi-agent review, project memory, causal debug, semantic drift detection, optional air-gap mode, and opt-in edit genome telemetry.

---

## Features

| Feature | Description |
|---------|-------------|
| **Ask Agent** | Single-turn coding tasks with shard-aware context and diff preview |
| **Shard Visualizer** | See exactly which files were sent to the LLM and why |
| **Task Queue** | Multi-step planner with DAG execution across up to 8 steps |
| **Code Review** | 4 parallel specialist agents (architect, security, performance, test) |
| **Project Memory** | Remembers accepted edits and boosts similar future context |
| **Causal Debug** | Stack trace → root cause analysis with gutter highlighting |
| **Attention Heatmap** | Gutter overlays showing in-context, cited, and missed lines |
| **RunPod Manager** | Start/stop pod, warmup, idle timeout, session cost report |
| **Air-Gap Mode** | Blocks external HTTP; Ollama-only for regulated environments |

---

## Architecture

```mermaid
flowchart LR
  subgraph vscode [VS Code Extension]
    UI[React WebViews]
    CMD[Commands / Heatmap]
    SCM[SidecarManager]
  end

  subgraph sidecar [Sidecar :39291]
    IDX[Indexer + CodeGraph]
    SH[ShardManager]
    VEC[VectorStore]
    AGT[Agent / Review / Debug]
  end

  subgraph llm [LLM Backends]
    RP[RunPod vLLM]
    OL[Ollama]
  end

  SCM -->|HTTP| sidecar
  sidecar -->|chat| RP
  sidecar -->|fallback chat| OL
  sidecar -->|embeddings always| OL
```

**Three processes:**

- **Extension host** (TypeScript) — UI, commands, spawns sidecar, never calls LLMs directly
- **Sidecar** (Node.js) — indexing, SQLite, vectra, agent orchestration, REST API on `127.0.0.1:39291`
- **LLM backend** — RunPod vLLM and/or local Ollama

---

## Requirements

| Dependency | Version | Purpose |
|------------|---------|---------|
| [VS Code](https://code.visualstudio.com/) | ≥ 1.120 | Extension host |
| [Node.js](https://nodejs.org/) | ≥ 22.5 | Runs the sidecar child process |
| [Ollama](https://ollama.ai/) | latest | Fallback LLM + **all embeddings** |
| RunPod + vLLM | optional | Primary Qwen3-Coder backend |

### Ollama models (required)

```bash
ollama pull qwen2.5-coder:7b
ollama pull nomic-embed-text
```

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/ShahjahanAli/neurocode.git
cd neurocode
npm install
```

### 2. Build

```bash
npm run compile
```

This builds the React webview UI and bundles the extension to `dist/extension.js`.

### 3. Run in VS Code

1. Open the `neurocode` folder in VS Code.
2. Press **F5** to launch an **Extension Development Host**.
3. In the new window, open a project folder.
4. Run **NeuroCode: Index Project** from the Command Palette (`Ctrl+Shift+P`).
5. Press **Ctrl+Shift+A** to **Ask Agent**, or open the **NeuroCode** sidebar.

### 4. Configure (Settings → search `neurocode`)

**Local only (Ollama):**

```json
{
  "neurocode.llm.provider": "ollama",
  "neurocode.llm.ollamaUrl": "http://localhost:11434",
  "neurocode.llm.ollamaModel": "qwen2.5-coder:7b",
  "neurocode.runpod.autoStart": false
}
```

**RunPod + vLLM (recommended for best quality):**

```json
{
  "neurocode.llm.provider": "vllm",
  "neurocode.llm.vllmUrl": "https://YOUR_POD_ID-8000.proxy.runpod.net/v1",
  "neurocode.llm.vllmApiKey": "YOUR_RUNPOD_API_KEY",
  "neurocode.llm.vllmModel": "Qwen/Qwen2.5-Coder-32B-Instruct-AWQ",
  "neurocode.runpod.apiKey": "YOUR_RUNPOD_API_KEY",
  "neurocode.runpod.podId": "YOUR_POD_ID",
  "neurocode.runpod.autoStart": true,
  "neurocode.runpod.autoStop": true,
  "neurocode.runpod.idleTimeoutMinutes": 30
}
```

Set `neurocode.shard.maxTokens` to `0` for automatic budgets (3500 Ollama / 6000 RunPod).

---

## Commands & Keybindings

| Command | Keybinding | Description |
|---------|------------|-------------|
| **NeuroCode: Ask Agent** | `Ctrl+Shift+A` | Single-turn agent with shard assembly |
| **NeuroCode: Review Code** | `Ctrl+Shift+R` | 4-agent parallel code review |
| **NeuroCode: Find Root Cause** | `Ctrl+Shift+D` | Causal debug from stack trace |
| **NeuroCode: Index Project** | — | Index workspace for shards & search |
| **NeuroCode: Plan Multi-Step Task** | — | Create an agent task DAG |
| **NeuroCode: Explain Context** | — | Preview shards without calling LLM |
| **NeuroCode: Start / Stop RunPod** | — | Manual pod lifecycle control |
| **NeuroCode: RunPod Cost Report** | — | Session cost history |
| **NeuroCode: Toggle Air-Gap Mode** | — | Enable offline-only operation |

Sidebar panels: **Chat**, **Task Queue**, **Shard Visualizer**, **Code Review**, **Project Memory**, **Debug**.

---

## Project Layout

```
neurocode/
├── src/                 # VS Code extension (TypeScript)
│   ├── extension.ts     # Activation, status bar, webview registration
│   ├── commands/        # Command handlers
│   ├── panels/          # WebView providers
│   ├── editor/          # Attention heatmap
│   └── sidecar/         # SidecarManager + HTTP client
├── sidecar/             # Node.js agent server (port 39291)
│   ├── server.js
│   ├── core/            # ShardManager, LLMRouter, memory, review, …
│   ├── routes/          # REST API
│   └── db/              # SQLite schema
├── webview-ui/          # React sidebar UI (Vite)
├── media/               # Icons and gutter assets
├── BLUEPRINT.md         # Full architecture guide
├── CURSOR_PROMPTS.md    # Step-by-step build playbook
└── README-ENTERPRISE.md # Docker, Helm, team deployment
```

Indexing data is stored per project in `.neurocode/` (gitignored by default via `.neurocodeignore`).

---

## Development

```bash
# Watch mode (extension + typecheck)
npm run watch

# Webview only
npm run build:webview

# Lint + typecheck
npm run lint
npm run check-types

# Test RunPod connectivity
VLLM_URL="https://..." VLLM_KEY="..." VLLM_MODEL="..." node sidecar/scripts/test-runpod.js
```

### Debugging

- **F5** — launches Extension Development Host with preLaunch build.
- **Output → NeuroCode** — sidecar stdout/stderr logs.
- Sidecar health: `curl http://127.0.0.1:39291/health`

---

## Enterprise & Team Deployment

See [README-ENTERPRISE.md](./README-ENTERPRISE.md) for Docker Compose, Kubernetes Helm charts, air-gap deployment, and cost tuning.

```bash
docker compose up -d   # shared sidecar + Ollama
```

---

## Publishing to the VS Code Marketplace

NeuroCode can be published so users can install it from the Extensions view:

```bash
npm install -g @vscode/vsce
npm run package
vsce package
vsce publish   # requires publisher account matching package.json "publisher"
```

Before publishing, ensure `sidecar/node_modules` is included in the `.vsix` (adjust `.vscodeignore` if needed), add a `LICENSE`, marketplace icon (128×128 PNG), and a complete README.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Status bar shows **Sidecar failed** | Confirm Node.js 22.5+ is on your PATH; check **Output → NeuroCode** |
| No semantic search / empty shards | Ensure Ollama is running and `nomic-embed-text` is pulled |
| RunPod not connecting | Verify `vllmUrl` ends with `/v1`; test with `sidecar/scripts/test-runpod.js` |
| Blank sidebar panels | Run `npm run compile` to build `webview-ui/dist/` |
| Port in use | Change `neurocode.sidecar.port` (default `39291`) |

---

## Documentation

- [BLUEPRINT.md](./BLUEPRINT.md) — Architecture and API contract
- [QUICK_REFERENCE.md](./QUICK_REFERENCE.md) — Token budgets, pod states, key numbers
- [CURSOR_PROMPTS.md](./CURSOR_PROMPTS.md) — Phased implementation guide
- [.cursorrules](./.cursorrules) — Project conventions for contributors and AI agents

---

## Contributing

Contributions are welcome. Please open an issue before large changes. Follow the conventions in `.cursorrules` and the build order in `CURSOR_PROMPTS.md`.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-change`)
3. Run `npm run compile` and ensure it passes
4. Open a pull request with a clear description

---

## Author

Built by **[Shahjahan Ali](https://github.com/ShahjahanAli)** · [ZMS Digital Solutions](https://github.com/ShahjahanAli) · Dhaka, Bangladesh

Related work: [HyperZ](https://github.com/ShahjahanAli/HyperZ) (AI-native enterprise SaaS framework)

---

## License

MIT © 2026 [Shahjahan Ali](https://github.com/ShahjahanAli) / ZMS Digital Solutions — see [LICENSE](./LICENSE).
