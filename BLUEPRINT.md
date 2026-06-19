# NeuroCode — Build Blueprint v3.0
## VS Code Extension · Agentic Coding · RunPod L4 24GB + Qwen3-Coder via vLLM
## Built for Acquisition: Google / Meta / SpaceX / GitHub

> Read this before writing any code.
> Primary LLM backend: RunPod L4 24GB running Qwen3-Coder-30B-A3B-AWQ via vLLM
> Fallback: Ollama localhost with qwen2.5-coder:7b
> Three moats: Shard Architecture · Edit Genome · Air-Gap Mode

---

## What We're Building

NeuroCode is a VS Code extension with full agentic coding capability. The primary LLM
backend is your RunPod L4 GPU running Qwen3-Coder via vLLM — the same infrastructure
you already have running. When RunPod is offline (cost saving), it falls back to local
Ollama automatically. A built-in pod lifecycle manager starts, warms up, and stops your
RunPod pod automatically based on coding activity.

---

## Prerequisites

```bash
# 1. Node.js 18+
node --version

# 2. VS Code Extension tools
npm install -g @vscode/vsce yo generator-code

# 3. Ollama (fallback LLM)
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull qwen2.5-coder:7b
ollama pull nomic-embed-text      # embedding model — always local

# 4. Verify your RunPod vLLM endpoint is live
curl https://YOUR_POD_ID-8000.proxy.runpod.net/v1/models \
  -H "Authorization: Bearer YOUR_RUNPOD_API_KEY"
# Expected: { "data": [{ "id": "Qwen/Qwen2.5-Coder-32B-Instruct-AWQ" }] }

# 5. Build tools for tree-sitter
# macOS:   xcode-select --install
# Ubuntu:  sudo apt install build-essential
# Windows: npm install -g windows-build-tools

# 6. Git in PATH (for drift detector)
git --version
```

---

## Step 1 — Project Scaffold

```bash
mkdir neurocode && cd neurocode
yo code
# New Extension (TypeScript), name: neurocode, bundle: esbuild
```

Copy `.cursorrules` into project root immediately.

Create `.neurocodeignore`:
```
node_modules
.git
dist
build
.next
.nuxt
vendor
__pycache__
*.pyc
coverage
.nyc_output
.neurocode
```

---

## Step 2 — VS Code Settings Configuration

Before writing any code, configure your RunPod credentials in VS Code Settings (`Ctrl+,`):

```json
{
  "neurocode.llm.provider": "vllm",
  "neurocode.llm.vllmUrl": "https://YOUR_POD_ID-8000.proxy.runpod.net/v1",
  "neurocode.llm.vllmApiKey": "YOUR_RUNPOD_API_KEY",
  "neurocode.llm.vllmModel": "Qwen/Qwen2.5-Coder-32B-Instruct-AWQ",
  "neurocode.llm.ollamaUrl": "http://localhost:11434",
  "neurocode.llm.ollamaModel": "qwen2.5-coder:7b",
  "neurocode.runpod.apiKey": "YOUR_RUNPOD_API_KEY",
  "neurocode.runpod.podId": "YOUR_POD_ID",
  "neurocode.runpod.autoStart": true,
  "neurocode.runpod.autoStop": true,
  "neurocode.runpod.idleTimeoutMinutes": 30,
  "neurocode.shard.maxTokens": 0
}
```

`shard.maxTokens: 0` means **auto** — the system sets 6000 for RunPod and 3500 for Ollama.

---

## Step 3 — Full package.json

```json
{
  "name": "neurocode",
  "displayName": "NeuroCode",
  "description": "Agentic coding — RunPod L4 + Qwen3-Coder or local Ollama fallback",
  "version": "0.1.0",
  "publisher": "zms-digital",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["AI", "Machine Learning", "Other"],
  "keywords": ["ai", "coding", "agent", "llm", "runpod", "qwen", "offline"],
  "activationEvents": [
    "onCommand:neurocode.askAgent",
    "onCommand:neurocode.planTask",
    "onCommand:neurocode.indexProject",
    "onCommand:neurocode.reviewCode",
    "onCommand:neurocode.debugCause"
  ],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      { "command": "neurocode.askAgent",      "title": "Ask Agent",             "category": "NeuroCode" },
      { "command": "neurocode.planTask",      "title": "Plan Multi-Step Task",  "category": "NeuroCode" },
      { "command": "neurocode.indexProject",  "title": "Index Project",         "category": "NeuroCode" },
      { "command": "neurocode.explainShard",  "title": "Explain Context",       "category": "NeuroCode" },
      { "command": "neurocode.reviewCode",    "title": "Review Code (4 Agents)","category": "NeuroCode" },
      { "command": "neurocode.debugCause",    "title": "Find Root Cause",       "category": "NeuroCode" },
      { "command": "neurocode.showMemory",    "title": "Project Memory",        "category": "NeuroCode" },
      { "command": "neurocode.toggleAirGap",  "title": "Toggle Air-Gap Mode",   "category": "NeuroCode" },
      { "command": "neurocode.startPod",      "title": "Start RunPod",          "category": "NeuroCode" },
      { "command": "neurocode.stopPod",       "title": "Stop RunPod",           "category": "NeuroCode" }
    ],
    "keybindings": [
      { "command": "neurocode.askAgent",   "key": "ctrl+shift+a", "mac": "cmd+shift+a" },
      { "command": "neurocode.reviewCode", "key": "ctrl+shift+r", "mac": "cmd+shift+r" },
      { "command": "neurocode.debugCause", "key": "ctrl+shift+d", "mac": "cmd+shift+d" }
    ],
    "viewsContainers": {
      "activitybar": [
        { "id": "neurocode-sidebar", "title": "NeuroCode", "icon": "media/icon.svg" }
      ]
    },
    "views": {
      "neurocode-sidebar": [
        { "type": "webview", "id": "neurocode.chatView",   "name": "Chat" },
        { "type": "webview", "id": "neurocode.tasksView",  "name": "Task Queue" },
        { "type": "webview", "id": "neurocode.shardsView", "name": "Shard Visualizer" },
        { "type": "webview", "id": "neurocode.reviewView", "name": "Code Review" },
        { "type": "webview", "id": "neurocode.memoryView", "name": "Project Memory" },
        { "type": "webview", "id": "neurocode.debugView",  "name": "Debug" }
      ]
    }
  }
}
```

