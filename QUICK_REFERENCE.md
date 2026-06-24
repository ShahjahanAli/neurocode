# NeuroCode — Quick Reference Card v3.3
## Primary: OpenAI-compatible gateway | Local: Ollama | Optional: RunPod pod lifecycle

---

## Chat & Agent (Cursor-style)

### UI layout

| Panel | Location | Setting |
|---|---|---|
| **Chat, Analytics, Drift, Genome** | Right secondary sidebar (default) | `neurocode.ui.chatLocation: right` |
| Overview, Tasks, Shards, Review, Memory, Debug | Right sidebar tabs (same panel) | — |

Reload window after changing `chatLocation`.

### Model picker (chat toolbar)

| Selection | Behavior |
|---|---|
| **Auto** | `ModelSelector` picks best model per intent (explain → fast; implement/agent → coder) |
| **Manual** | Uses `neurocode.llm.selectedModel` from `GET /v1/models` |

Separate from chat mode **Auto** (intent routing). SSE `intent` event includes resolved `model`.

### Attachments (paperclip)

| Type | Shard reason |
|---|---|
| Current file | `attached file` |
| Editor selection | `attached selection` |
| Browsed files | `attached file` |

Max: `neurocode.chat.maxAttachments` (default 5). Priority 0 in shard assembly.

### Chat modes (toolbar)

| Mode | Sidecar behavior | Writes files? |
|---|---|---|
| **Auto** | LLM `IntentRouter` → `AgentToolLoop`; `seed_paths` from errors/stack traces | If router allows writes |
| **Ask** | Investigate loop (read-only: `read_file`, `search_code`, `reply`) | No |
| **Plan** | JSON plan → SQLite `plans` / `plan_steps` | No |
| **Edit** | Implement prompt + optional auto-continue | Yes if `autoApply` |
| **Agent** | `AgentToolLoop` (session-state prompts, max `agentToolMaxSteps`) | Yes if `autoApply` |

### Agent session state (token-efficient loop)

Each agent step **rebuilds** the LLM prompt from sidecar state — it does **not** append full chat history.

| In session (sidecar) | In LLM prompt (per step) |
|---|---|
| Full file bodies after `read_file` | Task + session log (≤8 lines) |
| Tool log, pending writes | ≤3 file previews (~1.2k chars each) |
| Corruption flags | One-line nudge from last tool |

Target input: **~2–4k tokens per step** (flat), not linear growth.

### Agent tools (fenced `neurocode-tool` JSON block)

| Tool | Args | Notes |
|---|---|---|
| `read_file` | `path`, `max_chars?` (default 6000) | Updates session file cache |
| `search_code` | `query`, `limit?` | Vector + SQLite path match |
| `search_replace` | `path`, `old_text`, `new_text` | **Preferred** for small fixes |
| `write_file` | `path`, `content` | Full file only; must be complete fenced JSON |
| `reply` | `message` | Terminal — ends loop |

**Write safety:** Tool JSON is rejected by sidecar staging and extension `applyPendingWrites`. Agent `mode: tool-loop` skips markdown `parseCodeBlocks` auto-apply.

### Chat settings (defaults)

| Setting | Default |
|---|---|
| `neurocode.ui.chatLocation` | `right` |
| `neurocode.chat.mode` | `auto` |
| `neurocode.chat.intentRouter` | `llm` |
| `neurocode.chat.autoApply` | `true` |
| `neurocode.chat.autoContinue` | `true` |
| `neurocode.chat.maxContinueRounds` | `8` |
| `neurocode.chat.fixOnCheck` | `true` |
| `neurocode.chat.agentMaxSteps` | `8` (plan-step agent) |
| `neurocode.chat.agentToolMaxSteps` | `10` (tool loop) |
| `neurocode.chat.maxAttachments` | `5` |
| `neurocode.llm.mode` | `gateway` |
| `neurocode.llm.modelSelection` | `auto` |
| `neurocode.llm.maxOutputTokens` | `2048` (use `4096` for large `write_file`) |
| `neurocode.indexing.autoIndex` | `true` |

### Intent routing (`IntentRouter.js`)

