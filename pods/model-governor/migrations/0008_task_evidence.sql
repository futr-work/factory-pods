CREATE TABLE IF NOT EXISTS task_evidence (
  seq INTEGER PRIMARY KEY,
  evidence_id TEXT NOT NULL UNIQUE,
  task_class TEXT NOT NULL,
  task_ref TEXT NOT NULL,
  brief_sha256 TEXT NOT NULL,
  rubric_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_scope ON task_evidence(task_class, rubric_sha256, created_at, seq);
CREATE INDEX IF NOT EXISTS idx_evidence_brief ON task_evidence(task_class, rubric_sha256, brief_sha256, created_at, seq);