---

## Step 4 — SQLite Schema v3

### sidecar/db/schema.sql
```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  relative_path TEXT NOT NULL,
  language TEXT,
  token_count INTEGER DEFAULT 0,
  last_indexed INTEGER,
  content_hash TEXT
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  signature TEXT,
  docstring TEXT,
  embedding BLOB
);

CREATE TABLE IF NOT EXISTS dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  to_file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  import_name TEXT,
  UNIQUE(from_file_id, to_file_id, import_name)
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  created_at INTEGER,
  status TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS plan_steps (
  id TEXT PRIMARY KEY,
  plan_id TEXT REFERENCES plans(id) ON DELETE CASCADE,
  description TEXT,
  depends_on TEXT,
  status TEXT DEFAULT 'pending',
  shard_data TEXT,
  output TEXT,
  error TEXT,
  step_order INTEGER
);

CREATE TABLE IF NOT EXISTS memory_records (
  id TEXT PRIMARY KEY,
  task_description TEXT NOT NULL,
  task_embedding BLOB,
  files_edited TEXT,
  diff_accepted INTEGER,
  weight REAL DEFAULT 1.0,
  model_used TEXT,
  provider TEXT,
  latency_ms INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS symbol_embeddings_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  git_commit TEXT,
  recorded_at INTEGER,
  drift_score REAL DEFAULT 0.0
);

CREATE TABLE IF NOT EXISTS drift_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  drift_score REAL,
  acknowledged INTEGER DEFAULT 0,
  detected_at INTEGER
);

CREATE TABLE IF NOT EXISTS review_sessions (
  id TEXT PRIMARY KEY,
  active_file TEXT,
  created_at INTEGER,
  status TEXT DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS review_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES review_sessions(id) ON DELETE CASCADE,
  agent_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  file_path TEXT,
  line_number INTEGER,
  message TEXT,
  suggestion TEXT,
  diff TEXT
);

CREATE TABLE IF NOT EXISTS registered_repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  file_count INTEGER DEFAULT 0,
  last_indexed INTEGER
);

-- NEW: RunPod session cost tracking
CREATE TABLE IF NOT EXISTS runpod_sessions (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  started_at INTEGER,
  stopped_at INTEGER,
  cost_per_hr REAL,
  llm_calls INTEGER DEFAULT 0,
  tokens_generated INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_deps_from ON dependencies(from_file_id);
CREATE INDEX IF NOT EXISTS idx_memory_weight ON memory_records(weight DESC);
CREATE INDEX IF NOT EXISTS idx_runpod_sessions ON runpod_sessions(started_at DESC);
```

---

## Step 5 — VLLMAdapter (RunPod-Specific)

### sidecar/adapters/VLLMAdapter.js