- **Auto + `intentRouter: llm`** — LLM returns `intent`, `allow_writes`, `seed_paths` (default)
- Pasted runtime errors → `edit` + writes + paths from stack trace
- **Ask pill** → read-only investigate loop (never `write_file`)
- `hybrid` / `heuristic` — debug/fallback only

---

## System Architecture

```
Extension Host (TypeScript)     Sidecar Node.js :39291           LLM Backend
────────────────────────        ────────────────────────          ──────────────────
extension.ts                    server.js                         GATEWAY (primary)
SidecarManager.ts    ──►        LLMRouter.js             ──►     OpenAI-compatible /v1
SidecarClient.ts                  ├─ OpenAICompatibleAdapter.js     LiteLLM / vLLM / custom
AttentionHeatmap.ts               └─ OllamaAdapter.js    ──►     Ollama (mode or fallback)
ChatPanel.ts                    ChatOrchestrator.js
ModelPicker.tsx                 ModelSelector.js
ChatAttachments.tsx             IntentResolver.js
MessageMarkdown.tsx             AgentToolLoop.js
CollapsibleCodeBlock.tsx        AgentTools.js
ReviewPanel.ts                  FileReview.js
DriftPanel.tsx                  FileQueue.js
GenomePanel.tsx                 ShardManager.js
DebugPanel.ts                   RunPodLifecycleManager.js (optional)
TaskQueuePanel.ts               MultiAgentRunner.js      EMBEDDINGS (always Ollama)
LlmConnectionBadge.tsx          ProjectMemoryGraph.js    ──►     nomic-embed-text
                                SemanticDriftDetector.js          localhost:11434
                                CausalDebugAgent.js
                                CrossRepoIndexer.js
                                EditGenomeCollector.js
                                AirGapModeManager.js
```

---

## Key Numbers

| Parameter | Gateway mode | Ollama mode |
|---|---|---|
| Token budget per shard | **6000** | **3500** |
| LLM model | From gateway (`model` / auto picker) | `ollamaModel` setting |
| Timeout per call | 120 seconds | 60 seconds |
| Cost | Gateway billing | $0 local |

| Other Parameters | Value |
|---|---|
| Sidecar port | 39291 (127.0.0.1 only) |
| Max plan steps | 8 |
| Max implement output tokens | up to 4000 (gateway budget − 500) |
| Default `maxOutputTokens` | **2048** (`neurocode.llm.maxOutputTokens`) |
| Agent step output cap | `getAgentOutputTokens()` — min 2048, max 8000 |
| Agent prompt target (input) | **~2–4k** per step (session rebuild) |
| Max agent tool steps | 10 (`agentToolMaxSteps`) |
| Auto-continue rounds | 8 (`maxContinueRounds`) |
| Collapse code blocks at | 5+ lines |
| Temperature — code | 0.1 |
| Temperature — planning | 0.3 |
| Temperature — review | 0.5 |
| Temperature — explanation | 0.7 |
| Embedding model | nomic-embed-text (always Ollama) |
| Vector search top-K | 3 |
| Max parallel agents | 4 |
| Idle timeout default | 30 minutes |
| Pod start timeout | 3 minutes |
| Warmup call max_tokens | 5 |
| Drift threshold | 0.15 cosine distance |

---

## RunPod Pod State Machine (optional — `neurocode.runpod.*`)

```
stopped ──[start()]──► starting ──[/v1/models ready]──► running ──[warmup]──► warm
  ▲                                                                              │
  └──[stop() / idle timeout]──◄── stopping ◄──[stop()]────────────────────────┘

warm → LLM call → warm (idle timer resets)
warm → idle timer fires → stopping → stopped
any error → unknown → manual restart
```

## Status Bar States

| State | Status Bar Text (examples) |
|---|---|
| gateway connected | `$(cloud) NeuroCode \| {model} \| {N} files` |
| ollama mode | `$(server) NeuroCode \| {ollamaModel} \| {N} files` |
| pod starting (optional) | `$(sync~spin) NeuroCode \| Starting GPU pod...` |
| air-gap | `$(shield) NeuroCode [AIR-GAP] \| {model} \| {N} files` |

---

## Shard Priority Order

