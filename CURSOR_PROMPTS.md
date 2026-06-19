# NeuroCode — Cursor Prompts Playbook v3.0
## Includes: RunPod vLLM + Qwen3-Coder + Pod Lifecycle Manager

> Use Agent mode (not Autocomplete) for all prompts.
> Always have .cursorrules in project root — Cursor reads it automatically.
> Primary backend: RunPod L4 24GB via vLLM. Fallback: Ollama.
> Build in order. Test each step before proceeding.

---

# ═══════════════════════════════════════
# PHASE 1 — CORE MVP (Weeks 1–8)
# ═══════════════════════════════════════

## PROMPT 1 — Extension Scaffold

```
Read .cursorrules and BLUEPRINT.md fully before writing any code.

Scaffold the NeuroCode VS Code extension:

src/extension.ts
- activate(): spawns sidecar with ALL env vars from config (RunPod + Ollama + airgap)
- deactivate(): sends SIGTERM to sidecar
- Status bar: shows connecting state on startup, updates after health check
- Registers all 10 commands including neurocode.startPod and neurocode.stopPod

src/sidecar/SidecarManager.ts
- Full implementation from BLUEPRINT.md Step 8
- Passes ALL these env vars to child process:
  NEUROCODE_PORT, NEUROCODE_PROJECT,
  NEUROCODE_LLM_PROVIDER, NEUROCODE_OLLAMA_URL, NEUROCODE_OLLAMA_MODEL,
  NEUROCODE_VLLM_URL, NEUROCODE_VLLM_KEY, NEUROCODE_VLLM_MODEL,
  SHARD_MAX_TOKENS (0 = auto),
  NEUROCODE_RUNPOD_KEY, NEUROCODE_RUNPOD_POD_ID,
  NEUROCODE_RUNPOD_AUTO_START, NEUROCODE_RUNPOD_AUTO_STOP, NEUROCODE_RUNPOD_IDLE_MS,
  NEUROCODE_AIRGAP
- Auto-restart on crash (max 3 attempts)
- Poll /health every 500ms until ready (timeout 10s)

src/sidecar/SidecarClient.ts
- Typed axios wrapper for all sidecar endpoints
- Methods typed against full API contract in .cursorrules
- Includes: get(), post(), stream() for SSE

src/utils/config.ts
- getConfig(): returns all neurocode.* settings as typed object
- Include all RunPod settings: runpod.apiKey, runpod.podId, runpod.autoStart, etc.

src/utils/logger.ts
- Singleton OutputChannel "NeuroCode"
- log(), error(), warn() with timestamps

TypeScript strict mode. No `any`. Follow all .cursorrules extension host rules.
```

---

## PROMPT 2 — Sidecar Foundation

```
Read .cursorrules. Build the sidecar Express server.

sidecar/server.js
- Express on NEUROCODE_PORT (default 39291), bind to 127.0.0.1 only
- Import and mount all route modules including /runpod
- Initialize RunPodLifecycleManager if NEUROCODE_RUNPOD_POD_ID is set:
  const runpodManager = RUNPOD_POD_ID ? new RunPodLifecycleManager({...}) : null
  export { runpodManager } so routes can import it
- If NEUROCODE_RUNPOD_AUTO_START = 'true' AND runpodManager exists: call runpodManager.start()
- GET /health: full implementation from BLUEPRINT.md Step 13
- SIGTERM handler: stop idle timer, flush genome, close DB

sidecar/db/sqlite.js
- Opens better-sqlite3 at projectPath/.neurocode/neurocode.db
- Enables WAL mode and foreign keys pragma
- Runs schema.sql on first init
- Exports db singleton

sidecar/db/schema.sql
- Full schema from BLUEPRINT.md Step 4 — ALL tables including runpod_sessions

sidecar/routes/index.js
- Mounts all routes: /agent, /index, /shards, /memory, /review, /debug, /genome, /crossrepo, /runpod
```

