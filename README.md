# NeuroCode

**Agentic coding for VS Code** — intelligent context shards, local or cloud LLMs, and a full agent loop on modest hardware.

[![GitHub](https://img.shields.io/github/stars/ShahjahanAli/neurocode?style=social)](https://github.com/ShahjahanAli/neurocode)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.120-blue)](https://code.visualstudio.com/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-green)](https://nodejs.org/)

NeuroCode is a VS Code extension that routes only the *relevant* parts of your codebase to an LLM before every agent call. It runs a local Node.js **sidecar** for indexing, embeddings, shard assembly, and orchestration, while the extension host handles the UI, editor integration, and diff review.

**LLM backend:** any **OpenAI-compatible API** — your custom AI gateway (LiteLLM-style), vLLM on RunPod, OpenAI, or another cloud proxy. Point `neurocode.llm.apiBaseUrl` at `/v1` and NeuroCode handles the rest. **Local Ollama** is supported as a dedicated mode or optional fallback. Embeddings always stay local via Ollama (`nomic-embed-text`).

## About

NeuroCode is a **VS Code extension for agentic coding with local and cloud LLMs**. Instead of sending your whole repo to a model, it builds small **context shards** from the files that matter—active file, imports, callers, memory, semantic matches, and user attachments—within a strict token budget.

Connect **any OpenAI-compatible gateway** — including a future custom NeuroCode gateway — or run **Ollama locally** for zero cloud cost. The extension includes chat, model auto-selection, file attachments, change review, analytics, multi-step task planning, four-agent code review, causal debugging, project memory, and optional air-gap mode.

---

## Why NeuroCode?

Most coding assistants stuff entire repos into context or depend on 32K+ context windows. NeuroCode takes a different approach:

1. **Shard architecture** — Assembles a small, ranked context pack (active file → imports → callers → attachments → memory → semantic matches) within a strict token budget (3.5K Ollama / 6K gateway).
2. **OpenAI-compatible gateway** — One config surface (`apiBaseUrl`, `apiKey`, `model`) works with LiteLLM, vLLM, RunPod proxies, OpenAI, or your own routing layer.
3. **Smart model selection** — **Auto** picks the best model per task; **Manual** chooses from `GET /v1/models`. Separate from chat intent Auto mode.
4. **Optional GPU pod lifecycle** — RunPod start/stop/warmup/cost tracking when `neurocode.runpod.*` is configured (independent of gateway URL).
5. **Acquisition-grade features** — Multi-agent review, project memory, causal debug, semantic drift, edit genome, analytics, change review, optional air-gap mode.

---

## Features

| Feature | Description |
|---------|-------------|
| **Overview hub** | Activity-bar landing page: model/index/status, active settings, and links to every feature |
| **Cursor-like Chat** | Natural-language chat on the **right sidebar** with Auto / Ask / Plan / Edit / Agent modes |
| **Model picker** | **Auto** (optimal model per task) or **Manual** selection from gateway `/v1/models` list |
| **File attachments** | Attach current file, editor selection, or browse files — injected as high-priority shards |
| **Change review** | Cursor-style Accept / Reject per file, diff editor, Accept All / Reject All |
| **Analytics** | Token usage, latency, and thumbs up/down feedback per response |
| **Intent routing** | Infers explain vs plan vs implement from conversation (history-aware, not keyword-only) |
| **Agent tool loop** | Agent mode: `read_file` → `search_code` → `write_file` → `reply` (Cursor-style) |
| **Auto-apply edits** | Implement mode writes files when generation completes (configurable) |
| **Auto-continue** | Cursor-style batch continuation for large / truncated file outputs |
| **Fix on check** | Checking an incomplete file auto-routes to implement and writes the fix |
| **Collapsible code cards** | Large code blocks collapse in chat; expand to view full file |
| **Ask Agent** | Single-turn coding tasks with shard-aware context and diff preview |
| **Shard Visualizer** | See exactly which files were sent to the LLM and why |
| **Task Queue** | Multi-step planner with DAG-aware step execution |
| **Code Review** | 4 parallel specialist agents (architect, security, performance, test) |
| **Project Memory** | Remembers accepted edits and boosts similar future context |
| **Semantic Drift** | Alerts when symbol embeddings shift after git commits |
| **Edit Genome** | Opt-in anonymized edit telemetry stats and JSONL export |
| **Causal Debug** | Stack trace → root cause analysis with gutter highlighting |
| **Attention Heatmap** | Gutter overlays showing in-context, cited, and missed lines |
| **GPU pod manager** | Optional RunPod start/stop, warmup, idle timeout, session cost |
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
    GW[OpenAI-compatible gateway]
    OL[Ollama local / fallback]
  end

  SCM -->|HTTP| sidecar
  sidecar -->|chat /v1/chat/completions| GW
  sidecar -->|ollama mode or fallback| OL
  sidecar -->|embeddings always| OL
```

**Three processes:**

- **Extension host** (TypeScript) — UI, commands, spawns sidecar, never calls LLMs directly
- **Sidecar** (Node.js) — indexing, SQLite, vectra, agent orchestration, REST API on `127.0.0.1:39291`
- **LLM backend** — Any OpenAI-compatible endpoint; Ollama for local-only or fallback; embeddings always via Ollama

---

## Requirements

| Dependency | Version | Purpose |
|------------|---------|---------|
| [VS Code](https://code.visualstudio.com/) | ≥ 1.120 | Extension host |
| [Node.js](https://nodejs.org/) | ≥ 22.5 | Runs the sidecar child process |
| [Ollama](https://ollama.ai/) | latest | Embeddings (`nomic-embed-text`) + local LLM mode / fallback |
| OpenAI-compatible gateway | optional | vLLM, LiteLLM, RunPod proxy, OpenAI, custom gateway |
| RunPod | optional | Optional GPU pod lifecycle only (not required for LLM routing) |

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
5. Press **Ctrl+Shift+A** to **Ask Agent**, or open **NeuroCode → Chat** on the **right sidebar** (Cursor-style).

### Chat modes (sidebar toolbar)

| Mode | What it does |
|------|----------------|
| **Auto** | Infers intent from natural language + conversation history (default) |
| **Ask** | Explain, review, discuss — no file writes |
| **Plan** | Multi-step JSON plan stored in SQLite |
| **Edit** | Generate code and apply to the project |
| **Agent** | Tool loop: read → search → write → reply, auto-applies files |

Talk naturally — e.g. `can you check service.ts`, `yes go ahead`, `handle auth end to end`. Social replies like `thanks` stay in Ask mode (no accidental writes).

### Model picker (chat toolbar)

| Selection | Behavior |
|-----------|----------|
| **Auto** | Sidecar picks the best model per request (explain → fast; implement/agent → coder models) |
| **Manual** | Uses your choice from the gateway's `GET /v1/models` list |

Model **Auto** is separate from chat mode **Auto** (intent). After streaming starts, the picker shows which model was used (e.g. `Auto · qwen3-coder`).

### Attachments (paperclip menu)

Attach **current file**, **editor selection**, or **browse files** before sending. Attached content is injected at shard priority 0 (`attached file` / `attached selection`).

### 4. Configure (Settings → search `neurocode`)

**Local only (Ollama):**

```json
{
  "neurocode.llm.mode": "ollama",
  "neurocode.llm.ollamaUrl": "http://localhost:11434",
  "neurocode.llm.ollamaModel": "qwen2.5-coder:7b"
}
```

**OpenAI-compatible gateway (recommended):**

Works with RunPod vLLM proxy, LiteLLM, OpenAI, or your custom AI gateway:

```json
{
  "neurocode.llm.mode": "gateway",
  "neurocode.llm.apiBaseUrl": "https://your-gateway.example.com/v1",
  "neurocode.llm.apiKey": "your-bearer-token",
  "neurocode.llm.model": "qwen3-coder",
  "neurocode.llm.modelSelection": "auto",
  "neurocode.llm.fallbackToOllama": false
}
```

**RunPod vLLM proxy example** (gateway URL = pod proxy, not RunPod API):

```json
{
  "neurocode.llm.mode": "gateway",
  "neurocode.llm.apiBaseUrl": "https://YOUR_POD_ID-8000.proxy.runpod.net/v1",
  "neurocode.llm.apiKey": "YOUR_RUNPOD_OR_GATEWAY_KEY",
  "neurocode.llm.model": "qwen3-coder",
  "neurocode.runpod.apiKey": "YOUR_RUNPOD_API_KEY",
  "neurocode.runpod.podId": "YOUR_POD_ID",
  "neurocode.runpod.autoStart": true,
  "neurocode.runpod.autoStop": true
}
```

Legacy settings (`neurocode.llm.vllmUrl`, `openaiUrl`, etc.) still map to the new fields automatically.

Set `neurocode.shard.maxTokens` to `0` for automatic budgets (3500 Ollama / 6000 gateway).

**Chat & agent settings:**

```json
{
  "neurocode.ui.chatLocation": "right",
  "neurocode.chat.mode": "auto",
  "neurocode.chat.autoApply": true,
  "neurocode.chat.autoContinue": true,
  "neurocode.chat.maxContinueRounds": 8,
  "neurocode.chat.fixOnCheck": true,
  "neurocode.chat.agentToolMaxSteps": 10,
  "neurocode.chat.maxAttachments": 5,
  "neurocode.feedback.enabled": true,
  "neurocode.indexing.autoIndex": true
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `neurocode.llm.mode` | `gateway` | `gateway` = OpenAI-compatible API; `ollama` = local only |
| `neurocode.llm.apiBaseUrl` | — | Gateway URL with `/v1` suffix |
| `neurocode.llm.apiKey` | — | Bearer token (if required) |
| `neurocode.llm.model` | `qwen2.5-coder:7b` | Default / fallback model id |
| `neurocode.llm.modelSelection` | `auto` | `auto` or `manual` model picker |
| `neurocode.llm.selectedModel` | — | Model when `modelSelection` is `manual` |
| `neurocode.llm.fallbackToOllama` | `false` | Use local Ollama if gateway is unreachable |
| `neurocode.ui.chatLocation` | `right` | Chat on secondary sidebar or `left` activity bar |
| `neurocode.chat.mode` | `auto` | Default chat intent mode |
| `neurocode.chat.autoApply` | `true` | Write generated files without manual Accept |
| `neurocode.chat.autoContinue` | `true` | Continue truncated implement output automatically |
| `neurocode.chat.fixOnCheck` | `true` | Incomplete file + check/review → implement + write |
| `neurocode.chat.maxAttachments` | `5` | Max files/selections per message |
| `neurocode.chat.agentToolMaxSteps` | `10` | Max tool iterations per Agent mode request |

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
| **NeuroCode: Start / Stop GPU Pod** | — | Optional RunPod lifecycle (if configured) |
| **NeuroCode: GPU Pod Cost Report** | — | Session cost history |
| **NeuroCode: Toggle Air-Gap Mode** | — | Enable offline-only operation |

Sidebar panels:

- **Right secondary sidebar (default):** **NeuroCode** tabbed panel — **Overview** | **Chat** | **Analytics** | **Tasks** | **Shards** | **Review** | **Memory** | **Drift** | **Genome** | **Debug**
- **Left activity bar:** **Overview** (when chat is on left), **Tasks**, **Shards**, **Review**, **Memory**, **Debug**

Set `neurocode.ui.chatLocation` to `left` to dock Chat with the other panels.

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
├── webview-ui/          # React sidebar UI (Vite)
│   └── src/components/  # CollapsibleCodeBlock, MessageMarkdown, …
├── sidecar/             # Node.js agent server (port 39291)
│   ├── server.js
│   ├── core/            # ShardManager, ChatOrchestrator, IntentResolver,
│   │                    # ModelSelector, AgentToolLoop, OpenAICompatibleAdapter, …
│   ├── routes/          # REST + SSE API (agent, llm, analytics, …)
│   └── db/              # SQLite schema
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

# Test gateway connectivity (OpenAI-compatible /v1/models)
curl -s https://your-gateway/v1/models -H "Authorization: Bearer YOUR_KEY"
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
| Gateway not connecting | Verify `apiBaseUrl` ends with `/v1`; test with `curl …/v1/models` |
| Model list empty in picker | Check gateway exposes `GET /v1/models`; click **Refresh list** |
| **Chat stream ended without a response** | Reload extension; check `apiBaseUrl` / `apiKey`; read sidecar logs |
| Chat wrote files after `thanks` | Update extension — social acks no longer trigger implement |
| Blank sidebar panels | Run `npm run compile` to build `webview-ui/dist/` |
| Chat not on right | Set `neurocode.ui.chatLocation` to `right` and reload window |
| Port in use | Change `neurocode.sidecar.port` (default `39291`) |

---

## Documentation

- [BLUEPRINT.md](./BLUEPRINT.md) — Architecture and API contract
- [QUICK_REFERENCE.md](./QUICK_REFERENCE.md) — Chat modes, token budgets, API, settings
- [CHANGELOG.md](./CHANGELOG.md) — Release history
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