| Priority | Source | Token Budget Rule |
|---|---|---|
| 0 | User attachments (file / selection) | High priority — included when possible |
| 1 | Active file (cursor) | Never cut, never removed |
| 2 | Files active file imports | From SQLite dependencies |
| 3 | Files that import active file | Callers |
| 4 | Project Memory hits | Weighted by past decisions |
| 5 | Vector similarity top-3 | Semantic match via nomic-embed |
| 6 | Type definitions | Last to add, first to cut |

Budget: **6000 tokens** in gateway mode · **3500 tokens** in Ollama mode (or `maxTokens: 0` for auto)

---

## Commands

| Command | Keybinding | Description |
|---|---|---|
| neurocode.askAgent | Ctrl+Shift+A | Ask agent (auto-starts pod if stopped) |
| neurocode.reviewCode | Ctrl+Shift+R | 4 parallel specialist agents |
| neurocode.debugCause | Ctrl+Shift+D | Stack trace → root cause |
| neurocode.startPod | — | Manually start optional GPU pod |
| neurocode.stopPod | — | Manually stop optional GPU pod |
| neurocode.planTask | — | Multi-step task planner |
| neurocode.indexProject | — | Re-index full project |
| neurocode.showMemory | — | Open project memory viewer |
| neurocode.toggleAirGap | — | Toggle air-gap mode (needs restart) |

---

## Full API Contract

```
Core
  GET  /health              → status, provider, podState, tokenBudget, fileCount

Indexer
  POST /index               → { jobId }
  GET  /index/status/:id    → { status, filesProcessed, totalFiles }

Agent
  POST /agent/ask              → legacy single-turn (no intent routing)
  POST /agent/chat             → orchestrated chat (intent + history)
  POST /agent/chat/stream      → SSE: intent (incl. model), token, done, error
  POST /agent/loop/stream      → SSE: step, tool_start, tool_result, token, done

LLM
  GET  /llm/models             → { models[] } from gateway
  POST /llm/resolve            → { modelId, reason } for auto/manual selection
  POST /agent/plan             → { planId, steps[] }
  POST /agent/plan/:id/execute → { stepId, status, response, diff }

Shards
  GET  /shards/preview      → { shards[], totalTokens, budget, provider }

Review
  POST /review/start        → { reviewId, agents[] }
  GET  /review/:id/stream   (SSE) → streams agent results

Memory
  POST /memory/record       → { memoryId }
  GET  /memory/query        → { memories[] }
  GET  /memory/top          → { memories[] }
  DELETE /memory/:id        → { deleted }

Debug
  POST /debug/cause         → { rootCauseFile, rootCauseLine, fix, causalChain[] }

Drift
  GET  /drift/status        → { driftedFunctions[] }
  POST /drift/acknowledge/:id → { acknowledged }

Genome
  POST /genome/consent      → records opt-in/out decision
  GET  /genome/status       → { enabled, recordCount }
  GET  /genome/stats        → { totalEdits, acceptRate }
  POST /genome/export       → { filePath }

Cross-Repo
  POST /crossrepo/register  → { jobId }
  GET  /crossrepo/list      → { projects[] }
  POST /crossrepo/search    → { results[] }

RunPod Lifecycle (optional)
  GET  /runpod/status       → { podState, podId, costPerHr, sessionMinutes, idleRemainingMs }
  POST /runpod/start        → { podState: 'starting' }
  POST /runpod/stop         → { podState: 'stopping' }
  POST /runpod/warmup       → { ready: boolean, latencyMs }
  GET  /runpod/cost         → { sessionMinutes, estimatedCostUsd, currency }
```

---

## Environment Variables (All)