---

## PROMPT 3 — VLLMAdapter + OllamaAdapter + LLMRouter

```
Read .cursorrules adapter rules and BLUEPRINT.md Steps 5 and 6.

sidecar/adapters/VLLMAdapter.js
- Full implementation from BLUEPRINT.md Step 5
- Constructor: { baseUrl, apiKey, model }
- Strip trailing slash from baseUrl
- Headers: Authorization: Bearer {apiKey}
- chat(): POST {baseUrl}/chat/completions, timeout 120_000ms
- stream(): streaming SSE parse, yields token strings
- isAvailable(): GET {baseUrl}/models, check model in list, returns false on any error
- getModelInfo(): returns { name, provider: 'vllm-runpod', gpu: 'L4 24GB' }
- Error handling:
  - 401 → throw 'RunPod API key invalid'
  - 404 → throw 'Model not found: {model}'
  - ECONNREFUSED / timeout → return isAvailable() = false

sidecar/adapters/OllamaAdapter.js
- Constructor: { baseUrl, model }
- chat(): POST {baseUrl}/api/chat, stream: false, timeout 60_000ms
- stream(): POST with stream:true, parse Ollama streaming format (different from OpenAI)
- isAvailable(): GET {baseUrl}/api/tags, check model exists
- getModelInfo(): returns { name, provider: 'ollama', gpu: 'local' }

sidecar/core/LLMRouter.js
- Full implementation from BLUEPRINT.md Step 6
- getAdapter(config?): tries vLLM first, falls back to Ollama
- getActiveProvider(): returns 'vllm' | 'ollama' | null
- getTokenBudget(): returns 6000 for vllm, 3500 for ollama
- _readEnvConfig(): reads all NEUROCODE_* env vars
- Logs all provider switches to console
```

---

## PROMPT 4 — RunPod Lifecycle Manager

```
Read .cursorrules RunPod Lifecycle Rules and BLUEPRINT.md Step 7.

sidecar/core/RunPodLifecycleManager.js
- Full implementation from BLUEPRINT.md Step 7
- All 3 GraphQL mutations: startPod, stopPod, getPod status
- Pod state machine: stopped → starting → running → warm → stopping → stopped
- start(): calls GraphQL mutation, then polls /v1/models every 5s until ready (3 min timeout)
- warmup(): sends minimal chat call, transitions to 'warm' state on success
- stop(): calls GraphQL mutation, closes session record in runpod_sessions table
- ensureReady(): called before every LLM request
  - If warm/running: just reset idle timer, return
  - If stopped: call start(), await ready
  - If starting: wait for state change with 200s timeout
- resetIdleTimer(): resets countdown, calls stop() on expiry if autoStop = true
- getStatus(): returns full status object with cost estimate
- destroy(): clears timers on shutdown
- onStateChange(fn): registers callback for status updates

sidecar/routes/runpod.js
- Full implementation from BLUEPRINT.md Step 11
- GET /runpod/status, POST /runpod/start, POST /runpod/stop, POST /runpod/warmup, GET /runpod/cost
- All routes check if runpodManager exists before calling methods

Wire in server.js:
- Export runpodManager so agent.js and runpod.js can import it
- On SIGTERM: call runpodManager.destroy() before exiting
```

---

## PROMPT 5 — File Indexer

```
Read .cursorrules. Build the file indexer.

sidecar/core/CodeGraph.js
- walkProjectFiles(projectPath, excludePatterns): async generator of absolute file paths
  - reads .neurocodeignore if present, merges with excludePatterns
  - yields only: .ts .tsx .js .jsx .py .php .java .go .rs files
- indexFile(filePath, projectPath, db):
  - reads file, counts tokens (gpt-tokenizer encode())
  - computes MD5 hash
  - upserts into files table
- extractImportPaths(content, language): regex-based, returns resolved paths

sidecar/routes/indexer.js
- POST /index: starts async job, returns { jobId }
- GET /index/status/:jobId: { status, filesProcessed, totalFiles }
- After index complete: set global.indexStatus = { done: true, fileCount: N }
- chokidar watcher: re-index on file change, delete DB row on file delete
```

