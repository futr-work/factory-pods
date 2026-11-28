-- ============================================================================
-- Measurement Pod — Dual Engine Schema (Cloudflare D1 / SQLite WAL via PodStorage)
-- ============================================================================

-- Standard Factory Pod chassis tables
CREATE TABLE IF NOT EXISTS pod_info (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT UNIQUE NOT NULL,
  owner_id TEXT NOT NULL DEFAULT 'hub',
  topic TEXT NOT NULL,
  source TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  result_json TEXT,
  error_message TEXT,
  lease_expires_at INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
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

-- ============================================================================
-- Normalized Typed Measurement Core (No universal all-metrics JSON blob)
-- ============================================================================

-- 1. Tenant / Resource Registry with canonical Worldview-compatible entity_urn
CREATE TABLE IF NOT EXISTS ms_resources (
  tenant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  entity_urn TEXT NOT NULL UNIQUE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('site', 'analytics_property', 'ad_account', 'server_service')),
  source_resource_id TEXT NOT NULL,
  display_name TEXT,
  active_from TEXT NOT NULL,
  active_to TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, resource_id)
);

-- 2. Tenant-Scoped Versioned Metric Definitions (explicit unit, grain, window timezone, dimensions, aggregation & comparability)
CREATE TABLE IF NOT EXISTS ms_definitions (
  tenant_id TEXT NOT NULL,
  metric_id TEXT NOT NULL,
  version TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family IN ('seo', 'analytics', 'spend', 'telemetry')),
  unit TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('integer', 'decimal_string', 'gauge', 'counter')),
  grain TEXT NOT NULL,
  window_tz TEXT NOT NULL,
  dimensions_schema_json TEXT NOT NULL,
  numerator_rule TEXT,
  denominator_rule TEXT,
  exclusions_rule TEXT,
  aggregation_rule TEXT NOT NULL,
  comparability_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, metric_id, version)
);

-- 3. Collection Runs & Attempts (idempotent on tenant + idempotency_key)
CREATE TABLE IF NOT EXISTS ms_runs (
  run_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_resource_id TEXT NOT NULL,
  schedule_id TEXT,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  cursor TEXT,
  status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'partial', 'succeeded', 'failed', 'blocked')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  error_class TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES ms_resources(tenant_id, resource_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ms_attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'partial', 'succeeded', 'failed', 'blocked')),
  cursor TEXT,
  error_class TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  FOREIGN KEY (run_id) REFERENCES ms_runs(run_id) ON DELETE CASCADE
);

-- 4. Immutable Safe Evidence Handles (metadata only; raw bytes and credentials never live here)
CREATE TABLE IF NOT EXISTS ms_evidence (
  evidence_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  uri_pointer TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  media_type TEXT NOT NULL,
  privacy_class TEXT NOT NULL CHECK (privacy_class IN ('public', 'internal', 'restricted', 'pii_minimized')),
  retention_class TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  source_as_of TEXT NOT NULL,
  adapter_name TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES ms_runs(run_id) ON DELETE CASCADE
);

-- 5. Append-Only Typed Observations & Source Revisions
CREATE TABLE IF NOT EXISTS ms_observations (
  record_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  obs_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  source TEXT NOT NULL,
  run_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  metric_id TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  comparability_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  window_tz TEXT NOT NULL,
  grain TEXT NOT NULL,
  dimensions_json TEXT NOT NULL,
  dimensions_hash TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('integer', 'decimal_string', 'gauge', 'counter')),
  value_num REAL,
  value_text TEXT,
  currency TEXT,
  billing_date TEXT,
  gross_or_net TEXT CHECK (gross_or_net IS NULL OR gross_or_net IN ('gross', 'net')),
  refund_text TEXT,
  credit_text TEXT,
  tax_text TEXT,
  collection_request_budget INTEGER,
  numerator REAL,
  denominator REAL,
  exclusions_json TEXT,
  sample_time TEXT,
  gauge_reducer TEXT CHECK (gauge_reducer IS NULL OR gauge_reducer IN ('last', 'min', 'max', 'mean')),
  counter_start REAL,
  counter_end REAL,
  counter_reset INTEGER NOT NULL DEFAULT 0 CHECK (counter_reset IN (0, 1)),
  interpretation_version TEXT NOT NULL,
  source_revision INTEGER NOT NULL DEFAULT 1,
  source_as_of TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES ms_resources(tenant_id, resource_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, metric_id, definition_version) REFERENCES ms_definitions(tenant_id, metric_id, version),
  FOREIGN KEY (run_id) REFERENCES ms_runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id) REFERENCES ms_evidence(evidence_id) ON DELETE CASCADE
);

-- 5b. Idempotent Ingest Batch Deduplication Ledger (prevents replaying old partial pages from regressing runs/coverage)
CREATE TABLE IF NOT EXISTS ms_ingest_batches (
  tenant_id TEXT NOT NULL,
  batch_digest TEXT NOT NULL,
  run_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  observation_count INTEGER NOT NULL,
  coverage_status TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, batch_digest)
);

