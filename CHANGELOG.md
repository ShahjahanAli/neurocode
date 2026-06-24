# Change Log

All notable changes to the NeuroCode VS Code extension are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **Agent session state** — `AgentToolLoop` rebuilds a bounded prompt each step (task + session log + cached file previews); input tokens stay ~2–4k per step instead of growing with history
- **`search_replace` tool** — line-level edits with low output token cost; preferred over `write_file` for import fixes and small changes
- **LLM-first Auto routing** — `IntentRouter` with `seed_paths` from stack traces and error text; Auto mode uses agent tool loop (not read-only investigate)
- **Corruption detection** — agent detects files containing tool-call JSON and prompts restore before fix
- **Write safety guards** — `isAgentToolArtifact` blocks tool JSON in `createOrApplyFile`, `applyPendingWrites`, and `AgentTools.write_file`; agent loop skips markdown auto-apply
- **`neurocode.llm.maxOutputTokens`** — default raised to **2048**; `getAgentOutputTokens()` for agent steps (up to 8000 cap)
- **OpenAI-compatible LLM gateway** — single `OpenAICompatibleAdapter` for any `/v1/chat/completions` endpoint (LiteLLM, vLLM, RunPod proxy, OpenAI, custom gateway)
- **LLM config refactor** — `neurocode.llm.mode`, `apiBaseUrl`, `apiKey`, `model`, `gatewayLabel`; legacy `vllmUrl` / `openaiUrl` / `provider` auto-migrate via `resolveLlmConfig()`
- **Cursor-style model picker** — **Auto** (optimal model per task) or **Manual** from `GET /v1/models`; `ModelSelector.js`, `GET /llm/models`, `POST /llm/resolve`
- **Chat attachments** — attach current file, editor selection, or browse files; injected as priority-0 shards (`neurocode.chat.maxAttachments`)
- **Analytics panel** — token usage, latency, thumbs up/down feedback per response
- **Change review** — Cursor-style Accept / Reject per file, diff editor, Accept All / Reject All
- **Drift panel** — semantic drift alerts UI wired to `GET /drift/status` and acknowledge
- **Genome panel** — edit genome stats, consent, and JSONL export in sidebar
- **FileQueue** — serialized file reads for indexer and shard assembly (I/O storm prevention)
- **Task queue DAG UI** — improved `TaskNode` visualization in Task Queue panel
- **LlmConnectionBadge** — replaces RunPod-specific status badge; shows gateway vs Ollama connection
- **Cursor-like chat UI** on the right **secondary sidebar** (configurable via `neurocode.ui.chatLocation`)
- **Chat mode toolbar:** Auto, Ask, Plan, Edit, Agent
- **IntentResolver** — history-aware natural language routing (explain / plan / implement)
- **Cursor-style intent routing** — `IntentRouter` with permissions (`readOnly`, `allowWrites`, `investigate`); debug/config questions use read-only **Investigate** loop (`read_file`, `search_code`, `reply`) instead of rewriting files; investigate UI shows progress instead of raw tool JSON
- **Intent router settings** — `neurocode.chat.intentRouter` (`heuristic` | `hybrid` | `llm`), `neurocode.chat.investigateMaxSteps`
- **Agent tool loop** (`POST /agent/loop/stream`) with tools: `read_file`, `search_code`, `search_replace`, `write_file`, `reply`
- **Auto-apply** — Implement mode writes files when batch completes (`neurocode.chat.autoApply`)
- **Auto-continue** — Cursor-style continuation for truncated outputs (`neurocode.chat.autoContinue`)
- **Fix on check** — Incomplete file + review/check auto-routes to implement (`neurocode.chat.fixOnCheck`)
- **Collapsible code cards** in chat — large blocks collapsed by default, expandable (Cursor-style)
- **Auto-index on open** with retries and per-project health (`neurocode.indexing.autoIndex`)
- Settings: `neurocode.chat.mode`, `neurocode.chat.agentMaxSteps`, `neurocode.chat.agentToolMaxSteps`

### Changed

- **Auto mode execution** — routes to `AgentToolLoop` with LLM intent resolution; Ask pill uses read-only investigate loop only
- **Agent prompt strategy** — session cache holds full file bodies; LLM sees previews only (max 3 files × ~1.2k chars)
- **Seed paths** — stack trace and `./path.tsx` extraction merged with LLM `seed_paths` in `ChatOrchestrator`
- **RunPod is optional** — GPU pod lifecycle (`neurocode.runpod.*`) is independent of LLM routing; gateway URL is primary
- Chat orchestration via `ChatOrchestrator.js` with SSE streaming (`POST /agent/chat/stream`); `intent` event includes resolved `model`
- `LLMRouter.js` modes: `gateway` | `ollama`; provider id: `gateway` | `ollama`
- Plan step execution uses implement prompts (`buildMessagesForIntent('edit')`)
- Improved diff parsing for unfenced `// path/to/file.ts` headers
- Gateway stream errors surfaced with actionable messages
- Right sidebar tabs: Overview | Chat | Analytics | Tasks | Shards | Review | Memory | Drift | Genome | Debug

### Fixed

- Agent streamed tool JSON auto-applied to source files via `maybeAutoApplyEdits` / `parseCodeBlocks`
- Truncated `write_file` at output token limit staging invalid or tool-shaped content
- Agent loop echoing internal tool labels as final reply (`[Called read_file:…]`)
- Agent token bloat from append-only message history re-sending full file contents each step
- SSE client swallowed sidecar `error` events → showed misleading "stream ended without a response"
- SSE trailing buffer not flushed → missed `done` events
- `thanks` / social acknowledgments incorrectly triggered implement + file writes
- Intent classified before context assembled (incomplete-file check skipped)
- Duplicate plan-agent loop when Agent mode uses tool loop

## [0.1.0] — 2026-03-01

### Added

- Initial MVP: sidecar, indexer, shards, RunPod vLLM + Ollama routing
- Ask Agent, Task Queue, Shard Visualizer, Code Review, Memory, Debug panels
- Attention heatmap, RunPod lifecycle, air-gap mode, edit genome (opt-in)