---

## PROMPT 6 — Embeddings + Vector Store

```
Read .cursorrules. Add embedding and semantic search.

sidecar/core/EmbeddingService.js
- embed(text): POST to NEUROCODE_OLLAMA_URL/api/embed (always Ollama — never RunPod)
  model: 'nomic-embed-text', returns number[]
  LRU cache: last 100 embeddings in memory
- isAvailable(): checks nomic-embed-text in ollama tags

NOTE: Embeddings ALWAYS use Ollama, even when RunPod is the LLM backend.
      nomic-embed-text is fast on CPU/local. Do NOT send embeddings to RunPod.

sidecar/vector/VectorStore.js
- Wraps vectra LocalIndex
- init(indexPath): creates/loads at projectPath/.neurocode/vectors/
- addItem(id, vector, metadata): upsert
- query(vector, topK): returns [{item, score}] sorted desc
- deleteItem(id)

After indexing each file: embed content (first 2000 chars), store in VectorStore.

sidecar/routes/shards.js
- GET /shards/preview?task=...&activeFile=...&projectPath=...
  Returns { shards, totalTokens, budget, provider }
  budget reflects current active provider (6000 or 3500)
```

---

## PROMPT 7 — Shard Manager

```
Read .cursorrules Shard Assembly Rules and BLUEPRINT.md Step 9 carefully.

sidecar/core/ShardManager.js
- Full implementation from BLUEPRINT.md Step 9
- MAX_TOKENS getter: reads LLMRouter.getTokenBudget() (dynamic: 6000 vllm / 3500 ollama)
- assembleContext(task, activeFile, projectPath, memoryGraph = null):
  Priority 1: activeFile (never cut)
  Priority 2: imports (from SQLite dependencies)
  Priority 3: callers
  Priority 4: memory hits (if memoryGraph provided)
  Priority 5: vector similarity top-3
  Truncate in reverse order if over budget
- buildPrompt(task, shards):
  Checks LLMRouter.getActiveProvider() === 'vllm' AND model contains 'qwen'
  Uses Qwen3-specific system prompt for RunPod, generic prompt for Ollama
  (Exact prompts from .cursorrules Qwen3-Coder Prompt Rules section)
- buildAttentionMap(shards, llmResponse): builds inContext/cited/missed ranges
- Each shard: { file, relativeFile, content, reason, tokenCount, priority }
```

---

## PROMPT 8 — Agent Routes

```
Read .cursorrules API contract and BLUEPRINT.md Step 10.

sidecar/routes/agent.js

POST /agent/ask
1. If req.body.warmup = true: call LLM with 'ready', max_tokens: 5, return immediately
2. Call runpodManager.ensureReady() if runpodManager exists (starts pod if stopped)
3. Get adapter via LLMRouter.getAdapter()
4. Assemble shards with ShardManager.assembleContext()
   - Budget auto-set by provider (6000 vllm / 3500 ollama)
5. Build Qwen3 or generic prompt via ShardManager.buildPrompt()
6. Call adapter.chat() with temperature: 0.1, max_tokens: 1500
7. Reset idle timer: runpodManager?.resetIdleTimer()
8. Update runpod_sessions table: llm_calls + 1
9. Build attention map via ShardManager.buildAttentionMap()
10. Return: { response, diff, shardsUsed, attentionMap, tokensUsed, budget, modelUsed, provider, latencyMs }

POST /agent/plan
- Same ensureReady() call before LLM
- Planner prompt (identical for all models — from .cursorrules)
- Parse JSON response strictly
- Store in plans + plan_steps tables

POST /agent/plan/:planId/execute
- Same ensureReady() before each step
- Reset idle timer after step completion
```

