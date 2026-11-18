-- OpenAI-compatible backend for agents: tool support per model, per-caller tier policy and daily budget.

-- 1. Whether the upstream accepts `tools`. NULL = unknown; discovery fills it from OpenRouter supported_parameters,
--    and inference sets 0 when a provider refuses a tools request.
ALTER TABLE model_catalog ADD COLUMN supports_tools INTEGER;

-- 2. Per-caller routing policy and daily budget (caller '*' = stored default).
CREATE TABLE IF NOT EXISTS caller_policies (
  caller_id TEXT PRIMARY KEY,
  category TEXT,
  preferred_tier INTEGER NOT NULL DEFAULT 0 CHECK (preferred_tier BETWEEN 0 AND 2),
  max_tier INTEGER NOT NULL DEFAULT 1 CHECK (max_tier BETWEEN 0 AND 2),
  daily_budget_usd REAL NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- 3. Today's spend per caller is a range sum on (pod_id, created_at).
CREATE INDEX IF NOT EXISTS idx_usage_pod_created ON llm_usage_events(pod_id, created_at);
