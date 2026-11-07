-- ============================================================================
-- Factory Pod Base Template — Dual Engine Schema (D1 / SQLite WAL)
-- ============================================================================

CREATE TABLE IF NOT EXISTS pod_info (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT UNIQUE NOT NULL,
  topic TEXT NOT NULL,
  source TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  result_json TEXT,
  error_message TEXT,
  lease_expires_at INTEGER,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tincan_messages (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  topic TEXT NOT NULL,
  from_pod TEXT NOT NULL,
  to_pod TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'delivered' CHECK (status IN ('pending', 'delivered', 'acknowledged')),
  created_at INTEGER NOT NULL
);

-- Episodic memory log: enables continuous learning across repeated task classes
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  spec_summary TEXT NOT NULL,
  action_taken TEXT NOT NULL,
  outcome TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Semantic memory & beliefs: distilled operational principles synthesized during sleep/consolidation
CREATE TABLE IF NOT EXISTS beliefs (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  claim TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  source_episodes_json TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_task_id ON tasks(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pod_tincan_topic ON tincan_messages(topic);
CREATE INDEX IF NOT EXISTS idx_episodes_topic ON episodes(topic, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_beliefs_domain ON beliefs(domain);
CREATE INDEX IF NOT EXISTS idx_beliefs_confidence ON beliefs(confidence DESC);
