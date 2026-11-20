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
  // Older Workers recorded the shared OpenRouter 429 as an individual model failure.
  // Translate verified probe rows once; untouched model-specific cooldowns retain their original meaning.
  const stamp = "probe_pool_upgrade_v1";
  if (!await db.prepare("SELECT key FROM pod_info WHERE key=?").bind(stamp).first()) {
    const now = Date.now(), day = 86_400_000, start = Math.floor(now/day)*day;
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO provider_quotas(provider,status,error,exhausted_at,resets_at,updated_at)
        SELECT 'openrouter:free','exhausted','OpenRouter free daily request limit',MAX(created_at),?,?
        FROM model_probes WHERE model_id LIKE 'openrouter:%' AND error LIKE '%HTTP 429%free-models-per-day%' AND created_at >= ?
        HAVING COUNT(*) > 0`).bind(start+day,now,start),
      db.prepare(`UPDATE model_catalog SET status='active' WHERE provider='openrouter' AND tier='FREE_TIER'
        AND status='rate_limited' AND EXISTS(SELECT 1 FROM model_probes WHERE model_id=model_catalog.id
        AND created_at=model_catalog.last_benchmarked_at AND error LIKE '%HTTP 429%free-models-per-day%')`),
      db.prepare("INSERT OR IGNORE INTO pod_info(key,value_json,updated_at) VALUES(?,'true',?)").bind(stamp,now)
    ]);
  }
}
