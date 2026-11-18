// Additive schema upgrades the Worker applies to its own D1 binding, so a deploy never depends on an operator
// credential with D1 API rights. Mirrors migrations/0007; every step is idempotent and checked before it runs.

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
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_usage_pod_created ON llm_usage_events(pod_id, created_at)").run();
}