-- 6. Explicit Coverage & Source Reconciliation (missing never synthesizes zero)
CREATE TABLE IF NOT EXISTS ms_coverage (
  tenant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  source TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'attempted', 'successful', 'zero', 'partial', 'failed', 'blocked', 'not-collected', 'stale')),
  expected_cadence_sec INTEGER,
  expected_lag_sec INTEGER,
  source_total_text TEXT,
  interpreted_total_text TEXT,
  discrepancy_text TEXT,
  reconciliation_status TEXT NOT NULL DEFAULT 'unknown' CHECK (reconciliation_status IN ('matched', 'mismatch', 'partial', 'unknown')),
  last_run_id TEXT,
  freshness_at TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, resource_id, source, window_start, window_end),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES ms_resources(tenant_id, resource_id) ON DELETE CASCADE
);

-- 7. Non-Causal Work / Deploy Annotations (other pods annotate context; never self-score)
CREATE TABLE IF NOT EXISTS ms_annotations (
  annotation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  entity_urn TEXT NOT NULL,
  pod_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('deploy', 'fixpack', 'config_change', 'incident', 'note')),
  commit_sha TEXT,
  pr_url TEXT,
  summary TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, resource_id) REFERENCES ms_resources(tenant_id, resource_id) ON DELETE CASCADE
);

-- 8. Worldview-Ready Monotonic Cursor Delta Feed
CREATE TABLE IF NOT EXISTS ms_events (
  cursor_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  entity_urn TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('resource.registered', 'run.updated', 'observation.recorded', 'coverage.updated', 'annotation.recorded')),
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 9. Invisible Staged Multi-Chunk Imports (committed all-or-nothing in one atomic transaction)
CREATE TABLE IF NOT EXISTS ms_schema_migrations (
  migration_id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ms_staged_import_sessions (
  tenant_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  owner_caller_id TEXT NOT NULL,
  session_token TEXT NOT NULL,
  resource_ids_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, import_id)
);

CREATE TABLE IF NOT EXISTS ms_staged_imports (
  tenant_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  generation_id TEXT NOT NULL,
  resource_ids_json TEXT NOT NULL,
  groups_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, import_id, chunk_index)
);

-- 9b. Durable Staged Import Finalization Receipts (idempotent replay & atomic commit arbitration)
CREATE TABLE IF NOT EXISTS ms_staged_import_receipts (
  tenant_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  expected_chunks INTEGER NOT NULL,
  resource_ids_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, import_id)
);

CREATE TABLE IF NOT EXISTS ms_staged_import_receipt_chunks (
  tenant_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  part_index INTEGER NOT NULL,
  resource_ids_json TEXT NOT NULL,
  groups_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, import_id, part_index)
);

-- 10. Scheduled Collector Registry (M2 GSC & Bing read-only connectors; credentials NEVER stored in D1)
CREATE TABLE IF NOT EXISTS ms_collector_schedules (
  schedule_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  connector TEXT NOT NULL CHECK (connector IN ('gsc', 'bing_webmaster')),
  source_resource_id TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  cadence_sec INTEGER NOT NULL DEFAULT 86400 CHECK (cadence_sec >= 300),
  expected_lag_sec INTEGER NOT NULL DEFAULT 259200 CHECK (expected_lag_sec >= 0),
  daily_request_budget INTEGER NOT NULL DEFAULT 100 CHECK (daily_request_budget >= 1 AND daily_request_budget <= 10000),
  max_rows_per_window INTEGER NOT NULL DEFAULT 25000 CHECK (max_rows_per_window >= 1 AND max_rows_per_window <= 25000),
  dimensions_json TEXT NOT NULL DEFAULT '["date","page","query","country","device"]',
  search_type TEXT NOT NULL DEFAULT 'web',
  zero_spend_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (zero_spend_confirmed IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  cursor_date TEXT,
  pending_window_date TEXT,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3 CHECK (max_retries >= 1 AND max_retries <= 10),
  cooldown_until INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_status TEXT NOT NULL DEFAULT 'planned' CHECK (last_status IN ('planned', 'running', 'partial', 'succeeded', 'failed', 'blocked')),
  last_error_class TEXT,
  last_error_message TEXT,
  requests_used_date TEXT,
  requests_used_today INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, resource_id, connector),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES ms_resources(tenant_id, resource_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ms_collector_due ON ms_collector_schedules(enabled, next_run_at ASC);
CREATE INDEX IF NOT EXISTS idx_ms_collector_tenant_res ON ms_collector_schedules(tenant_id, resource_id, connector);

-- Indexes for bounded paginated queries & capacity floor
CREATE INDEX IF NOT EXISTS idx_tasks_task_id ON tasks(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pod_tincan_topic ON tincan_messages(topic);
CREATE INDEX IF NOT EXISTS idx_episodes_topic ON episodes(topic, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ms_runs_tenant_res ON ms_runs(tenant_id, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ms_attempts_run ON ms_attempts(run_id, attempt_number DESC);
CREATE INDEX IF NOT EXISTS idx_ms_evidence_tenant_res ON ms_evidence(tenant_id, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ms_obs_query ON ms_observations(tenant_id, resource_id, metric_id, window_start, window_end, source_revision DESC);
CREATE INDEX IF NOT EXISTS idx_ms_obs_compat ON ms_observations(tenant_id, resource_id, metric_id, comparability_key, dimensions_hash, source_revision DESC);
CREATE INDEX IF NOT EXISTS idx_ms_coverage_query ON ms_coverage(tenant_id, resource_id, source, window_start DESC);
CREATE INDEX IF NOT EXISTS idx_ms_annotations_query ON ms_annotations(tenant_id, resource_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ms_events_cursor ON ms_events(tenant_id, cursor_id ASC);