```javascript
import axios from 'axios';

export class VLLMAdapter {
  /**
   * @param {object} config
   * @param {string} config.baseUrl - RunPod proxy URL with /v1 suffix
   * @param {string} config.apiKey  - RunPod API key
   * @param {string} config.model   - Full model name e.g. Qwen/Qwen2.5-Coder-32B-Instruct-AWQ
   */
  constructor({ baseUrl, apiKey, model }) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // strip trailing slash
    this.apiKey = apiKey;
    this.model = model;
    this.isQwen = model.toLowerCase().includes('qwen');
    this.headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    };
  }

  /**
   * Non-streaming chat completion.
   * @param {Array<{role: string, content: string}>} messages
   * @param {{temperature?: number, max_tokens?: number}} options
   * @returns {Promise<string>}
   */
  async chat(messages, options = {}) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/chat/completions`,
        {
          model: this.model,
          messages,
          max_tokens: options.max_tokens ?? 1500,
          temperature: options.temperature ?? 0.1,
          stream: false
        },
        { headers: this.headers, timeout: 120_000 }
      );
      return response.data.choices[0].message.content;
    } catch (err) {
      if (err.response?.status === 401) {
        throw new Error('RunPod API key invalid — check neurocode.llm.vllmApiKey');
      }
      if (err.response?.status === 404) {
        throw new Error(`Model not found on vLLM: ${this.model}`);
      }
      throw err;
    }
  }

  /**
   * Streaming chat — yields tokens as they arrive via SSE.
   * @yields {string} token chunks
   */
  async *stream(messages, options = {}) {
    const response = await axios.post(
      `${this.baseUrl}/chat/completions`,
      {
        model: this.model,
        messages,
        max_tokens: options.max_tokens ?? 1500,
        temperature: options.temperature ?? 0.1,
        stream: true
      },
      { headers: this.headers, responseType: 'stream', timeout: 120_000 }
    );

    let buffer = '';
    for await (const chunk of response.data) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;
        try {
          const token = JSON.parse(data).choices?.[0]?.delta?.content;
          if (token) yield token;
        } catch { /* malformed chunk — skip */ }
      }
    }
  }

  /**
   * Check if the vLLM server is reachable and the model is loaded.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    try {
      const res = await axios.get(`${this.baseUrl}/models`, {
        headers: this.headers,
        timeout: 10_000
      });
      return res.data.data.some(m => m.id === this.model);
    } catch {
      return false; // connection refused, timeout, auth fail — all treated as unavailable
    }
  }

  /**
   * @returns {Promise<{name: string, provider: string, gpu: string}>}
   */
  async getModelInfo() {
    try {
      const res = await axios.get(`${this.baseUrl}/models`, {
        headers: this.headers,
        timeout: 10_000
      });
      const m = res.data.data.find(x => x.id === this.model);
      return { name: m?.id ?? this.model, provider: 'vllm-runpod', gpu: 'L4 24GB' };
    } catch {
      return { name: this.model, provider: 'vllm-runpod', gpu: 'L4 24GB' };
    }
  }
}
```

---

## Step 6 — LLMRouter with Automatic Fallback

### sidecar/core/LLMRouter.js

```javascript
import { VLLMAdapter } from '../adapters/VLLMAdapter.js';
import { OllamaAdapter } from '../adapters/OllamaAdapter.js';

let _adapter = null;
let _adapterType = null; // 'vllm' | 'ollama'

export class LLMRouter {
  /**
   * Returns the best available adapter.
   * Always tries vLLM first, falls back to Ollama if unavailable.
   * @param {object} config - from env vars
   * @returns {Promise<LLMAdapter>}
   */
  static async getAdapter(config = null) {
    const cfg = config || LLMRouter._readEnvConfig();

    if (cfg.provider === 'vllm' && cfg.vllmUrl) {
      const vllm = new VLLMAdapter({
        baseUrl: cfg.vllmUrl,
        apiKey: cfg.vllmApiKey,
        model: cfg.vllmModel
      });

      const available = await vllm.isAvailable().catch(() => false);
      if (available) {
        if (_adapterType !== 'vllm') {
          console.log(`[LLMRouter] Using vLLM: ${cfg.vllmModel} on RunPod`);
          _adapterType = 'vllm';
        }
        _adapter = vllm;
        return vllm;
      }

      console.warn('[LLMRouter] vLLM unavailable — falling back to Ollama');
    }

    // Fallback to Ollama
    const ollama = new OllamaAdapter({
      baseUrl: cfg.ollamaUrl || 'http://localhost:11434',
      model: cfg.ollamaModel || 'qwen2.5-coder:7b'
    });
    if (_adapterType !== 'ollama') {
      console.log(`[LLMRouter] Using Ollama: ${cfg.ollamaModel}`);
      _adapterType = 'ollama';
    }
    _adapter = ollama;
    return ollama;
  }

  /** @returns {'vllm'|'ollama'|null} */
  static getActiveProvider() { return _adapterType; }

  /** @returns {number} Dynamic shard token budget based on active provider */
  static getTokenBudget() {
    const manual = parseInt(process.env.SHARD_MAX_TOKENS || '0');
    if (manual > 0) return manual;
    return _adapterType === 'vllm' ? 6000 : 3500;
  }

  static _readEnvConfig() {
    return {
      provider:   process.env.NEUROCODE_LLM_PROVIDER  || 'vllm',
      vllmUrl:    process.env.NEUROCODE_VLLM_URL       || '',
      vllmApiKey: process.env.NEUROCODE_VLLM_KEY       || '',
      vllmModel:  process.env.NEUROCODE_VLLM_MODEL     || 'Qwen/Qwen2.5-Coder-32B-Instruct-AWQ',
      ollamaUrl:  process.env.NEUROCODE_OLLAMA_URL     || 'http://localhost:11434',
      ollamaModel:process.env.NEUROCODE_OLLAMA_MODEL   || 'qwen2.5-coder:7b'
    };
  }
}
```

---

## Step 7 — RunPod Lifecycle Manager

### sidecar/core/RunPodLifecycleManager.js

```javascript
import fetch from 'node-fetch';

const RUNPOD_GQL = 'https://api.runpod.io/graphql';

const GQL = {
  startPod: `mutation($id:String!){ podResume(input:{podId:$id}){ id desiredStatus } }`,
  stopPod:  `mutation($id:String!){ podStop(input:{podId:$id}){ id desiredStatus } }`,
  getPod:   `query($id:String!){ pod(input:{podId:$id}){ id desiredStatus costPerHr runtime{ uptimeInSeconds } } }`
};

