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
