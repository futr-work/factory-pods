-- Accounts Pod (accounts-pod) D1/SQLite Schema
-- Zero-secret canonical control plane for Principals -> Provider Accounts -> Connections -> Vault Backends -> Assets & Bindings.
-- Raw credentials NEVER live in D1; connections store non-secret vault:// URIs pointing to pluggable secret backends.

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT 'hub',
  topic TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'api',
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  result_json TEXT,
  error_message TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_owner_status ON tasks (owner_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS heartbeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pod_id TEXT NOT NULL,
  status TEXT NOT NULL,
  metrics_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS acc_vault_backends (
  tenant_id TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  driver TEXT NOT NULL,
  label TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  capabilities_json TEXT NOT NULL DEFAULT '["read"]',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, backend_id)
);

CREATE TABLE IF NOT EXISTS acc_principals (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, principal_id)
);

CREATE INDEX IF NOT EXISTS idx_acc_principals_email ON acc_principals (tenant_id, email);

CREATE TABLE IF NOT EXISTS acc_provider_accounts (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_account_id TEXT,
  owner_principal_id TEXT NOT NULL,
  label TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'prod',
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, account_id),
  FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES acc_principals (tenant_id, principal_id)
);

CREATE INDEX IF NOT EXISTS idx_acc_provider_accounts_provider ON acc_provider_accounts (tenant_id, provider);
CREATE INDEX IF NOT EXISTS idx_acc_provider_accounts_owner ON acc_provider_accounts (tenant_id, owner_principal_id);

CREATE TABLE IF NOT EXISTS acc_connections (
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  vault_backend_id TEXT NOT NULL,
  vault_uri TEXT NOT NULL,
  fallback_vault_uri TEXT,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  oauth_meta_json TEXT NOT NULL DEFAULT '{}',
  zero_spend_confirmed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unconfigured',
  last_verified_at INTEGER,
  last_error_class TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, connection_id),
  UNIQUE (tenant_id, account_id, connection_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES acc_provider_accounts (tenant_id, account_id),
  FOREIGN KEY (tenant_id, vault_backend_id) REFERENCES acc_vault_backends (tenant_id, backend_id)
);

CREATE INDEX IF NOT EXISTS idx_acc_connections_account ON acc_connections (tenant_id, account_id);
CREATE INDEX IF NOT EXISTS idx_acc_connections_backend ON acc_connections (tenant_id, vault_backend_id);

CREATE TABLE IF NOT EXISTS acc_assets (
  tenant_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_kind TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  brand_group TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_acc_assets_kind ON acc_assets (tenant_id, asset_kind);
CREATE INDEX IF NOT EXISTS idx_acc_assets_name ON acc_assets (tenant_id, canonical_name);

CREATE TABLE IF NOT EXISTS acc_asset_bindings (
  tenant_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT,
  provider TEXT NOT NULL,
  external_resource_id TEXT NOT NULL,
  role_or_permission TEXT NOT NULL DEFAULT 'member',
  is_canonical INTEGER NOT NULL DEFAULT 0,
  discovery_state TEXT NOT NULL DEFAULT 'manual',
  last_discovered_at INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, binding_id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES acc_assets (tenant_id, asset_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES acc_provider_accounts (tenant_id, account_id),
  FOREIGN KEY (tenant_id, account_id, connection_id) REFERENCES acc_connections (tenant_id, account_id, connection_id)
);

-- Enforce at most ONE canonical owner per (tenant, asset, provider) at the database level
CREATE UNIQUE INDEX IF NOT EXISTS idx_acc_bindings_canonical
  ON acc_asset_bindings (tenant_id, asset_id, provider)
  WHERE is_canonical = 1;

-- Natural key for idempotent discovery upserts
CREATE UNIQUE INDEX IF NOT EXISTS idx_acc_bindings_natural
  ON acc_asset_bindings (tenant_id, asset_id, provider, account_id, external_resource_id);

CREATE INDEX IF NOT EXISTS idx_acc_bindings_asset ON acc_asset_bindings (tenant_id, asset_id);
CREATE INDEX IF NOT EXISTS idx_acc_bindings_account ON acc_asset_bindings (tenant_id, account_id);
CREATE INDEX IF NOT EXISTS idx_acc_bindings_provider ON acc_asset_bindings (tenant_id, provider);

CREATE TABLE IF NOT EXISTS acc_audit_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_acc_audit_tenant_seq ON acc_audit_events (tenant_id, event_seq);
