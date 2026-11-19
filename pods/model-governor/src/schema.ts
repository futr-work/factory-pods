// Additive schema upgrades the Worker applies to its own D1 binding, so a deploy never depends on an operator
// credential with D1 API rights. Mirrors migrations 0007 and 0008; every step is idempotent and checked before it runs.

import type { PodStorage } from "@futr-work/pod-kernel/storage";

let ready: Promise<void> | null = null;

/** Runs once per isolate. A failure is not cached, so the next request retries. */
export function ensureSchema(db: PodStorage): Promise<void> {
  ready ??= upgrade(db).catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

/** For tests: forget that this isolate already upgraded. */
export function resetSchemaCache(): void {
  ready = null;
}

async function upgrade(db: PodStorage): Promise<void> {
  const { results } = await db.prepare("PRAGMA table_info(model_catalog)").all<{ name: string }>();
  if (!(results ?? []).some((c) => c.name === "supports_tools")) {
    await db.prepare("ALTER TABLE model_catalog ADD COLUMN supports_tools INTEGER").run();
  }
  await db
    .prepare(`CREATE TABLE IF NOT EXISTS caller_policies (
      caller_id TEXT PRIMARY KEY,
      category TEXT,
      preferred_tier INTEGER NOT NULL DEFAULT 0 CHECK (preferred_tier BETWEEN 0 AND 2),
      max_tier INTEGER NOT NULL DEFAULT 1 CHECK (max_tier BETWEEN 0 AND 2),
      daily_budget_usd REAL NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    )`)
    .run();
  const hasRecoveryMetadata = async () => {
    const columns = await db.prepare("PRAGMA table_info(llm_usage_events)").all<{ name: string }>();
    return columns.results.some(c => c.name === "recovery_metadata_json");
  };
  if (!await hasRecoveryMetadata()) {
    try { await db.prepare("ALTER TABLE llm_usage_events ADD COLUMN recovery_metadata_json TEXT").run(); }
    catch (error) { if (!await hasRecoveryMetadata()) throw error; } // Concurrent isolate can upgrade first.
  }
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_usage_pod_created ON llm_usage_events(pod_id, created_at)").run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS task_evidence (
  seq INTEGER PRIMARY KEY,
  evidence_id TEXT NOT NULL UNIQUE,
  task_class TEXT NOT NULL,
  task_ref TEXT NOT NULL,
  brief_sha256 TEXT NOT NULL,
  rubric_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL
)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_evidence_scope ON task_evidence(task_class, rubric_sha256, created_at, seq)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_evidence_brief ON task_evidence(task_class, rubric_sha256, brief_sha256, created_at, seq)`).run();
}