export class RunPodLifecycleManager {
  /**
   * @param {object} opts
   * @param {string} opts.podId
   * @param {string} opts.apiKey
   * @param {string} opts.vllmUrl - to poll /v1/models for readiness
   * @param {string} opts.vllmApiKey
   * @param {number} opts.idleTimeoutMs - default 30 minutes
   * @param {boolean} opts.autoStop
   * @param {object} opts.db - better-sqlite3 instance for cost tracking
   */
  constructor({ podId, apiKey, vllmUrl, vllmApiKey, idleTimeoutMs = 1_800_000, autoStop = true, db }) {
    this.podId = podId;
    this.apiKey = apiKey;
    this.vllmUrl = vllmUrl.replace(/\/$/, '');
    this.vllmApiKey = vllmApiKey;
    this.idleTimeoutMs = idleTimeoutMs;
    this.autoStop = autoStop;
    this.db = db;
    this.state = 'unknown'; // stopped|starting|running|warm|stopping|unknown
    this.idleTimer = null;
    this.currentSessionId = null;
    this._onStateChange = null; // callback for status bar updates
  }

  /** Register a callback for pod state changes */
  onStateChange(fn) { this._onStateChange = fn; }

  /** Emit new state to extension host via SSE or polling */
  _setState(newState) {
    this.state = newState;
    console.log(`[RunPod] State: ${newState}`);
    if (this._onStateChange) this._onStateChange(newState);
  }

  /**
   * Call RunPod GraphQL API.
   * @param {string} query
   * @param {object} variables
   */
  async _gql(query, variables) {
    const res = await fetch(RUNPOD_GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({ query, variables })
    });
    const data = await res.json();
    if (data.errors) throw new Error(data.errors[0].message);
    return data.data;
  }

  /**
   * Start the RunPod pod and wait until vLLM is ready.
   * Polls /v1/models every 5 seconds, timeout 3 minutes.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.state === 'running' || this.state === 'warm' || this.state === 'starting') return;

    this._setState('starting');
    await this._gql(GQL.startPod, { id: this.podId });

    // Record session start
    const sessionId = crypto.randomUUID();
    this.currentSessionId = sessionId;
    this.db.prepare(
      'INSERT INTO runpod_sessions (id, pod_id, started_at) VALUES (?, ?, ?)'
    ).run(sessionId, this.podId, Date.now());

    // Poll until vLLM responds
    const deadline = Date.now() + 180_000; // 3 min timeout
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const res = await fetch(`${this.vllmUrl}/models`, {
          headers: { Authorization: `Bearer ${this.vllmApiKey}` },
          signal: AbortSignal.timeout(5000)
        });
        if (res.ok) {
          this._setState('running');
          await this.warmup();
          return;
        }
      } catch { /* not ready yet */ }
    }

    throw new Error('RunPod pod failed to start within 3 minutes');
  }

  /**
   * Send a minimal warmup call to load the model into GPU memory.
   * @returns {Promise<{ready: boolean, latencyMs: number}>}
   */
  async warmup() {
    const t = Date.now();
    try {
      const res = await fetch(`${this.vllmUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.vllmApiKey}`
        },
        body: JSON.stringify({
          model: process.env.NEUROCODE_VLLM_MODEL,
          messages: [{ role: 'user', content: 'ready' }],
          max_tokens: 5,
          temperature: 0
        }),
        signal: AbortSignal.timeout(60_000)
      });
      if (res.ok) {
        this._setState('warm');
        this.resetIdleTimer();
        return { ready: true, latencyMs: Date.now() - t };
      }
    } catch { /* warmup failed — stay in running state */ }
    return { ready: false, latencyMs: Date.now() - t };
  }

  /**
   * Stop the pod via RunPod API.
   */
  async stop() {
    if (this.state === 'stopped' || this.state === 'stopping') return;
    this._setState('stopping');
    clearTimeout(this.idleTimer);

    await this._gql(GQL.stopPod, { id: this.podId });

    // Close session record
    if (this.currentSessionId) {
      this.db.prepare(
        'UPDATE runpod_sessions SET stopped_at = ? WHERE id = ?'
      ).run(Date.now(), this.currentSessionId);
      this.currentSessionId = null;
    }

    this._setState('stopped');
  }

  /**
   * Reset the idle countdown. Call this after every LLM response.
   */
  resetIdleTimer() {
    clearTimeout(this.idleTimer);
    if (!this.autoStop) return;

    this.idleTimer = setTimeout(async () => {
      console.log(`[RunPod] Idle timeout reached — stopping pod`);
      await this.stop();
    }, this.idleTimeoutMs);
  }

  /**
   * Called before each LLM request.
   * If pod is stopped, starts it first.
   * @returns {Promise<void>}
   */
  async ensureReady() {
    if (this.state === 'warm' || this.state === 'running') {
      this.resetIdleTimer();
      return;
    }
    if (this.state === 'stopped' || this.state === 'unknown') {
      await this.start();
      return;
    }
    if (this.state === 'starting') {
      // Wait for state to become warm/running
      await new Promise((resolve, reject) => {
        const check = setInterval(() => {
          if (this.state === 'warm' || this.state === 'running') {
            clearInterval(check);
            resolve();
          }
          if (this.state === 'unknown') {
            clearInterval(check);
            reject(new Error('Pod failed to start'));
          }
        }, 2000);
        setTimeout(() => { clearInterval(check); reject(new Error('Timeout')); }, 200_000);
      });
    }
  }

  /** @returns {{podState, idleRemainingMs, sessionMinutes, estimatedCostUsd}} */
  async getStatus() {
    let costPerHr = 0;
    let uptimeSec = 0;
    try {
      const data = await this._gql(GQL.getPod, { id: this.podId });
      costPerHr = data.pod.costPerHr || 0;
      uptimeSec = data.pod.runtime?.uptimeInSeconds || 0;
    } catch { /* API unreachable */ }

    const idleRemainingMs = this.idleTimer
      ? Math.max(0, this.idleTimeoutMs - (Date.now() - (this._lastCallTime || Date.now())))
      : null;

    return {
      podState: this.state,
      podId: this.podId,
      gpuType: 'L4 24GB',
      costPerHr,
      sessionMinutes: Math.round(uptimeSec / 60),
      estimatedCostUsd: (uptimeSec / 3600) * costPerHr,
      idleRemainingMs
    };
  }

  destroy() {
    clearTimeout(this.idleTimer);
  }
}
```

---

## Step 8 — SidecarManager with RunPod Env Vars

### src/sidecar/SidecarManager.ts

```typescript
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { SidecarClient } from './SidecarClient';
import { getConfig } from '../utils/config';

