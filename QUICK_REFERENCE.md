# NeuroCode — Quick Reference Card v3.0
## Primary: RunPod L4 24GB + Qwen3-Coder via vLLM | Fallback: Ollama

---

## System Architecture

```
Extension Host (TypeScript)     Sidecar Node.js :39291           LLM Backend
────────────────────────        ────────────────────────          ──────────────────
extension.ts                    server.js                         PRIMARY (vLLM)
SidecarManager.ts    ──►        LLMRouter.js             ──►     RunPod L4 24GB
SidecarClient.ts                  ├─ VLLMAdapter.js               Qwen3-Coder-AWQ
AttentionHeatmap.ts               └─ OllamaAdapter.js    ──►     FALLBACK (Ollama)
ChatPanel.ts                    RunPodLifecycleManager.js          localhost:11434
ReviewPanel.ts                  ShardManager.js                    qwen2.5-coder:7b
MemoryPanel.ts                  AgentOrchestrator.js
DebugPanel.ts                   MultiAgentRunner.js      EMBEDDINGS (always Ollama)
TaskQueuePanel.ts               ProjectMemoryGraph.js    ──►     nomic-embed-text
ShardVisualizerPanel.ts         SemanticDriftDetector.js          localhost:11434
RunPodStatusBadge.tsx           CausalDebugAgent.js
                                CrossRepoIndexer.js
                                EditGenomeCollector.js
                                AirGapModeManager.js
```

---

## Key Numbers

| Parameter | RunPod (vLLM) | Ollama (fallback) |
|---|---|---|
| Token budget per shard | **6000** | **3500** |
| LLM model | Qwen3-Coder-30B-AWQ | qwen2.5-coder:7b |
| GPU | L4 24GB | Local GPU/CPU |
| Timeout per call | 120 seconds | 60 seconds |
| Cost | ~$0.44/hr RunPod | $0 |
| Prompt style | Qwen3-specific | Generic |

| Other Parameters | Value |
|---|---|
| Sidecar port | 39291 (127.0.0.1 only) |
| Max plan steps | 8 |
| Max LLM output tokens | 1500 |
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

## RunPod Pod State Machine

```
stopped ──[start()]──► starting ──[/v1/models ready]──► running ──[warmup]──► warm
  ▲                                                                              │
  └──[stop() / idle timeout]──◄── stopping ◄──[stop()]────────────────────────┘

warm → LLM call → warm (idle timer resets)
warm → idle timer fires → stopping → stopped
any error → unknown → manual restart
```

## Status Bar per Pod State

| State | Status Bar Text |
|---|---|
| stopped | `$(circle-slash) NeuroCode \| RunPod stopped \| fallback: Ollama` |
| starting | `$(sync~spin) NeuroCode \| Starting RunPod L4...` |
| running | `$(remote-explorer) NeuroCode \| Qwen3 on RunPod L4 \| {N} files` |
| warm | `$(rocket) NeuroCode \| Qwen3 🔥 warm \| {N} files` |
| stopping | `$(sync~spin) NeuroCode \| RunPod stopping...` |
| air-gap | `$(shield) NeuroCode [AIR-GAP] \| {model} \| {N} files` |

---

## Shard Priority Order

| Priority | Source | Token Budget Rule |
|---|---|---|
| 1 | Active file (cursor) | Never cut, never removed |
| 2 | Files active file imports | From SQLite dependencies |
| 3 | Files that import active file | Callers |
| 4 | Project Memory hits | Weighted by past decisions |
| 5 | Vector similarity top-3 | Semantic match via nomic-embed |
| 6 | Type definitions | Last to add, first to cut |

Budget: **6000 tokens** when RunPod active · **3500 tokens** when Ollama fallback

---

## Commands

| Command | Keybinding | Description |
|---|---|---|
| neurocode.askAgent | Ctrl+Shift+A | Ask agent (auto-starts pod if stopped) |
| neurocode.reviewCode | Ctrl+Shift+R | 4 parallel specialist agents |
| neurocode.debugCause | Ctrl+Shift+D | Stack trace → root cause |
| neurocode.startPod | — | Manually start RunPod pod |
| neurocode.stopPod | — | Manually stop RunPod pod (save cost) |
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
  POST /agent/ask           → { response, diff, shardsUsed, attentionMap,
                                tokensUsed, budget, modelUsed, provider, latencyMs }
  POST /agent/plan          → { planId, steps[] }
  POST /agent/plan/:id/execute → { stepId, status, diff }

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

RunPod Lifecycle (NEW)
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
NEUROCODE_LLM_PROVIDER=vllm           # 'vllm' or 'ollama'
NEUROCODE_VLLM_URL=https://YOUR_POD-8000.proxy.runpod.net/v1
NEUROCODE_VLLM_KEY=your-runpod-api-key
NEUROCODE_VLLM_MODEL=Qwen/Qwen2.5-Coder-32B-Instruct-AWQ
NEUROCODE_OLLAMA_URL=http://localhost:11434
NEUROCODE_OLLAMA_MODEL=qwen2.5-coder:7b

# Shard budget (0 = auto: 6000 for vLLM, 3500 for Ollama)
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
| **Technical** | Shard arch on 7B models + RunPod integration | Google device runtime / Meta on-prem Copilot |
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

*NeuroCode v3.0 — ZMS Digital Solutions, Dhaka, Bangladesh*
*RunPod L4 24GB · Qwen3-Coder · vLLM · Ollama fallback*