---

## PROMPT 9 — Status Bar with Pod State

```
Read .cursorrules status bar display rules per pod state.

src/extension.ts — status bar logic:

After activate(), poll /health every 30 seconds and update status bar:

function updateStatusBar(healthData) {
  const { provider, model, podState, fileCount, tokenBudget, airgap } = healthData;

  if (airgap) {
    statusBar.text = `$(shield) NeuroCode [AIR-GAP] | ${model?.name} | ${fileCount} files`;
    return;
  }

  switch(podState) {
    case 'stopped':
      statusBar.text = `$(circle-slash) NeuroCode | RunPod stopped | fallback: Ollama`;
      break;
    case 'starting':
      statusBar.text = `$(sync~spin) NeuroCode | Starting RunPod L4...`;
      break;
    case 'running':
      statusBar.text = `$(remote-explorer) NeuroCode | Qwen3 on RunPod L4 | ${fileCount} files`;
      break;
    case 'warm':
      statusBar.text = `$(rocket) NeuroCode | Qwen3 🔥 warm | ${fileCount} files`;
      break;
    case 'stopping':
      statusBar.text = `$(sync~spin) NeuroCode | RunPod stopping...`;
      break;
    case 'not-configured':
      // No RunPod — show Ollama
      statusBar.text = provider === 'vllm'
        ? `$(remote-explorer) NeuroCode | ${model?.name} | ${fileCount} files`
        : `$(chip) NeuroCode | ${model?.name} | ${fileCount} files`;
      break;
  }

  statusBar.tooltip = `Token budget: ${tokenBudget} | Click to open chat`;
}

Also register commands neurocode.startPod and neurocode.stopPod:
- startPod: calls sidecarClient.post('/runpod/start'), shows progress notification
- stopPod: calls sidecarClient.post('/runpod/stop'), shows info message
```

---

## PROMPT 10 — Chat Panel with RunPod Status Badge

```
Read .cursorrules WebView rules. Use vscode CSS variables for ALL colors.

src/panels/ChatPanel.ts
- Static createOrShow() managing singleton panel
- getNonce() for CSP
- Message handlers:
  - 'askAgent': calls /agent/ask, posts response back including provider and podState
  - 'acceptDiff': calls DiffApplier.applyEdit()
  - 'rejectDiff': cleans up temp file
  - After response: apply AttentionHeatmap, record to /memory/record
  - 'startPod': calls /runpod/start
  - 'stopPod': calls /runpod/stop
- Poll /runpod/status every 10 seconds while panel is open, post { type: 'podStatus', data } to WebView

webview-ui/src/panels/ChatPanel.tsx
- Import and render RunPodStatusBadge at top of panel
- Pass podState, idleRemainingMs, onStart, onStop handlers to badge
- Message list, input box (@vscode/webview-ui-toolkit components)
- GenomeConsentBanner shown if consent not yet given
- Streaming: append tokens as they arrive
- ShardCard list below each AI response (collapsed by default)
- "View Diff" button on code-containing responses
- Provider indicator on each message: small badge "Qwen3 · RunPod L4" or "Ollama"

webview-ui/src/components/RunPodStatusBadge.tsx
- Full implementation from BLUEPRINT.md Step 12
- Pod state → color + icon + label
- Shows idle countdown when warm
- Start/Stop buttons per state
```

---

## PROMPT 11 — Shard Visualizer with Dynamic Budget