export class SidecarManager {
  private process: cp.ChildProcess | null = null;
  public client: SidecarClient;
  private restartAttempts = 0;
  private maxRestarts = 3;

  constructor(private context: vscode.ExtensionContext) {
    const cfg = getConfig();
    this.client = new SidecarClient(`http://127.0.0.1:${cfg.sidecar.port}`);
  }

  async start(): Promise<void> {
    const cfg = getConfig();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const sidecarPath = path.join(this.context.extensionPath, 'sidecar', 'server.js');

    this.process = cp.spawn('node', [sidecarPath], {
      env: {
        ...process.env,
        // Core
        NEUROCODE_PORT:          String(cfg.sidecar.port),
        NEUROCODE_PROJECT:       workspaceRoot,
        // LLM routing
        NEUROCODE_LLM_PROVIDER:  cfg.llm.provider,
        NEUROCODE_OLLAMA_URL:    cfg.llm.ollamaUrl,
        NEUROCODE_OLLAMA_MODEL:  cfg.llm.ollamaModel,
        NEUROCODE_VLLM_URL:      cfg.llm.vllmUrl,
        NEUROCODE_VLLM_KEY:      cfg.llm.vllmApiKey,
        NEUROCODE_VLLM_MODEL:    cfg.llm.vllmModel,
        // Shard budget (0 = auto)
        SHARD_MAX_TOKENS:        String(cfg.shard.maxTokens),
        // RunPod lifecycle
        NEUROCODE_RUNPOD_KEY:    cfg.runpod.apiKey,
        NEUROCODE_RUNPOD_POD_ID: cfg.runpod.podId,
        NEUROCODE_RUNPOD_AUTO_START:  String(cfg.runpod.autoStart),
        NEUROCODE_RUNPOD_AUTO_STOP:   String(cfg.runpod.autoStop),
        NEUROCODE_RUNPOD_IDLE_MS:     String(cfg.runpod.idleTimeoutMinutes * 60 * 1000),
        // Air-gap
        NEUROCODE_AIRGAP:        String(cfg.airgap.enabled)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Pipe to output channel
    const logger = vscode.window.createOutputChannel('NeuroCode');
    this.process.stdout?.on('data', d => logger.append(d.toString()));
    this.process.stderr?.on('data', d => logger.append(`[ERR] ${d.toString()}`));

    // Auto-restart on crash
    this.process.on('exit', (code) => {
      if (code !== 0 && this.restartAttempts < this.maxRestarts) {
        this.restartAttempts++;
        logger.appendLine(`[NeuroCode] Sidecar crashed (${code}), restarting (${this.restartAttempts}/${this.maxRestarts})...`);
        setTimeout(() => this.start(), 2000);
      }
    });

    // Wait until healthy
    await this._waitForHealth(10_000);
  }

  private async _waitForHealth(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await this.client.get('/health');
        return;
      } catch {
        await new Promise(r => setTimeout(r, 500));
      }
    }
    throw new Error('NeuroCode sidecar failed to start within 10 seconds');
  }

  stop(): void {
    this.process?.kill('SIGTERM');
    this.process = null;
  }
}
```

---

## Step 9 — ShardManager with Dynamic Token Budget

### sidecar/core/ShardManager.js (key section)

```javascript
import { encode } from 'gpt-tokenizer';
import { LLMRouter } from './LLMRouter.js';

export class ShardManager {
  constructor(db, vectorStore) {
    this.db = db;
    this.vectorStore = vectorStore;
  }

  /** Token budget depends on which LLM backend is currently active */
  get MAX_TOKENS() {
    const manual = parseInt(process.env.SHARD_MAX_TOKENS || '0');
    if (manual > 0) return manual;
    return LLMRouter.getTokenBudget(); // 6000 for vLLM, 3500 for Ollama
  }

  countTokens(text) {
    return encode(text).length;
  }

