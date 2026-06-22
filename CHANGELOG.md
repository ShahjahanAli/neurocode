# Change Log

All notable changes to the NeuroCode VS Code extension are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **Cursor-like chat UI** on the right **secondary sidebar** (configurable via `neurocode.ui.chatLocation`)
- **Chat mode toolbar:** Auto, Ask, Plan, Edit, Agent
- **IntentResolver** — history-aware natural language routing (explain / plan / implement)
- **Agent tool loop** (`POST /agent/loop/stream`) with tools: `read_file`, `search_code`, `write_file`, `reply`
- **Auto-apply** — Implement mode writes files when batch completes (`neurocode.chat.autoApply`)
- **Auto-continue** — Cursor-style continuation for truncated outputs (`neurocode.chat.autoContinue`)
- **Fix on check** — Incomplete file + review/check auto-routes to implement (`neurocode.chat.fixOnCheck`)
- **Collapsible code cards** in chat — large blocks collapsed by default, expandable (Cursor-style)
- **Auto-index on open** with retries and per-project health (`neurocode.indexing.autoIndex`)
- Settings: `neurocode.chat.mode`, `neurocode.chat.agentMaxSteps`, `neurocode.chat.agentToolMaxSteps`

### Changed

- Chat orchestration via `ChatOrchestrator.js` with SSE streaming (`POST /agent/chat/stream`)
- Plan step execution uses implement prompts (`buildMessagesForIntent('edit')`)
- Improved diff parsing for unfenced `// path/to/file.ts` headers
- RunPod vLLM stream errors surfaced with actionable messages

### Fixed

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