```
Read .cursorrules ShardVisualizerPanel rules.

src/panels/ShardVisualizerPanel.ts
- Registered as neurocode.shardsView
- After each /agent/ask: receives shards + budget + provider, posts to WebView
- Budget from response.data.budget (6000 if RunPod, 3500 if Ollama)

webview-ui/src/panels/ShardVisualizerPanel.tsx

Header:
- "Context Budget: {totalTokens} / {budget} tokens"  
- Provider sub-label: "on Qwen3 · RunPod L4" or "on qwen2.5-coder · Ollama"
- Animated progress bar
- Token count chip colored by usage %

Shard list with ShardCard components:
- Priority badge colors per .cursorrules
- Token bar showing proportion of budget used
- Signal bars for semantic match scores

Empty state: "Run Ask Agent to see context here"
Budget changes dynamically — component re-renders when provider switches.
When provider is 'vllm': budget = 6000, label shows "RunPod L4 · 6K context"
When provider is 'ollama': budget = 3500, label shows "Ollama · 3.5K context"
```

---

## PROMPT 12 — Diff Applier + Attention Heatmap

```
Build the diff application and attention heatmap systems.

src/utils/DiffApplier.ts
- parseCodeBlocks(text): extracts [{filename, language, code}] from LLM response
  Handles Qwen3 format: ```typescript\n// filename: path/to/file.ts\n code```
  Handles generic format: ```lang\n// file: path\n code```
- showDiff(originalUri, newContent, title): opens VS Code diff editor
- applyEdit(fileUri, newContent): creates WorkspaceEdit, calls vscode.workspace.applyEdit()

src/editor/AttentionHeatmap.ts
- Full implementation from .cursorrules Attention Heatmap section
- Three decoration types: inContext (blue), cited (violet), missed (orange)
- apply(attentionMap): applies to active editor
- clear(): removes all decorations
- dispose(): on extension deactivate

Wire in extension.ts:
- Create AttentionHeatmap on activate, dispose on deactivate
- After agent response with attentionMap: call heatmap.apply()
- Before new call: call heatmap.clear()
- On vscode.window.onDidChangeActiveTextEditor: re-apply last map if available
```

---

# ═══════════════════════════════════════
# PHASE 2 — AGENTIC LOOP (Weeks 9–12)
# ═══════════════════════════════════════

## PROMPT 13 — AST Dependency Graph

```
Read .cursorrules. Build the AST-based import extractor.

Upgrade CodeGraph.js to use tree-sitter:
- Install: tree-sitter + tree-sitter-javascript + tree-sitter-typescript + tree-sitter-python
- extractImports(filePath, content, language):
  - For JS/TS: use tree-sitter to find import declarations and require() calls
  - For Python: find import and from...import statements
  - For PHP: find require/include/use statements
  - Returns absolute resolved paths for each import
- extractSymbols(filePath, content, language):
  - Extract: function declarations, class declarations, exported variables
  - Returns: [{ name, type, lineStart, lineEnd, signature, docstring }]
  - Store in SQLite symbols table

After indexing a file:
1. Extract and store imports → insert into dependencies table
2. Extract symbols → insert into symbols table
3. Embed function signatures for drift detection → store in symbols.embedding
```

---

## PROMPT 14 — Planner Agent + Task Queue

```
Read .cursorrules Agent Orchestrator rules.