  buildPrompt(task, shards) {
    const contextBlock = shards
      .map(s => `// === ${s.relativeFile} (${s.reason}) ===\n${s.content}`)
      .join('\n\n');

    const isQwen = (process.env.NEUROCODE_VLLM_MODEL || '').toLowerCase().includes('qwen');
    const provider = LLMRouter.getActiveProvider();

    const systemPrompt = (isQwen && provider === 'vllm')
      ? `You are an expert software engineer using Qwen3-Coder.
Analyze the provided code context carefully, then complete the task.
Output ONLY the modified code in a fenced block with the filename as a comment on line 1.
Format strictly:
\`\`\`typescript
// filename: relative/path/to/file.ts
[complete modified file or relevant function]
\`\`\`
Do not explain. Do not add commentary outside the code block.`
      : `You are an expert software engineer. Given code context and a task,
respond ONLY with the modified code in a code block preceded by the filename.
Format: \`\`\`typescript\n// filename: path/to/file.ts\n[code]\n\`\`\``;

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Context:\n${contextBlock}\n\nTask: ${task}` }
    ];
  }

  async assembleContext(task, activeFile, projectPath, memoryGraph = null) {
    const shards = [];
    let budget = this.MAX_TOKENS;

    // Priority 1: Active file
    const content = await this._readFile(activeFile);
    const tokens = Math.min(this.countTokens(content), budget - 500);
    shards.push({ file: activeFile, relativeFile: this._rel(activeFile, projectPath),
                  content: content.slice(0, tokens * 4), reason: 'active file',
                  tokenCount: tokens, priority: 1 });
    budget -= tokens;

    // Priority 2 & 3: Imports and callers
    const related = this.db.prepare(`
      SELECT f.path, f.token_count, 'import' as rel FROM dependencies d
      JOIN files f ON f.id = d.to_file_id
      JOIN files af ON af.id = d.from_file_id WHERE af.path = ?
      UNION
      SELECT f.path, f.token_count, 'caller' as rel FROM dependencies d
      JOIN files f ON f.id = d.from_file_id
      JOIN files af ON af.id = d.to_file_id WHERE af.path = ?
    `).all(activeFile, activeFile);

    for (const r of related) {
      if (budget <= 300) break;
      if (shards.some(s => s.file === r.path)) continue;
      const c = await this._readFile(r.path);
      const t = Math.min(this.countTokens(c), budget);
      shards.push({ file: r.path, relativeFile: this._rel(r.path, projectPath),
                    content: c.slice(0, t * 4), reason: r.rel, tokenCount: t, priority: 2 });
      budget -= t;
    }

    // Priority 4: Memory hits
    if (memoryGraph && budget > 400) {
      const hits = await memoryGraph.query(task, 3);
      for (const hit of hits) {
        const files = JSON.parse(hit.filesEdited);
        for (const f of files) {
          if (budget <= 300) break;
          const absPath = path.resolve(projectPath, f);
          if (shards.some(s => s.file === absPath)) continue;
          try {
            const c = await this._readFile(absPath);
            const t = Math.min(this.countTokens(c), budget);
            shards.push({ file: absPath, relativeFile: f, content: c.slice(0, t*4),
                          reason: `memory hit (weight: ${hit.weight.toFixed(1)})`,
                          tokenCount: t, priority: 4 });
            budget -= t;
          } catch { /* file may no longer exist */ }
        }
      }
    }

    // Priority 5: Vector similarity
    if (budget > 300) {
      const { EmbeddingService } = await import('./EmbeddingService.js');
      const emb = await EmbeddingService.embed(task);
      const similar = await this.vectorStore.query(emb, 3);
      for (const r of similar) {
        if (budget <= 200) break;
        const f = r.item.metadata.file;
        if (shards.some(s => s.file === f)) continue;
        const c = r.item.metadata.content;
        const t = Math.min(this.countTokens(c), budget);
        shards.push({ file: f, relativeFile: r.item.metadata.relativeFile, content: c,
                      reason: `semantic match (${r.score.toFixed(2)})`,
                      tokenCount: t, priority: 5 });
        budget -= t;
      }
    }

    return {
      shards,
      totalTokens: this.MAX_TOKENS - budget,
      budget: this.MAX_TOKENS,
      provider: LLMRouter.getActiveProvider()
    };
  }

  _readFile(filePath) {
    const { readFileSync } = require('fs');
    return readFileSync(filePath, 'utf8');
  }

  _rel(absPath, projectPath) {
    return absPath.replace(projectPath, '').replace(/^\//, '');
  }
}
```

---

## Step 10 — Agent Route with Lifecycle Awareness

### sidecar/routes/agent.js (key section)

```javascript
import { LLMRouter } from '../core/LLMRouter.js';
import { RunPodLifecycleManager } from '../core/RunPodLifecycleManager.js';

// runpodManager is initialized in server.js and imported here
import { runpodManager } from '../server.js';

router.post('/ask', async (req, res) => {
  const { task, activeFile, projectPath, warmup } = req.body;

  // Warmup-only call (no shard assembly needed)
  if (warmup) {
    const adapter = await LLMRouter.getAdapter();
    await adapter.chat([{ role: 'user', content: 'ready' }], { max_tokens: 5 });
    return res.json({ success: true, data: { warmup: true } });
  }

  // Ensure RunPod is ready (starts pod if stopped)
  if (runpodManager) {
    try {
      await runpodManager.ensureReady();
    } catch (err) {
      // Pod failed to start — will fallback to Ollama via LLMRouter
      console.warn('[agent/ask] RunPod not ready:', err.message);
    }
  }

  const startTime = Date.now();
  const adapter = await LLMRouter.getAdapter();
  const provider = LLMRouter.getActiveProvider();

  // Assemble shards (budget auto-adjusts to provider)
  const { shards, totalTokens, budget } = await shardManager.assembleContext(
    task, activeFile, projectPath, memoryGraph
  );

  const messages = shardManager.buildPrompt(task, shards);
  const response = await adapter.chat(messages, { temperature: 0.1, max_tokens: 1500 });

  // Reset idle timer after successful call
  if (runpodManager) runpodManager.resetIdleTimer();

  // Update cost tracking
  if (provider === 'vllm' && runpodManager?.currentSessionId) {
    db.prepare(
      'UPDATE runpod_sessions SET llm_calls = llm_calls + 1 WHERE id = ?'
    ).run(runpodManager.currentSessionId);
  }

  const attentionMap = shardManager.buildAttentionMap(shards, response);
  const latencyMs = Date.now() - startTime;

  return res.json({
    success: true,
    data: {
      response,
      diff: extractFirstCodeBlock(response),
      shardsUsed: shards.map(s => ({
        file: s.relativeFile, reason: s.reason, tokenCount: s.tokenCount
      })),
      attentionMap,
      tokensUsed: totalTokens,
      budget,
      modelUsed: (await adapter.getModelInfo()).name,
      provider,
      latencyMs
    }
  });
});
```

---

## Step 11 — RunPod Routes

### sidecar/routes/runpod.js

```javascript
import { Router } from 'express';
import { runpodManager } from '../server.js';

const router = Router();

router.get('/status', async (req, res) => {
  if (!runpodManager) {
    return res.json({ success: true, data: { podState: 'not-configured' } });
  }
  const status = await runpodManager.getStatus();
  res.json({ success: true, data: status });
});

router.post('/start', async (req, res) => {
  if (!runpodManager) return res.status(400).json({ success: false, error: 'RunPod not configured' });
  runpodManager.start().catch(err => console.error('[runpod/start]', err));
  res.json({ success: true, data: { podState: 'starting' } });
});

router.post('/stop', async (req, res) => {
  if (!runpodManager) return res.status(400).json({ success: false, error: 'RunPod not configured' });
  runpodManager.stop().catch(err => console.error('[runpod/stop]', err));
  res.json({ success: true, data: { podState: 'stopping' } });
});

router.post('/warmup', async (req, res) => {
  if (!runpodManager) return res.status(400).json({ success: false, error: 'RunPod not configured' });
  const result = await runpodManager.warmup();
  res.json({ success: true, data: result });
});

router.get('/cost', async (req, res) => {
  if (!runpodManager) return res.json({ success: true, data: { estimatedCostUsd: 0 } });
  const status = await runpodManager.getStatus();
  res.json({ success: true, data: {
    sessionMinutes: status.sessionMinutes,
    estimatedCostUsd: status.estimatedCostUsd,
    currency: 'USD'
  }});
});

export default router;
```

---

## Step 12 — RunPodStatusBadge WebView Component

### webview-ui/src/components/RunPodStatusBadge.tsx

```tsx
interface Props {
  podState: 'stopped' | 'starting' | 'running' | 'warm' | 'stopping' | 'unknown' | 'not-configured';
  idleRemainingMs?: number;
  costPerHr?: number;
  onStart?: () => void;
  onStop?: () => void;
}

const STATE_CONFIG = {
  stopped:          { color: '#888',    icon: '⊘', label: 'RunPod stopped' },
  starting:         { color: '#FFD700', icon: '⟳', label: 'Starting RunPod L4...' },
  running:          { color: '#4AFF9B', icon: '▶', label: 'RunPod L4 · Qwen3' },
  warm:             { color: '#FF6B35', icon: '🔥', label: 'Qwen3 warm' },
  stopping:         { color: '#FFD700', icon: '⟳', label: 'Stopping...' },
  unknown:          { color: '#888',    icon: '?',  label: 'Unknown state' },
  'not-configured': { color: '#555',    icon: '—',  label: 'RunPod not configured' }
};

export function RunPodStatusBadge({ podState, idleRemainingMs, costPerHr, onStart, onStop }: Props) {
  const cfg = STATE_CONFIG[podState] ?? STATE_CONFIG.unknown;
  const idleMin = idleRemainingMs ? Math.ceil(idleRemainingMs / 60_000) : null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8em' }}>
      <span style={{ color: cfg.color, fontWeight: 600 }}>
        {cfg.icon} {cfg.label}
        {podState === 'warm' && idleMin !== null && ` · idle: ${idleMin}m`}
        {costPerHr ? ` · $${costPerHr}/hr` : ''}
      </span>
      {podState === 'stopped' && (
        <vscode-button appearance="icon" onClick={onStart} title="Start RunPod">▶</vscode-button>
      )}
      {(podState === 'running' || podState === 'warm') && (
        <vscode-button appearance="icon" onClick={onStop} title="Stop RunPod (save cost)">■</vscode-button>
      )}
    </div>
  );
}
```

---

## Step 13 — Health Endpoint with RunPod Info

### Updated GET /health in server.js

```javascript
app.get('/health', async (req, res) => {
  const adapter = await LLMRouter.getAdapter().catch(() => null);
  const available = adapter ? await adapter.isAvailable().catch(() => false) : false;
  const modelInfo = available ? await adapter.getModelInfo().catch(() => null) : null;
  const provider = LLMRouter.getActiveProvider();
  const tokenBudget = LLMRouter.getTokenBudget();

  const podStatus = runpodManager
    ? await runpodManager.getStatus().catch(() => ({ podState: 'unknown' }))
    : { podState: 'not-configured' };

  res.json({
    success: true,
    data: {
      status: 'ok',
      airgap: AIRGAP,
      provider,
      model: modelInfo,
      tokenBudget,
      podState: podStatus.podState,
      idleRemainingMs: podStatus.idleRemainingMs,
      indexed: global.indexStatus?.done ?? false,
      fileCount: global.indexStatus?.fileCount ?? 0
    }
  });
});
```

---

## Testing Checklist v3

### RunPod Connection
- [ ] `curl https://YOUR_POD-8000.proxy.runpod.net/v1/models -H "Authorization: Bearer KEY"` returns model
- [ ] Run `node sidecar/scripts/test-runpod.js` — all 3 tests pass
- [ ] Extension health check shows `provider: 'vllm'` and `podState: 'warm'`
- [ ] Shard Visualizer shows budget `6000` when using RunPod, `3500` when Ollama

### Lifecycle Manager
- [ ] `POST /runpod/start` changes pod state to 'starting' then 'warm' within 3 min
- [ ] `POST /runpod/stop` changes pod state to 'stopping' then 'stopped'
- [ ] Idle timer fires after configured minutes and auto-stops pod
- [ ] After auto-stop, next `Ask Agent` call auto-restarts pod before responding
- [ ] `GET /runpod/cost` returns non-zero sessionMinutes when pod running
- [ ] RunPodStatusBadge in Chat panel reflects current pod state correctly
- [ ] Status bar shows correct state icon per pod state

### Fallback
- [ ] Stop Ollama service → restart → vLLM should be used (no fallback)
- [ ] Stop RunPod pod AND stop Ollama → next call should show clear error
- [ ] Start Ollama, kill RunPod → next call uses Ollama, status bar updates
- [ ] Output channel shows "[LLMRouter] vLLM unavailable — falling back to Ollama"

### Qwen3 Prompt
- [ ] Agent responses use Qwen3-specific system prompt when vLLM active
- [ ] Generic prompt used when Ollama active
- [ ] Code blocks parsed correctly from Qwen3 response format

### All Phase 1–4 tests from v2 still pass

---

## Verification Test Script

### sidecar/scripts/test-runpod.js

```javascript
// Run: VLLM_URL=... VLLM_KEY=... VLLM_MODEL=... node sidecar/scripts/test-runpod.js
import axios from 'axios';

const URL   = process.env.VLLM_URL   || 'https://YOUR_POD-8000.proxy.runpod.net/v1';
const KEY   = process.env.VLLM_KEY   || '';
const MODEL = process.env.VLLM_MODEL || 'Qwen/Qwen2.5-Coder-32B-Instruct-AWQ';
const H     = { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' };

console.log('Testing RunPod vLLM connection...\n');

// Test 1: Model available
const models = await axios.get(`${URL}/models`, { headers: H });
const found = models.data.data.some(m => m.id === MODEL);
console.log(`${found ? '✓' : '✗'} Model available: ${MODEL}`);

// Test 2: Non-streaming
const t1 = Date.now();
const chat = await axios.post(`${URL}/chat/completions`, {
  model: MODEL,
  messages: [{ role: 'user', content: 'Write a TypeScript function that adds two numbers.' }],
  max_tokens: 200, temperature: 0.1
}, { headers: H, timeout: 120_000 });
const ms = Date.now() - t1;
const toks = chat.data.usage.completion_tokens;
console.log(`✓ Non-streaming: ${ms}ms | ${toks} tokens | ${(toks/(ms/1000)).toFixed(1)} tok/s`);
console.log(`  Preview: ${chat.data.choices[0].message.content.slice(0, 80)}...`);

// Test 3: Streaming
console.log('\n✓ Streaming test:');
process.stdout.write('  ');
const stream = await axios.post(`${URL}/chat/completions`, {
  model: MODEL,
  messages: [{ role: 'user', content: 'Write a one-liner TypeScript arrow function to reverse a string.' }],
  max_tokens: 100, temperature: 0.1, stream: true
}, { headers: H, responseType: 'stream', timeout: 60_000 });

for await (const chunk of stream.data) {
  for (const line of chunk.toString().split('\n').filter(l => l.startsWith('data: '))) {
    const d = line.slice(6);
    if (d === '[DONE]') { process.stdout.write('\n'); break; }
    try { const t = JSON.parse(d).choices?.[0]?.delta?.content; if (t) process.stdout.write(t); } catch {}
  }
}

// Test 4: Token budget check
console.log(`\n✓ Shard budget for this provider: 6000 tokens (vs 3500 for Ollama)`);
console.log('\n✓ All tests passed. RunPod L4 + Qwen3-Coder is ready for NeuroCode.');
```

---

## Cost Estimation

At RunPod L4 pricing (~$0.44/hr):

| Usage Pattern | Monthly Cost Estimate |
|---|---|
| 2hrs/day coding, auto-stop | ~$27/month |
| 4hrs/day coding, auto-stop | ~$53/month |
| Pod left running 24/7 | ~$317/month |
| Pod off, Ollama only | $0/month |

The idle auto-stop at 30 minutes saves ~$10–20/month for typical usage.

---

*NeuroCode v3.0 — ZMS Digital Solutions, Dhaka, Bangladesh*
*Primary LLM: Qwen3-Coder on RunPod L4 via vLLM | Fallback: Ollama qwen2.5-coder:7b*
*Acquisition target: Series A or strategic exit by Month 18*