```bash
# Sidecar core
NEUROCODE_PORT=39291
NEUROCODE_PROJECT=/path/to/workspace

# LLM routing
NEUROCODE_LLM_MODE=gateway              # 'gateway' or 'ollama'
NEUROCODE_API_BASE_URL=https://your-gateway/v1
NEUROCODE_API_KEY=your-bearer-token
NEUROCODE_LLM_MODEL=qwen3-coder
NEUROCODE_LLM_MODEL_SELECTION=auto      # 'auto' or 'manual'
NEUROCODE_LLM_SELECTED_MODEL=           # when manual
NEUROCODE_OLLAMA_URL=http://localhost:11434
NEUROCODE_OLLAMA_MODEL=qwen2.5-coder:7b
NEUROCODE_FALLBACK_TO_OLLAMA=false

# Legacy (still mapped)
NEUROCODE_VLLM_URL=...
NEUROCODE_VLLM_KEY=...
NEUROCODE_VLLM_MODEL=...

# Shard budget (0 = auto: 6000 gateway, 3500 Ollama)
SHARD_MAX_TOKENS=0

# RunPod lifecycle
NEUROCODE_RUNPOD_KEY=your-runpod-api-key
NEUROCODE_RUNPOD_POD_ID=your-pod-id
NEUROCODE_RUNPOD_AUTO_START=true
NEUROCODE_RUNPOD_AUTO_STOP=true
NEUROCODE_RUNPOD_IDLE_MS=1800000      # 30 minutes

# Feature flags
NEUROCODE_AIRGAP=false
```

---

## SQLite Tables

| Table | Purpose |
|---|---|
| files | Indexed files (path, tokens, hash) |
| symbols | Functions/classes + embeddings |
| dependencies | Import graph |
| plans | Multi-step task plans |
| plan_steps | Steps with status + output |
| memory_records | Past decisions with weights + provider |
| symbol_embeddings_history | Drift detection snapshots |
| drift_alerts | Semantic drift notifications |
| review_sessions | Code review session metadata |
| review_findings | Per-agent findings |
| registered_repos | Cross-repo registry |
| **runpod_sessions** | **Pod start/stop + cost tracking** |

---

## Data Stored in .neurocode/

```
projectRoot/.neurocode/
├── neurocode.db              ← main SQLite
├── memory.db                 ← project memory
├── vectors/                  ← vectra vector store
├── genome/
│   ├── consent.json
│   ├── genome-{ts}.jsonl
│   └── export-{ts}.jsonl
└── .neurocode-airgap-audit.log
```

---

## Cost Estimation (RunPod L4 ~$0.44/hr)

| Usage | Monthly Cost |
|---|---|
| 2hrs/day, auto-stop | ~$27/month |
| 4hrs/day, auto-stop | ~$53/month |
| No auto-stop | ~$317/month |
| Ollama only | $0/month |

Idle auto-stop at 30 min saves ~$10–20/month vs leaving pod running.

---

## Packages

### sidecar/package.json
```json
{
  "express": "^4.18.0",       "better-sqlite3": "^9.4.0",
  "vectra": "^0.7.0",         "gpt-tokenizer": "^2.1.2",
  "chokidar": "^3.5.3",       "tree-sitter": "^0.21.0",
  "tree-sitter-javascript": "^0.21.0",
  "tree-sitter-typescript": "^0.21.0",
  "tree-sitter-python": "^0.21.0",
  "tree-sitter-php": "^0.21.0",
  "uuid": "^9.0.0",           "axios": "^1.6.0",
  "simple-git": "^3.22.0",    "node-fetch": "^3.3.0",
  "fastest-levenshtein": "^1.0.16"
}
```

---

## Three Moats

| Moat | What | Why Acquirers Buy |
|---|---|---|
| **Technical** | Shard arch on 7B models + gateway-agnostic LLM routing | Google device runtime / Meta on-prem Copilot |
| **Data** | Edit Genome — anonymized human-verified edits | LLM labs: training data they can't get elsewhere |
| **Market** | Air-Gap Mode + compliance | SpaceX/defense/healthcare: markets Copilot can't enter |

## Acquisition Timeline

| Months | Milestone |
|---|---|
| 1–4 | MVP + 500 devs + Genome collecting |
| 5–8 | Air-Gap + 3 enterprise logos |
| 9–12 | Cross-Repo + team mode (network effect) |
| 13–18 | Technical blog/paper + conference talk |
| 18+ | Strategic conversations: Google / Meta / SpaceX / GitHub |

---

*NeuroCode v3.2 — ZMS Digital Solutions, Dhaka, Bangladesh*
*OpenAI-compatible gateway · Ollama · optional RunPod pod lifecycle*