sidecar/routes/agent.js — add POST /agent/plan:
1. Call runpodManager.ensureReady()
2. Load file list from SQLite (top 50 by token count)
3. Send planner prompt to LLM (Qwen3 or generic — same prompt for both)
4. Parse JSON response (strip ``` fences)
5. Validate steps array
6. Store in plans + plan_steps tables
7. Return { planId, steps }

POST /agent/plan/:planId/execute:
1. Load plan, find next pending step (respecting dependsOn)
2. Call runpodManager.ensureReady()
3. Assemble shards for step.targetFiles
4. Include previous step outputs as additional context
5. Run LLM, store output, mark done/failed
6. Reset idle timer after completion
7. Return { stepId, status, diff }

src/panels/TaskQueuePanel.ts + webview-ui/src/panels/TaskQueuePanel.tsx
- Same implementation as CURSOR_PROMPTS v2 Prompt 11
- Add provider badge on each step result ("Qwen3" or "Ollama")
```

---

# ═══════════════════════════════════════
# PHASE 3 — RUNPOD LIFECYCLE (Weeks 11–13)
# ═══════════════════════════════════════

## PROMPT 15 — Pod Auto-Start on Workspace Open

```
Add automatic RunPod pod management on VS Code workspace open.

src/extension.ts — add to activate():

// Auto-start pod if configured and enabled
const cfg = getConfig();
if (cfg.runpod.podId && cfg.runpod.autoStart && !cfg.airgap.enabled) {
  vscode.window.setStatusBarMessage('$(sync~spin) NeuroCode: Starting RunPod L4...', 30_000);
  
  sidecarClient.post('/runpod/start').then(() => {
    // Poll for warm state
    const pollInterval = setInterval(async () => {
      const status = await sidecarClient.get('/runpod/status');
      if (status.data.podState === 'warm' || status.data.podState === 'running') {
        clearInterval(pollInterval);
        vscode.window.showInformationMessage(
          `NeuroCode: RunPod L4 ready! Qwen3-Coder loaded. Budget: 6000 tokens.`
        );
      }
    }, 5000);

    // Stop polling after 3 minutes regardless
    setTimeout(() => clearInterval(pollInterval), 180_000);
  });
}

Register neurocode.startPod and neurocode.stopPod commands:
- startPod: POST /runpod/start → progress notification while polling for 'warm' state
- stopPod: POST /runpod/stop → info message "RunPod stopped — using Ollama fallback"

Poll /runpod/status every 10 seconds and update status bar continuously.
```

---

## PROMPT 16 — Cost Tracking UI

```
Add cost tracking display to the Chat panel and a cost report command.

sidecar/routes/runpod.js — GET /runpod/cost already implemented.

webview-ui ChatPanel — add cost section below RunPodStatusBadge:
- "Session cost: ~$0.12 · 16 min · 47 LLM calls"
- Only show when podState is 'warm' or 'running'
- Update every 60 seconds via poll

neurocode.showCostReport command:
- Fetches all runpod_sessions from SQLite via /runpod/sessions endpoint
- Shows in a simple WebView table:
  | Session | Duration | Est. Cost | LLM Calls |
  | Jun 19  | 47 min   | $0.34     | 83        |
- Total row at bottom
- "At this rate, monthly estimate: ~$X"
```

---

# ═══════════════════════════════════════
# PHASE 4 — ACQUISITION FEATURES (Weeks 13–20)
# ═══════════════════════════════════════

## PROMPT 17 — Multi-Agent Code Review

```
Read .cursorrules MultiAgentRunner rules.

sidecar/core/MultiAgentRunner.js
- Exact agent prompts from .cursorrules (architect/security/performance/test)
- runAll(): Promise.all of 4 agents against same contextBlock
- On RunPod: all 4 calls go to vLLM simultaneously (it handles concurrency)
- On Ollama: same — Promise.all still works, just slower
- runAgent(): call LLM with temperature 0.5, max_tokens 1000
- Each agent returns structured JSON (strip markdown fences first)

sidecar/routes/review.js
- POST /review/start: runs MultiAgentRunner.runAll(), stores in review_sessions + findings
- GET /review/:id/stream (SSE): streams results as they complete

src/panels/ReviewPanel.ts + webview-ui/src/panels/ReviewPanel.tsx
- 4 ReviewAgentCard components, update as SSE events arrive
- Show "Running on Qwen3 · RunPod L4" or "Running on Ollama" in header
```

---

## PROMPT 18 — Project Memory Graph

```
Build Project Memory per BLUEPRINT.md Step 5 ProjectMemoryGraph implementation.

sidecar/core/ProjectMemoryGraph.js — full implementation from BLUEPRINT.md
- record(): stores task + embedding + accept/reject + provider used
  Add 'provider' field to memory_records table
- query(task, topK): semantic search + weight ranking
- updateWeights(): boost/penalize similar memories

Wire into agent.js:
- After /agent/ask response: POST /memory/record with { task, filesEdited, accepted, provider, latencyMs }
- Before shard assembly: query memory for Priority 4 shards

Memory panel shows provider badge per memory record:
- "Qwen3 · RunPod" in violet | "Ollama" in grey
```

---

## PROMPT 19 — Semantic Drift + Causal Debug

```
Build SemanticDriftDetector and CausalDebugAgent per BLUEPRINT.md implementations.

sidecar/core/SemanticDriftDetector.js
- Watches .git/COMMIT_EDITMSG for commits
- Re-embeds modified symbols after each commit
- Computes cosine distance vs stored embeddings
- Drift threshold: NEUROCODE_DRIFT_THRESHOLD env (default 0.15)
- Inserts drift_alerts records
- NOTE: Embeddings always use Ollama nomic-embed-text regardless of LLM provider

sidecar/core/CausalDebugAgent.js
- parseStackTrace(): extract frames from stack trace text
- buildFrameShard(): 10 lines above/below each frame
- analyze(): call LLM with causal chain prompt, parse structured JSON response
- Uses runpodManager.ensureReady() before LLM call

src/commands/debugCause.ts
- Ctrl+Shift+D: reads selected text OR shows input box
- Calls /debug/cause
- Applies red gutter decoration on root cause line
- Opens DebugPanel
```

---

## PROMPT 20 — Edit Genome + Air-Gap Mode

```
Build EditGenomeCollector and AirGapModeManager per BLUEPRINT.md.

sidecar/genome/EditGenomeCollector.js
- record(): includes 'provider' field in genome record (anonymized as 'vllm' or 'ollama')
- Anonymize: NO file paths, NO code, NO variable names
- Keep: shardCount, totalTokens, shardReasons[], accepted, latencyMs, provider, model size class

sidecar/core/AirGapModeManager.js
- enforce(): patches http/https to block external calls
- INTERNAL_HOSTS: 127.0.0.1, localhost, ::1, plus any 192.168.x.x and 10.x.x.x addresses
- When airgap = true: RunPodLifecycleManager is NOT initialized (check before constructing)
- Audit log: every LLM call, every file access, every network attempt

server.js airgap check:
if (AIRGAP) {
  AirGapModeManager.enforce(projectPath);
  // Do NOT initialize runpodManager in air-gap mode
}
```

---

## PROMPT 21 — Cross-Repo Indexer

```
Build CrossRepoIndexer per BLUEPRINT.md Step 8.

sidecar/core/CrossRepoIndexer.js
- registerRepo(projectPath, projectId, projectName):
  index files, tag vector items with projectId + projectName
- searchAcrossRepos(query, topK, excludeProjectId):
  embed query (always via Ollama), search shared VectorStore
  filter out excludeProjectId results
  label each result with source project

Wire into ShardManager:
- If crossrepo.enabled AND crossrepo.sharedIndexPath:
  add Priority 5b: cross-repo search after local vector search
  cross-repo shards labeled: "$(repo) from {projectName}"
```

---

# ═══════════════════════════════════════
# PHASE 5 — ENTERPRISE & SHIP (Weeks 21–28)
# ═══════════════════════════════════════

## PROMPT 22 — Docker + Helm for Team Deployment

```
Create deployment files per BLUEPRINT.md Deployment Targets.

Dockerfile (sidecar):
- FROM node:18-alpine
- COPY sidecar/ /app/
- RUN npm ci --production
- ENV NEUROCODE_PORT=39291
- EXPOSE 39291
- HEALTHCHECK: wget -qO- http://localhost:39291/health
- CMD ["node", "server.js"]
Note: RunPodLifecycleManager NOT active in Docker — team shares an always-on vLLM endpoint

docker-compose.yml (team mode with shared vLLM):
- neurocode-sidecar: the Dockerfile
- ollama: ollama/ollama (fallback)
- volumes: workspace mount, .neurocode data volume
- env: NEUROCODE_VLLM_URL pointing to team's shared RunPod or on-prem vLLM

charts/neurocode/ (Helm for Kubernetes):
- deployment.yaml, service.yaml, configmap.yaml, pvc.yaml, secret.yaml
- values.yaml includes all settings from .cursorrules VS Code Settings section
- Air-gap values file: values-airgap.yaml with airgap=true, runpod disabled

README-ENTERPRISE.md:
- RunPod setup guide (which GPU tier, model selection, vLLM startup command)
- Team deployment guide (one shared sidecar, each dev installs extension)
- Air-gap deployment guide
- Cost optimization guide (idle timeout tuning, model selection trade-offs)
```

---

## IF CURSOR DRIFTS — Reset Prompt v3

```
Stop all code generation. Re-read .cursorrules from the beginning.

Critical rules for this project:
1. Primary LLM: vLLM on RunPod L4 via NEUROCODE_VLLM_URL
2. Fallback LLM: Ollama at NEUROCODE_OLLAMA_URL — automatic, silent, no user action needed
3. Token budget: 6000 for vLLM, 3500 for Ollama — derived from LLMRouter.getTokenBudget()
4. Qwen3 system prompt: use ONLY when provider='vllm' AND model contains 'qwen'
5. Embeddings: ALWAYS use Ollama nomic-embed-text — NEVER send embeddings to RunPod
6. RunPodLifecycleManager: disabled entirely when airgap=true
7. ensureReady(): must be called before EVERY LLM request in agent.js
8. Idle timer: reset after EVERY LLM response, auto-stop on expiry if autoStop=true
9. All RunPod env vars must be passed from SidecarManager to child process
10. Status bar changes per pod state — 5 distinct states with different icons/text

Resume what you were building.
```

---

## QUICK VERIFICATION COMMANDS

```bash
# 1. Test RunPod connection directly
VLLM_URL="https://YOUR_POD-8000.proxy.runpod.net/v1" \
VLLM_KEY="your-key" \
VLLM_MODEL="Qwen/Qwen2.5-Coder-32B-Instruct-AWQ" \
node sidecar/scripts/test-runpod.js

# 2. Test sidecar with RunPod config
NEUROCODE_PORT=39291 \
NEUROCODE_LLM_PROVIDER=vllm \
NEUROCODE_VLLM_URL="https://YOUR_POD-8000.proxy.runpod.net/v1" \
NEUROCODE_VLLM_KEY="your-key" \
NEUROCODE_VLLM_MODEL="Qwen/Qwen2.5-Coder-32B-Instruct-AWQ" \
NEUROCODE_RUNPOD_KEY="your-key" \
NEUROCODE_RUNPOD_POD_ID="your-pod-id" \
node sidecar/server.js &

# 3. Check health (should show vllm provider + tokenBudget: 6000)
curl http://localhost:39291/health | jq

# 4. Test pod lifecycle
curl -X POST http://localhost:39291/runpod/start | jq
sleep 60
curl http://localhost:39291/runpod/status | jq

# 5. Test agent ask (with RunPod backend)
curl -X POST http://localhost:39291/agent/ask \
  -H "Content-Type: application/json" \
  -d '{"task":"write a hello world function","activeFile":"/tmp/test.ts","projectPath":"/tmp"}' \
  | jq '.data.provider, .data.tokensUsed, .data.budget'
# Expected: "vllm", <number>, 6000

# 6. Test Ollama fallback (stop RunPod pod first)
curl -X POST http://localhost:39291/runpod/stop
sleep 5
curl http://localhost:39291/agent/ask \
  -H "Content-Type: application/json" \
  -d '{"task":"write hello world","activeFile":"/tmp/test.ts","projectPath":"/tmp"}' \
  | jq '.data.provider, .data.budget'
# Expected: "ollama", 3500

# 7. Package extension
cd .. && vsce package
code --install-extension neurocode-0.1.0.vsix
```
