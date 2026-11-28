import type { PodStorage } from "@futr-work/pod-kernel/storage";
import type {
  AssetBindingRecord,
  AssetKind,
  AssetRecord,
  AuditEventRecord,
  AuthType,
  ConnectionRecord,
  ConnectionStatus,
  DiscoveryState,
  EnrichedBindingView,
  PrincipalKind,
  PrincipalRecord,
  ProviderAccountRecord,
  VaultBackendRecord,
  VaultDriver,
  WhoOwnsResult,
} from "./types.js";
import {
  assertNoEmbeddedSecretPayload,
  FORBIDDEN_IDENTIFIER_KEYS,
  parseVaultUri,
} from "./vault/adapters.js";

export class ValidationError extends Error {
  public readonly code = "VALIDATION_ERROR";
}
export class ForbiddenError extends Error {
  public readonly code = "FORBIDDEN";
}
export class ConflictError extends Error {
  public readonly code = "CONFLICT";
}
export class NotFoundError extends Error {
  public readonly code = "NOT_FOUND";
}

const VALID_DRIVERS = new Set<VaultDriver>([
  "infisical",
  "onepassword_connect",
  "onepassword_cli",
  "lastpass",
  "bitwarden",
  "aws_sm",
  "gcp_sm",
  "cf_secret",
  "oauth_broker",
]);

// Strict non-secret configuration key allowlists per VaultDriver
const ALLOWED_DRIVER_CONFIG_KEYS: Record<VaultDriver, ReadonlySet<string>> = {
  infisical: new Set(["projectId", "env", "baseUrl", "secretPath"]),
  onepassword_connect: new Set(["connectUrl", "vault"]),
  onepassword_cli: new Set(["vault", "account"]),
  lastpass: new Set(["bridgeUrl", "folder"]),
  bitwarden: new Set(["bridgeUrl", "organizationId", "projectId"]),
  aws_sm: new Set(["region", "prefix"]),
  gcp_sm: new Set(["projectId", "location"]),
  cf_secret: new Set(["binding"]),
  oauth_broker: new Set(["backingBackendId", "authorizeEndpoint", "tokenEndpoint"]),
};

const VALID_PRINCIPAL_KINDS = new Set<PrincipalKind>(["human", "service_account", "oauth_app", "org"]);
const VALID_AUTH_TYPES = new Set<AuthType>([
  "oauth2_refresh",
  "oauth2_client_credentials",
  "gcp_service_account",
  "api_key",
  "bearer_token",
  "ssh_key",
  "github_app",
  "session",
]);
const VALID_CONNECTION_STATUSES = new Set<ConnectionStatus>(["healthy", "needs_auth", "expired", "revoked", "unconfigured"]);
const VALID_ASSET_KINDS = new Set<AssetKind>(["site", "domain", "repo", "worker", "database", "server", "project"]);
const VALID_DISCOVERY_STATES = new Set<DiscoveryState>(["verified", "missing_grant", "overlap_conflict", "stale", "manual"]);
const VALID_BACKEND_STATUSES = new Set(["active", "degraded", "disabled"]);
const VALID_LIFECYCLE_STATUSES = new Set(["active", "parked", "archived"]);
const ERROR_CLASS_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function assertStringNoSecret(val: string, field: string): void {
  try {
    assertNoEmbeddedSecretPayload(val, field);
  } catch (err: any) {
    throw new ValidationError(err?.message || `Field '${field}' contains forbidden secret material`);
  }
}

function requireSafeId(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value || trimmed.length > 160 || trimmed.includes("*") || /[\r\n\0]/.test(trimmed)) {
    throw new ValidationError(`${field} must be a canonical non-wildcard identifier`);
  }
  if (FORBIDDEN_IDENTIFIER_KEYS.has(trimmed)) {
    throw new ValidationError(`${field} uses a forbidden identifier`);
  }
  assertStringNoSecret(trimmed, field);
  return trimmed;
}

function requireNonEmptyText(value: unknown, field: string, maxLen = 256): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLen) {
    throw new ValidationError(`${field} exceeds maximum length of ${maxLen}`);
  }
  assertStringNoSecret(trimmed, field);
  return trimmed;
}

function requireSafeObject(value: unknown, field: string, allowedKeys?: ReadonlySet<string>): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${field} must be a JSON object`);
  }
  try {
    assertNoEmbeddedSecretPayload(value, field);
  } catch (err: any) {
    throw new ValidationError(err?.message || `Invalid ${field}`);
  }
  if (allowedKeys) {
    for (const k of Object.keys(value as Record<string, unknown>)) {
      if (!allowedKeys.has(k)) {
        throw new ValidationError(`${field} contains unsupported configuration key '${k}'`);
      }
      const v = (value as Record<string, unknown>)[k];
      if (typeof v !== "string" || !v.trim()) {
        throw new ValidationError(`${field}.${k} must be a non-empty string`);
      }
    }
  }
  return value as Record<string, unknown>;
}

function requireSafeStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} must be an array of strings`);
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    if (typeof v !== "string" || !v.trim() || v.includes("*")) {
      throw new ValidationError(`${field}[${i}] must be a non-empty non-wildcard string`);
    }
    assertStringNoSecret(v, `${field}[${i}]`);
    out.push(v.trim());
  }
  return out;
}

function parseJsonObjectSafe(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArraySafe(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function deterministicBindingId(assetId: string, provider: string, accountId: string, externalResourceId: string): string {
  const input = `${assetId}|${provider}|${accountId}|${externalResourceId}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return `bind_${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

function mapVaultBackend(row: any): VaultBackendRecord {
  return {
    tenantId: String(row.tenant_id),
    backendId: String(row.backend_id),
    driver: row.driver as VaultDriver,
    label: String(row.label),
    config: parseJsonObjectSafe(row.config_json),
    capabilities: parseJsonArraySafe(row.capabilities_json),
    status: row.status as "active" | "degraded" | "disabled",
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapPrincipal(row: any): PrincipalRecord {
  return {
    tenantId: String(row.tenant_id),
    principalId: String(row.principal_id),
    kind: row.kind as PrincipalKind,
    displayName: String(row.display_name),
    email: row.email ? String(row.email) : null,
    status: row.status as "active" | "disabled",
    metadata: parseJsonObjectSafe(row.metadata_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapProviderAccount(row: any): ProviderAccountRecord {
  return {
    tenantId: String(row.tenant_id),
    accountId: String(row.account_id),
    provider: String(row.provider),
    externalAccountId: row.external_account_id ? String(row.external_account_id) : null,
    ownerPrincipalId: String(row.owner_principal_id),
    label: String(row.label),
    environment: String(row.environment),
    status: row.status as "active" | "disabled",
    metadata: parseJsonObjectSafe(row.metadata_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapConnection(row: any): ConnectionRecord {
  return {
    tenantId: String(row.tenant_id),
    connectionId: String(row.connection_id),
    accountId: String(row.account_id),
    authType: row.auth_type as AuthType,
    vaultBackendId: String(row.vault_backend_id),
    vaultUri: String(row.vault_uri),
    fallbackVaultUri: row.fallback_vault_uri ? String(row.fallback_vault_uri) : null,
    scopes: parseJsonArraySafe(row.scopes_json),
    oauthMeta: parseJsonObjectSafe(row.oauth_meta_json),
    zeroSpendConfirmed: Number(row.zero_spend_confirmed) === 1,
    status: row.status as ConnectionStatus,
    lastVerifiedAt: row.last_verified_at !== null && row.last_verified_at !== undefined ? Number(row.last_verified_at) : null,
    lastErrorClass: row.last_error_class ? String(row.last_error_class) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapAsset(row: any): AssetRecord {
  return {
    tenantId: String(row.tenant_id),
    assetId: String(row.asset_id),
    assetKind: row.asset_kind as AssetKind,
    canonicalName: String(row.canonical_name),
    brandGroup: row.brand_group ? String(row.brand_group) : null,
    lifecycleStatus: row.lifecycle_status as "active" | "parked" | "archived",
    metadata: parseJsonObjectSafe(row.metadata_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapBinding(row: any): AssetBindingRecord {
  return {
    tenantId: String(row.tenant_id),
    bindingId: String(row.binding_id),
    assetId: String(row.asset_id),
    accountId: String(row.account_id),
    connectionId: row.connection_id ? String(row.connection_id) : null,
    provider: String(row.provider),
    externalResourceId: String(row.external_resource_id),
    roleOrPermission: String(row.role_or_permission),
    isCanonical: Number(row.is_canonical) === 1,
    discoveryState: row.discovery_state as DiscoveryState,
    lastDiscoveredAt: row.last_discovered_at !== null && row.last_discovered_at !== undefined ? Number(row.last_discovered_at) : null,
    metadata: parseJsonObjectSafe(row.metadata_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapEnrichedBinding(row: any): EnrichedBindingView {
  return {
    ...mapBinding(row),
    accountLabel: String(row.account_label || ""),
    ownerPrincipalId: String(row.owner_principal_id || ""),
    ownerEmail: row.owner_email ? String(row.owner_email) : null,
    vaultBackendId: row.vault_backend_id ? String(row.vault_backend_id) : null,
    vaultDriver: row.vault_driver ? (row.vault_driver as VaultDriver) : null,
    vaultUri: row.vault_uri ? String(row.vault_uri) : null,
    fallbackVaultUri: row.fallback_vault_uri ? String(row.fallback_vault_uri) : null,
    connectionStatus: row.connection_status ? (row.connection_status as ConnectionStatus) : null,
  };
}

export async function ensureAccountsSchemaReady(db: PodStorage): Promise<void> {
  await db.prepare("SELECT 1 FROM acc_vault_backends LIMIT 1").first().catch(() => null);
}

export class AccountsService {
  constructor(private readonly db: PodStorage) {}

  private async recordAudit(
    tenantId: string,
    entityType: string,
    entityId: string,
    action: string,
    actorId: string,
    summary: string,
    now: number
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO acc_audit_events (tenant_id, entity_type, entity_id, action, actor_id, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(tenantId, entityType, entityId, action, actorId, summary.slice(0, 256), now)
      .run();
  }

  public async upsertVaultBackend(
    input: {
      tenantId: string;
      backendId: string;
      driver: VaultDriver;
      label: string;
      config?: Record<string, unknown>;
      capabilities?: string[];
      status?: "active" | "degraded" | "disabled";
    },
    actorId: string,
    now = Date.now()
  ): Promise<VaultBackendRecord> {
    const tenantId = requireSafeId(input.tenantId, "tenantId");
    const backendId = requireSafeId(input.backendId, "backendId");
    if (typeof input.driver !== "string" || !VALID_DRIVERS.has(input.driver)) {
      throw new ValidationError("Unsupported vault driver");
    }
    const label = requireNonEmptyText(input.label, "label");
    const config = requireSafeObject(input.config, "config", ALLOWED_DRIVER_CONFIG_KEYS[input.driver]);
    const capabilities = input.capabilities ? requireSafeStringArray(input.capabilities, "capabilities") : ["read"];
    const status = input.status ?? "active";
    if (typeof status !== "string" || !VALID_BACKEND_STATUSES.has(status)) {
      throw new ValidationError("Invalid vault backend status");
    }

    await this.db
      .prepare(
        `INSERT INTO acc_vault_backends (tenant_id, backend_id, driver, label, config_json, capabilities_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, backend_id) DO UPDATE SET
           driver = excluded.driver,
           label = excluded.label,
           config_json = excluded.config_json,
           capabilities_json = excluded.capabilities_json,
           status = excluded.status,
           updated_at = excluded.updated_at`
      )
      .bind(tenantId, backendId, input.driver, label, JSON.stringify(config), JSON.stringify(capabilities), status, now, now)
      .run();

    await this.recordAudit(tenantId, "vault_backend", backendId, "upsert", actorId, `Vault backend '${backendId}' (${input.driver})`, now);
    const row = await this.db
      .prepare("SELECT * FROM acc_vault_backends WHERE tenant_id = ? AND backend_id = ?")
      .bind(tenantId, backendId)
      .first<any>();
    return mapVaultBackend(row);
  }

  public async listVaultBackends(tenantIdRaw: string): Promise<VaultBackendRecord[]> {
    const tenantId = requireSafeId(tenantIdRaw, "tenantId");
    const res = await this.db
      .prepare("SELECT * FROM acc_vault_backends WHERE tenant_id = ? ORDER BY backend_id ASC")
      .bind(tenantId)
      .all<any>();
    return (res.results || []).map(mapVaultBackend);
  }

  public async upsertPrincipal(
    input: {
      tenantId: string;
      principalId: string;
      kind: PrincipalKind;
      displayName: string;
      email?: string | null;
      status?: "active" | "disabled";
      metadata?: Record<string, unknown>;
    },
    actorId: string,
    now = Date.now()
  ): Promise<PrincipalRecord> {
    const tenantId = requireSafeId(input.tenantId, "tenantId");
    const principalId = requireSafeId(input.principalId, "principalId");
    if (typeof input.kind !== "string" || !VALID_PRINCIPAL_KINDS.has(input.kind)) {
      throw new ValidationError("Invalid principal kind");
    }
    const displayName = requireNonEmptyText(input.displayName, "displayName");
    const email = input.email ? requireNonEmptyText(input.email, "email").toLowerCase() : null;
    const status = input.status ?? "active";
    if (status !== "active" && status !== "disabled") {
      throw new ValidationError("Invalid principal status");
    }
    const metadata = requireSafeObject(input.metadata, "metadata");

    await this.db
      .prepare(
        `INSERT INTO acc_principals (tenant_id, principal_id, kind, display_name, email, status, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, principal_id) DO UPDATE SET
           kind = excluded.kind,
           display_name = excluded.display_name,
           email = excluded.email,
           status = excluded.status,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`
      )
      .bind(tenantId, principalId, input.kind, displayName, email, status, JSON.stringify(metadata), now, now)
      .run();

    await this.recordAudit(tenantId, "principal", principalId, "upsert", actorId, `Principal '${principalId}' (${input.kind})`, now);
    const row = await this.db
      .prepare("SELECT * FROM acc_principals WHERE tenant_id = ? AND principal_id = ?")
      .bind(tenantId, principalId)
      .first<any>();
    return mapPrincipal(row);
  }

  public async listPrincipals(tenantIdRaw: string): Promise<PrincipalRecord[]> {
    const tenantId = requireSafeId(tenantIdRaw, "tenantId");
    const res = await this.db
      .prepare("SELECT * FROM acc_principals WHERE tenant_id = ? ORDER BY principal_id ASC")
      .bind(tenantId)
      .all<any>();
    return (res.results || []).map(mapPrincipal);
  }

  public async upsertProviderAccount(
    input: {
      tenantId: string;
      accountId: string;
      provider: string;
      externalAccountId?: string | null;
      ownerPrincipalId: string;
      label: string;
      environment?: string;
      status?: "active" | "disabled";
      metadata?: Record<string, unknown>;
    },
    actorId: string,
    now = Date.now()
  ): Promise<ProviderAccountRecord> {
    const tenantId = requireSafeId(input.tenantId, "tenantId");
    const accountId = requireSafeId(input.accountId, "accountId");
    const provider = requireSafeId(input.provider, "provider").toLowerCase();
    const ownerPrincipalId = requireSafeId(input.ownerPrincipalId, "ownerPrincipalId");
    const label = requireNonEmptyText(input.label, "label");
    const externalAccountId = input.externalAccountId ? requireNonEmptyText(input.externalAccountId, "externalAccountId") : null;
    const environment = input.environment ? requireSafeId(input.environment, "environment") : "prod";
    const status = input.status ?? "active";
    if (status !== "active" && status !== "disabled") {
      throw new ValidationError("Invalid provider account status");
    }
    const metadata = requireSafeObject(input.metadata, "metadata");

    const owner = await this.db
      .prepare("SELECT principal_id FROM acc_principals WHERE tenant_id = ? AND principal_id = ?")
      .bind(tenantId, ownerPrincipalId)
      .first<any>();
    if (!owner) {
      throw new NotFoundError("Owner principal not found in tenant");
    }

    await this.db
      .prepare(
        `INSERT INTO acc_provider_accounts (
           tenant_id, account_id, provider, external_account_id, owner_principal_id,
           label, environment, status, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, account_id) DO UPDATE SET
           provider = excluded.provider,
           external_account_id = excluded.external_account_id,
           owner_principal_id = excluded.owner_principal_id,
           label = excluded.label,
           environment = excluded.environment,
           status = excluded.status,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`
      )
      .bind(tenantId, accountId, provider, externalAccountId, ownerPrincipalId, label, environment, status, JSON.stringify(metadata), now, now)
      .run();

    await this.recordAudit(tenantId, "provider_account", accountId, "upsert", actorId, `Account '${accountId}' (${provider})`, now);
    const row = await this.db
      .prepare("SELECT * FROM acc_provider_accounts WHERE tenant_id = ? AND account_id = ?")
      .bind(tenantId, accountId)
      .first<any>();
    return mapProviderAccount(row);
  }

  public async listProviderAccounts(tenantIdRaw: string, providerFilter?: string): Promise<ProviderAccountRecord[]> {
    const tenantId = requireSafeId(tenantIdRaw, "tenantId");
    if (providerFilter) {
      const provider = requireSafeId(providerFilter, "provider").toLowerCase();
      const res = await this.db
        .prepare("SELECT * FROM acc_provider_accounts WHERE tenant_id = ? AND provider = ? ORDER BY account_id ASC")
        .bind(tenantId, provider)
        .all<any>();
      return (res.results || []).map(mapProviderAccount);
    }
    const res = await this.db
      .prepare("SELECT * FROM acc_provider_accounts WHERE tenant_id = ? ORDER BY provider ASC, account_id ASC")
      .bind(tenantId)
      .all<any>();
    return (res.results || []).map(mapProviderAccount);
  }

  public async upsertConnection(
    input: {
      tenantId: string;
      connectionId: string;
      accountId: string;
      authType: AuthType;
      vaultBackendId: string;
      vaultUri: string;
      fallbackVaultUri?: string | null;
      scopes?: string[];
      oauthMeta?: Record<string, unknown>;
      zeroSpendConfirmed?: boolean;
      status?: ConnectionStatus;
      lastVerifiedAt?: number | null;
      lastErrorClass?: string | null;
    },
    actorId: string,
    now = Date.now()
  ): Promise<ConnectionRecord> {
    const tenantId = requireSafeId(input.tenantId, "tenantId");
    const connectionId = requireSafeId(input.connectionId, "connectionId");
    const accountId = requireSafeId(input.accountId, "accountId");
    if (typeof input.authType !== "string" || !VALID_AUTH_TYPES.has(input.authType)) {
      throw new ValidationError("Unsupported authType");
    }
    const vaultBackendId = requireSafeId(input.vaultBackendId, "vaultBackendId");

    let parsedUri;
    try {
      parsedUri = parseVaultUri(input.vaultUri);
    } catch (err: any) {
      throw new ValidationError(err?.message || "Invalid vaultUri");
    }
    if (parsedUri.backendId !== vaultBackendId) {
      throw new ValidationError("vaultUri backend must match vaultBackendId");
    }

    let fallbackUri: string | null = null;
    if (input.fallbackVaultUri !== undefined && input.fallbackVaultUri !== null && input.fallbackVaultUri !== "") {
      let parsedFb;
      try {
        parsedFb = parseVaultUri(input.fallbackVaultUri);
      } catch (err: any) {
        throw new ValidationError(err?.message || "Invalid fallbackVaultUri");
      }
      const fbBackend = await this.db
        .prepare("SELECT backend_id FROM acc_vault_backends WHERE tenant_id = ? AND backend_id = ?")
        .bind(tenantId, parsedFb.backendId)
        .first<any>();
      if (!fbBackend) {
        throw new NotFoundError("Fallback vault backend not found in tenant");
      }
      fallbackUri = parsedFb.raw;
    }

    const scopes = requireSafeStringArray(input.scopes, "scopes");
    const oauthMeta = requireSafeObject(input.oauthMeta, "oauthMeta");
    const zeroSpendConfirmed = input.zeroSpendConfirmed ?? false;
    if (typeof zeroSpendConfirmed !== "boolean") {
      throw new ValidationError("zeroSpendConfirmed must be a boolean");
    }
    const status = input.status ?? "unconfigured";
    if (typeof status !== "string" || !VALID_CONNECTION_STATUSES.has(status)) {
      throw new ValidationError("Invalid connection status");
    }
    let lastErrorClass: string | null = null;
    if (input.lastErrorClass !== undefined && input.lastErrorClass !== null && input.lastErrorClass !== "") {
      if (typeof input.lastErrorClass !== "string" || !ERROR_CLASS_RE.test(input.lastErrorClass)) {
        throw new ValidationError("lastErrorClass must match ^[A-Za-z0-9_.:-]{1,64}$");
      }
      lastErrorClass = input.lastErrorClass;
    }

    const acct = await this.db
      .prepare("SELECT account_id FROM acc_provider_accounts WHERE tenant_id = ? AND account_id = ?")
      .bind(tenantId, accountId)
      .first<any>();
    if (!acct) {
      throw new NotFoundError("Provider account not found in tenant");
    }
    const backend = await this.db
      .prepare("SELECT backend_id FROM acc_vault_backends WHERE tenant_id = ? AND backend_id = ?")
      .bind(tenantId, vaultBackendId)
      .first<any>();
    if (!backend) {
      throw new NotFoundError("Vault backend not found in tenant");
    }

    // Reject reparenting an existing connection while any asset binding references it!
    const existingConn = await this.db
      .prepare("SELECT account_id FROM acc_connections WHERE tenant_id = ? AND connection_id = ?")
      .bind(tenantId, connectionId)
      .first<any>();
    if (existingConn && String(existingConn.account_id) !== accountId) {
      const refCountRow = await this.db
        .prepare("SELECT COUNT(*) AS c FROM acc_asset_bindings WHERE tenant_id = ? AND connection_id = ?")
        .bind(tenantId, connectionId)
        .first<any>();
      if (Number(refCountRow?.c || 0) > 0) {
        throw new ConflictError("Cannot reparent connection to another account while asset bindings reference it");
      }
    }

    await this.db
      .prepare(
        `INSERT INTO acc_connections (
           tenant_id, connection_id, account_id, auth_type, vault_backend_id, vault_uri,
           fallback_vault_uri, scopes_json, oauth_meta_json, zero_spend_confirmed,
           status, last_verified_at, last_error_class, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, connection_id) DO UPDATE SET
           account_id = excluded.account_id,
           auth_type = excluded.auth_type,
           vault_backend_id = excluded.vault_backend_id,
           vault_uri = excluded.vault_uri,
           fallback_vault_uri = excluded.fallback_vault_uri,
           scopes_json = excluded.scopes_json,
           oauth_meta_json = excluded.oauth_meta_json,
           zero_spend_confirmed = excluded.zero_spend_confirmed,
           status = excluded.status,
           last_verified_at = excluded.last_verified_at,
           last_error_class = excluded.last_error_class,
           updated_at = excluded.updated_at`
      )
      .bind(
        tenantId,
        connectionId,
        accountId,
        input.authType,
        vaultBackendId,
        parsedUri.raw,
        fallbackUri,
        JSON.stringify(scopes),
        JSON.stringify(oauthMeta),
        zeroSpendConfirmed ? 1 : 0,
        status,
        input.lastVerifiedAt ?? null,
        lastErrorClass,
        now,
        now
      )
      .run();

    await this.recordAudit(tenantId, "connection", connectionId, "upsert", actorId, `Connection '${connectionId}' -> ${vaultBackendId}`, now);
    const row = await this.db
      .prepare("SELECT * FROM acc_connections WHERE tenant_id = ? AND connection_id = ?")
      .bind(tenantId, connectionId)
      .first<any>();
    return mapConnection(row);
  }

  public async switchConnectionVault(
    input: {
      tenantId: string;
      connectionId: string;
      vaultBackendId: string;
      vaultUri: string;
      fallbackVaultUri?: string | null;
    },
    actorId: string,
    now = Date.now()
  ): Promise<ConnectionRecord> {
    const tenantId = requireSafeId(input.tenantId, "tenantId");
    const connectionId = requireSafeId(input.connectionId, "connectionId");
    const vaultBackendId = requireSafeId(input.vaultBackendId, "vaultBackendId");

    const existing = await this.db
      .prepare("SELECT * FROM acc_connections WHERE tenant_id = ? AND connection_id = ?")
      .bind(tenantId, connectionId)
      .first<any>();
    if (!existing) {
      throw new NotFoundError("Connection not found in tenant");
    }

    let parsedUri;
    try {
      parsedUri = parseVaultUri(input.vaultUri);
    } catch (err: any) {
      throw new ValidationError(err?.message || "Invalid vaultUri");
    }
    if (parsedUri.backendId !== vaultBackendId) {
      throw new ValidationError("vaultUri backend must match vaultBackendId");
    }

    const backend = await this.db
      .prepare("SELECT backend_id, driver FROM acc_vault_backends WHERE tenant_id = ? AND backend_id = ?")
      .bind(tenantId, vaultBackendId)
      .first<any>();
    if (!backend) {
      throw new NotFoundError("Vault backend not found in tenant");
    }

    let fallbackUri: string | null = existing.fallback_vault_uri ? String(existing.fallback_vault_uri) : null;
    if (input.fallbackVaultUri !== undefined) {
      if (input.fallbackVaultUri === null || input.fallbackVaultUri === "") {
        fallbackUri = null;
      } else {
        let parsedFb;
        try {
          parsedFb = parseVaultUri(input.fallbackVaultUri);
        } catch (err: any) {
          throw new ValidationError(err?.message || "Invalid fallbackVaultUri");
        }
        const fbBackend = await this.db
          .prepare("SELECT backend_id FROM acc_vault_backends WHERE tenant_id = ? AND backend_id = ?")
          .bind(tenantId, parsedFb.backendId)
          .first<any>();
        if (!fbBackend) {
          throw new NotFoundError("Fallback vault backend not found in tenant");
        }
        fallbackUri = parsedFb.raw;
      }
    }

    await this.db
      .prepare(
        `UPDATE acc_connections
         SET vault_backend_id = ?, vault_uri = ?, fallback_vault_uri = ?, updated_at = ?
         WHERE tenant_id = ? AND connection_id = ?`
      )
      .bind(vaultBackendId, parsedUri.raw, fallbackUri, now, tenantId, connectionId)
      .run();

    await this.recordAudit(
      tenantId,
      "connection",
      connectionId,
      "switch_vault",
      actorId,
      `Switched vault from '${existing.vault_backend_id}' to '${vaultBackendId}' (${backend.driver})`,
      now
    );

    const updated = await this.db
      .prepare("SELECT * FROM acc_connections WHERE tenant_id = ? AND connection_id = ?")
      .bind(tenantId, connectionId)
      .first<any>();
    return mapConnection(updated);
  }

  public async listConnections(tenantIdRaw: string, accountIdFilter?: string): Promise<ConnectionRecord[]> {
    const tenantId = requireSafeId(tenantIdRaw, "tenantId");
    if (accountIdFilter) {
      const accountId = requireSafeId(accountIdFilter, "accountId");
      const res = await this.db
        .prepare("SELECT * FROM acc_connections WHERE tenant_id = ? AND account_id = ? ORDER BY connection_id ASC")
        .bind(tenantId, accountId)
        .all<any>();
      return (res.results || []).map(mapConnection);
    }
    const res = await this.db
      .prepare("SELECT * FROM acc_connections WHERE tenant_id = ? ORDER BY connection_id ASC")
      .bind(tenantId)
      .all<any>();
    return (res.results || []).map(mapConnection);
  }

  public async upsertAsset(
    input: {
      tenantId: string;
      assetId: string;
      assetKind: AssetKind;
      canonicalName: string;
      brandGroup?: string | null;
      lifecycleStatus?: "active" | "parked" | "archived";
      metadata?: Record<string, unknown>;
    },
    actorId: string,
    now = Date.now()
  ): Promise<AssetRecord> {
    const tenantId = requireSafeId(input.tenantId, "tenantId");
    const assetId = requireSafeId(input.assetId, "assetId");
    if (typeof input.assetKind !== "string" || !VALID_ASSET_KINDS.has(input.assetKind)) {
      throw new ValidationError("Invalid assetKind");
    }
    const canonicalName = requireNonEmptyText(input.canonicalName, "canonicalName").toLowerCase();
    const brandGroup = input.brandGroup ? requireNonEmptyText(input.brandGroup, "brandGroup") : null;
    const lifecycleStatus = input.lifecycleStatus ?? "active";
    if (typeof lifecycleStatus !== "string" || !VALID_LIFECYCLE_STATUSES.has(lifecycleStatus)) {
      throw new ValidationError("Invalid lifecycleStatus");
    }
    const metadata = requireSafeObject(input.metadata, "metadata");

    await this.db
      .prepare(
        `INSERT INTO acc_assets (tenant_id, asset_id, asset_kind, canonical_name, brand_group, lifecycle_status, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, asset_id) DO UPDATE SET
           asset_kind = excluded.asset_kind,
           canonical_name = excluded.canonical_name,
           brand_group = excluded.brand_group,
           lifecycle_status = excluded.lifecycle_status,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`
      )
      .bind(tenantId, assetId, input.assetKind, canonicalName, brandGroup, lifecycleStatus, JSON.stringify(metadata), now, now)
      .run();

    await this.recordAudit(tenantId, "asset", assetId, "upsert", actorId, `Asset '${assetId}' (${input.assetKind})`, now);
    const row = await this.db
      .prepare("SELECT * FROM acc_assets WHERE tenant_id = ? AND asset_id = ?")
      .bind(tenantId, assetId)
      .first<any>();
    return mapAsset(row);
  }

  public async listAssets(tenantIdRaw: string, assetKindFilter?: AssetKind): Promise<AssetRecord[]> {
    const tenantId = requireSafeId(tenantIdRaw, "tenantId");
    if (assetKindFilter) {
      if (typeof assetKindFilter !== "string" || !VALID_ASSET_KINDS.has(assetKindFilter)) {
        throw new ValidationError("Invalid assetKind");
      }
      const res = await this.db
        .prepare("SELECT * FROM acc_assets WHERE tenant_id = ? AND asset_kind = ? ORDER BY asset_id ASC")
        .bind(tenantId, assetKindFilter)
        .all<any>();
      return (res.results || []).map(mapAsset);
    }
    const res = await this.db
      .prepare("SELECT * FROM acc_assets WHERE tenant_id = ? ORDER BY asset_id ASC")
      .bind(tenantId)
      .all<any>();
    return (res.results || []).map(mapAsset);
  }

  public async upsertBinding(
    input: {
      tenantId: string;
      bindingId?: string;
      assetId: string;
      accountId: string;
      connectionId?: string | null;
      provider: string;
      externalResourceId: string;
      roleOrPermission?: string;
      isCanonical?: boolean;
      discoveryState?: DiscoveryState;
      lastDiscoveredAt?: number | null;
      metadata?: Record<string, unknown>;
    },
    actorId: string,
    now = Date.now()
  ): Promise<AssetBindingRecord> {
    const tenantId = requireSafeId(input.tenantId, "tenantId");
    const assetId = requireSafeId(input.assetId, "assetId");
    const accountId = requireSafeId(input.accountId, "accountId");
    const provider = requireSafeId(input.provider, "provider").toLowerCase();
    const externalResourceId = requireNonEmptyText(input.externalResourceId, "externalResourceId");
    if (externalResourceId.includes("*")) {
      throw new ValidationError("externalResourceId must not contain wildcards");
    }
    const roleOrPermission = input.roleOrPermission ? requireNonEmptyText(input.roleOrPermission, "roleOrPermission") : "member";
    const isCanonical = input.isCanonical ?? false;
    if (typeof isCanonical !== "boolean") {
      throw new ValidationError("isCanonical must be a boolean");
    }
    const discoveryState = input.discoveryState ?? "manual";
    if (typeof discoveryState !== "string" || !VALID_DISCOVERY_STATES.has(discoveryState)) {
      throw new ValidationError("Invalid discoveryState");
    }
    const metadata = requireSafeObject(input.metadata, "metadata");

    const asset = await this.db
      .prepare("SELECT asset_id FROM acc_assets WHERE tenant_id = ? AND asset_id = ?")
      .bind(tenantId, assetId)
      .first<any>();
    if (!asset) {
      throw new NotFoundError("Asset not found in tenant");
    }
    const account = await this.db
      .prepare("SELECT account_id, provider FROM acc_provider_accounts WHERE tenant_id = ? AND account_id = ?")
      .bind(tenantId, accountId)
      .first<any>();
    if (!account) {
      throw new NotFoundError("Provider account not found in tenant");
    }
    if (String(account.provider) !== provider) {
      throw new ValidationError("Account provider does not match binding provider");
    }

    let connectionId: string | null = null;
    if (input.connectionId) {
      connectionId = requireSafeId(input.connectionId, "connectionId");
      const conn = await this.db
        .prepare("SELECT connection_id, account_id FROM acc_connections WHERE tenant_id = ? AND connection_id = ?")
        .bind(tenantId, connectionId)
        .first<any>();
      if (!conn) {
        throw new NotFoundError("Connection not found in tenant");
      }
      if (String(conn.account_id) !== accountId) {
        throw new ValidationError("Connection does not belong to specified provider account");
      }
    }

    const naturalExisting = await this.db
      .prepare(
        `SELECT binding_id FROM acc_asset_bindings
         WHERE tenant_id = ? AND asset_id = ? AND provider = ? AND account_id = ? AND external_resource_id = ?`
      )
      .bind(tenantId, assetId, provider, accountId, externalResourceId)
      .first<any>();

    const bindingId = input.bindingId
      ? requireSafeId(input.bindingId, "bindingId")
      : naturalExisting
        ? String(naturalExisting.binding_id)
        : deterministicBindingId(assetId, provider, accountId, externalResourceId);

    const stmts = [];
    if (isCanonical) {
      stmts.push(
        this.db
          .prepare(
            `UPDATE acc_asset_bindings SET is_canonical = 0, updated_at = ?
             WHERE tenant_id = ? AND asset_id = ? AND provider = ? AND binding_id <> ? AND is_canonical = 1`
          )
          .bind(now, tenantId, assetId, provider, bindingId)
      );
    }
    stmts.push(
      this.db
        .prepare(
          `INSERT INTO acc_asset_bindings (
             tenant_id, binding_id, asset_id, account_id, connection_id, provider,
             external_resource_id, role_or_permission, is_canonical, discovery_state,
             last_discovered_at, metadata_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tenant_id, asset_id, provider, account_id, external_resource_id) DO UPDATE SET
             connection_id = excluded.connection_id,
             role_or_permission = excluded.role_or_permission,
             is_canonical = excluded.is_canonical,
             discovery_state = excluded.discovery_state,
             last_discovered_at = COALESCE(excluded.last_discovered_at, acc_asset_bindings.last_discovered_at),
             metadata_json = excluded.metadata_json,
             updated_at = excluded.updated_at`
        )
        .bind(
          tenantId,
          bindingId,
          assetId,
          accountId,
          connectionId,
          provider,
          externalResourceId,
          roleOrPermission,
          isCanonical ? 1 : 0,
          discoveryState,
          input.lastDiscoveredAt ?? null,
          JSON.stringify(metadata),
          now,
          now
        )
    );

    await this.db.batch(stmts);
    await this.recordAudit(
      tenantId,
      "asset_binding",
      bindingId,
      isCanonical ? "upsert_canonical" : "upsert",
      actorId,
      `Binding ${assetId} <-> ${accountId} (${provider}, canonical=${isCanonical})`,
      now
    );

    const row = await this.db
      .prepare(
        `SELECT * FROM acc_asset_bindings
         WHERE tenant_id = ? AND asset_id = ? AND provider = ? AND account_id = ? AND external_resource_id = ?`
      )
      .bind(tenantId, assetId, provider, accountId, externalResourceId)
      .first<any>();
    return mapBinding(row);
  }

  public async setCanonicalBinding(
    tenantIdRaw: string,
    bindingIdRaw: string,
    actorId: string,
    now = Date.now()
  ): Promise<AssetBindingRecord> {
    const tenantId = requireSafeId(tenantIdRaw, "tenantId");
    const bindingId = requireSafeId(bindingIdRaw, "bindingId");
    const target = await this.db
      .prepare("SELECT * FROM acc_asset_bindings WHERE tenant_id = ? AND binding_id = ?")
      .bind(tenantId, bindingId)
      .first<any>();
    if (!target) {
      throw new NotFoundError("Binding not found in tenant");
    }

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE acc_asset_bindings SET is_canonical = 0, updated_at = ?
           WHERE tenant_id = ? AND asset_id = ? AND provider = ? AND is_canonical = 1`
        )
        .bind(now, tenantId, target.asset_id, target.provider),
      this.db
        .prepare(
          `UPDATE acc_asset_bindings SET is_canonical = 1, discovery_state = CASE WHEN discovery_state = 'overlap_conflict' THEN 'verified' ELSE discovery_state END, updated_at = ?
           WHERE tenant_id = ? AND binding_id = ?`
        )
        .bind(now, tenantId, bindingId),
    ]);

    await this.recordAudit(
      tenantId,
      "asset_binding",
      bindingId,
      "set_canonical",
      actorId,
      `Set canonical ${target.provider} owner of ${target.asset_id} -> ${target.account_id}`,
      now
    );
    const updated = await this.db
      .prepare("SELECT * FROM acc_asset_bindings WHERE tenant_id = ? AND binding_id = ?")
      .bind(tenantId, bindingId)
      .first<any>();
    return mapBinding(updated);
  }

  /**
   * Concurrency-safe discovery ingestion:
   * - Evaluates canonical ownership atomically INSIDE the SQLite INSERT statement (never demotes an existing owner!).
   * - If two accounts discover the same (asset, provider) concurrently, only the first writer obtains is_canonical=1;
   *   the second atomically lands as is_canonical=0, discovery_state='overlap_conflict'.
   */
  public async ingestDiscovery(
    input: {
      tenantId: string;
      accountId: string;
      connectionId?: string | null;
      autoCreateAssets?: boolean;
      items: Array<{
        assetId: string;
        assetKind?: AssetKind;
        canonicalName: string;
        brandGroup?: string | null;
        externalResourceId: string;
        roleOrPermission?: string;
        metadata?: Record<string, unknown>;
      }>;
    },
    actorId: string,
    now = Date.now()
  ): Promise<{
    accountId: string;
    provider: string;
    processed: number;
    createdAssets: number;
    canonicalAssigned: number;
    overlapsFlagged: number;
    bindings: AssetBindingRecord[];
  }> {
    const tenantId = requireSafeId(input.tenantId, "tenantId");
    const accountId = requireSafeId(input.accountId, "accountId");
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new ValidationError("Discovery items must be a non-empty array");
    }
    if (input.items.length > 500) {
      throw new ValidationError("Discovery batch cannot exceed 500 items per call");
    }
    const account = await this.db
      .prepare("SELECT * FROM acc_provider_accounts WHERE tenant_id = ? AND account_id = ?")
      .bind(tenantId, accountId)
      .first<any>();
    if (!account) {
      throw new NotFoundError("Provider account not found in tenant");
    }
    const provider = String(account.provider);
    let connectionId: string | null = null;
    if (input.connectionId) {
      connectionId = requireSafeId(input.connectionId, "connectionId");
      const conn = await this.db
        .prepare("SELECT connection_id, account_id FROM acc_connections WHERE tenant_id = ? AND connection_id = ?")
        .bind(tenantId, connectionId)
        .first<any>();
      if (!conn) {
        throw new NotFoundError("Connection not found in tenant");
      }
      if (String(conn.account_id) !== accountId) {
        throw new ValidationError("Connection does not belong to specified provider account");
      }
    }

    const autoCreate = input.autoCreateAssets !== false;
    let createdAssets = 0;
    let canonicalAssigned = 0;
    let overlapsFlagged = 0;
    const bindings: AssetBindingRecord[] = [];

    for (const item of input.items) {
      const assetId = requireSafeId(item.assetId, "item.assetId");
      const canonicalName = requireNonEmptyText(item.canonicalName, "item.canonicalName").toLowerCase();
      const assetKind = item.assetKind ?? "site";
      if (typeof assetKind !== "string" || !VALID_ASSET_KINDS.has(assetKind)) {
        throw new ValidationError("Invalid item.assetKind");
      }
      const brandGroup = item.brandGroup ? requireNonEmptyText(item.brandGroup, "item.brandGroup") : null;
      const externalResourceId = requireNonEmptyText(item.externalResourceId, "item.externalResourceId");
      if (externalResourceId.includes("*")) {
        throw new ValidationError("item.externalResourceId must not contain wildcards");
      }
      const roleOrPermission = item.roleOrPermission ? requireNonEmptyText(item.roleOrPermission, "item.roleOrPermission") : "verified";
      const metadata = requireSafeObject(item.metadata, "item.metadata");

      if (autoCreate) {
        const assetInsert = await this.db
          .prepare(
            `INSERT OR IGNORE INTO acc_assets (
               tenant_id, asset_id, asset_kind, canonical_name, brand_group, lifecycle_status, metadata_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 'active', '{}', ?, ?)`
          )
          .bind(tenantId, assetId, assetKind, canonicalName, brandGroup, now, now)
          .run();
        if (Number(assetInsert.meta?.changes || 0) > 0) {
          createdAssets += 1;
        }
      } else {
        const existingAsset = await this.db
          .prepare("SELECT asset_id FROM acc_assets WHERE tenant_id = ? AND asset_id = ?")
          .bind(tenantId, assetId)
          .first<any>();
        if (!existingAsset) {
          throw new NotFoundError("Asset does not exist and autoCreateAssets is false");
        }
      }

      const prevSelf = await this.db
        .prepare(
          `SELECT binding_id, is_canonical FROM acc_asset_bindings
           WHERE tenant_id = ? AND asset_id = ? AND provider = ? AND account_id = ? AND external_resource_id = ?`
        )
        .bind(tenantId, assetId, provider, accountId, externalResourceId)
        .first<any>();
      const wasAlreadyCanonical = Boolean(prevSelf && Number(prevSelf.is_canonical) === 1);
      const bindingId = prevSelf ? String(prevSelf.binding_id) : deterministicBindingId(assetId, provider, accountId, externalResourceId);

      // Atomic conditional INSERT: claims canonical ONLY if no other account or canonical row exists at write time.
      // Never demotes an existing canonical owner!
      try {
        await this.db
          .prepare(
            `INSERT INTO acc_asset_bindings (
               tenant_id, binding_id, asset_id, account_id, connection_id, provider,
               external_resource_id, role_or_permission, is_canonical, discovery_state,
               last_discovered_at, metadata_json, created_at, updated_at
             ) VALUES (
               ?, ?, ?, ?, ?, ?, ?, ?,
               CASE WHEN NOT EXISTS (
                 SELECT 1 FROM acc_asset_bindings
                 WHERE tenant_id = ? AND asset_id = ? AND provider = ? AND (is_canonical = 1 OR account_id <> ?)
               ) THEN 1 ELSE 0 END,
               CASE WHEN EXISTS (
                 SELECT 1 FROM acc_asset_bindings
                 WHERE tenant_id = ? AND asset_id = ? AND provider = ? AND account_id <> ?
               ) THEN 'overlap_conflict' ELSE 'verified' END,
               ?, ?, ?, ?
             )
             ON CONFLICT(tenant_id, asset_id, provider, account_id, external_resource_id) DO UPDATE SET
               connection_id = excluded.connection_id,
               role_or_permission = excluded.role_or_permission,
               discovery_state = CASE
                 WHEN acc_asset_bindings.is_canonical = 1 THEN 'verified'
                 WHEN EXISTS (
                   SELECT 1 FROM acc_asset_bindings AS other
                   WHERE other.tenant_id = acc_asset_bindings.tenant_id
                     AND other.asset_id = acc_asset_bindings.asset_id
                     AND other.provider = acc_asset_bindings.provider
                     AND other.account_id <> acc_asset_bindings.account_id
                 ) THEN 'overlap_conflict'
                 ELSE 'verified'
               END,
               last_discovered_at = excluded.last_discovered_at,
               metadata_json = excluded.metadata_json,
               updated_at = excluded.updated_at`
          )
          .bind(
            tenantId,
            bindingId,
            assetId,
            accountId,
            connectionId,
            provider,
            externalResourceId,
            roleOrPermission,
            tenantId,
            assetId,
            provider,
            accountId,
            tenantId,
            assetId,
            provider,
            accountId,
            now,
            JSON.stringify(metadata),
            now,
            now
          )
          .run();
      } catch (err: any) {
        // If a concurrent transaction raced and won idx_acc_bindings_canonical, fall back to non-canonical overlap_conflict
        const msg = String(err?.message || err);
        if (!/UNIQUE constraint failed/i.test(msg)) throw err;
        await this.db
          .prepare(
            `INSERT INTO acc_asset_bindings (
               tenant_id, binding_id, asset_id, account_id, connection_id, provider,
               external_resource_id, role_or_permission, is_canonical, discovery_state,
               last_discovered_at, metadata_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'overlap_conflict', ?, ?, ?, ?)
             ON CONFLICT(tenant_id, asset_id, provider, account_id, external_resource_id) DO UPDATE SET
               connection_id = excluded.connection_id,
               role_or_permission = excluded.role_or_permission,
               discovery_state = CASE WHEN acc_asset_bindings.is_canonical = 1 THEN 'verified' ELSE 'overlap_conflict' END,
               last_discovered_at = excluded.last_discovered_at,
               metadata_json = excluded.metadata_json,
               updated_at = excluded.updated_at`
          )
          .bind(
            tenantId,
            bindingId,
            assetId,
            accountId,
            connectionId,
            provider,
            externalResourceId,
            roleOrPermission,
            now,
            JSON.stringify(metadata),
            now,
            now
          )
          .run();
      }

      const persisted = await this.db
        .prepare(
          `SELECT * FROM acc_asset_bindings
           WHERE tenant_id = ? AND asset_id = ? AND provider = ? AND account_id = ? AND external_resource_id = ?`
        )
        .bind(tenantId, assetId, provider, accountId, externalResourceId)
        .first<any>();
      const mapped = mapBinding(persisted);
      if (mapped.isCanonical && !wasAlreadyCanonical) {
        canonicalAssigned += 1;
      } else if (mapped.discoveryState === "overlap_conflict") {
        overlapsFlagged += 1;
      }
      await this.recordAudit(
        tenantId,
        "asset_binding",
        mapped.bindingId,
        "discover",
        actorId,
        `Discovered ${assetId} under ${accountId} (${provider}, canonical=${mapped.isCanonical}, state=${mapped.discoveryState})`,
        now
      );
      bindings.push(mapped);
    }

    return {
      accountId,
      provider,
      processed: bindings.length,
      createdAssets,
      canonicalAssigned,
      overlapsFlagged,
      bindings,
    };
  }

  private async fetchEnrichedBindings(
    tenantId: string,
    filters: { assetId?: string; provider?: string; accountId?: string } = {}
  ): Promise<EnrichedBindingView[]> {
    const clauses = ["b.tenant_id = ?"];
    const binds: any[] = [tenantId];
    if (filters.assetId) {
      clauses.push("b.asset_id = ?");
      binds.push(filters.assetId);
    }
    if (filters.provider) {
      clauses.push("b.provider = ?");
      binds.push(filters.provider);
    }
    if (filters.accountId) {
      clauses.push("b.account_id = ?");
      binds.push(filters.accountId);
    }

    const sql = `
      SELECT
        b.*,
        a.label AS account_label,
        a.owner_principal_id AS owner_principal_id,
        p.email AS owner_email,
        c.vault_backend_id AS vault_backend_id,
        vb.driver AS vault_driver,
        c.vault_uri AS vault_uri,
        c.fallback_vault_uri AS fallback_vault_uri,
        c.status AS connection_status
      FROM acc_asset_bindings b
      JOIN acc_provider_accounts a
        ON a.tenant_id = b.tenant_id AND a.account_id = b.account_id
      LEFT JOIN acc_principals p
        ON p.tenant_id = a.tenant_id AND p.principal_id = a.owner_principal_id
      LEFT JOIN acc_connections c
        ON c.tenant_id = b.tenant_id AND c.connection_id = b.connection_id AND c.account_id = b.account_id
      LEFT JOIN acc_vault_backends vb
        ON vb.tenant_id = c.tenant_id AND vb.backend_id = c.vault_backend_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY b.asset_id ASC, b.provider ASC, b.is_canonical DESC, b.account_id ASC
    `;
    const res = await this.db.prepare(sql).bind(...binds).all<any>();
    return (res.results || []).map(mapEnrichedBinding);
  }

  public async whoOwns(
    tenantIdRaw: string,
    assetIdRaw: string,
    expectedProviders: string[] = []
  ): Promise<WhoOwnsResult> {
    const tenantId = requireSafeId(tenantIdRaw, "tenantId");
    const assetId = requireSafeId(assetIdRaw, "assetId");
    const assetRow = await this.db
      .prepare("SELECT * FROM acc_assets WHERE tenant_id = ? AND asset_id = ?")
      .bind(tenantId, assetId)
      .first<any>();
    if (!assetRow) {
      throw new NotFoundError("Asset not found in tenant");
    }
    const asset = mapAsset(assetRow);
    const bindings = await this.fetchEnrichedBindings(tenantId, { assetId });

    const providers: WhoOwnsResult["providers"] = Object.create(null);
    for (const b of bindings) {
      if (!providers[b.provider]) {
        providers[b.provider] = { canonical: null, allBindings: [], hasOverlap: false };
      }
      providers[b.provider].allBindings.push(b);
      if (b.isCanonical) {
        providers[b.provider].canonical = b;
      }
    }
    for (const group of Object.values(providers)) {
      const distinctAccounts = new Set(group.allBindings.map((x) => x.accountId));
      group.hasOverlap = distinctAccounts.size > 1;
    }
    const cleanExpected = requireSafeStringArray(expectedProviders, "expectedProviders").map((p) => p.toLowerCase());
    const missingProviders = cleanExpected.filter((p) => !providers[p] || !providers[p].canonical);

    return { tenantId, asset, providers, missingProviders };
  }

  public async queryMatrix(input: {
    tenantId: string;
    assetKind?: AssetKind;
    provider?: string;
    brandGroup?: string;
    allowedAssetIds?: string[] | null;
  }): Promise<{
    tenantId: string;
    assets: Array<{
      asset: AssetRecord;
      bindingsByProvider: Record<string, { canonical: EnrichedBindingView | null; count: number; hasOverlap: boolean }>;
    }>;
    accounts: ProviderAccountRecord[];
    vaultBackends: VaultBackendRecord[];
    summary: {
      totalAssets: number;
      totalAccounts: number;
      totalBindings: number;
      overlapCount: number;
      unboundAssets: number;
    };
  }> {
    const tenantId = requireSafeId(input.tenantId, "tenantId");
    const provider = input.provider ? requireSafeId(input.provider, "provider").toLowerCase() : undefined;
    let assets = await this.listAssets(tenantId, input.assetKind);
    if (input.brandGroup) {
      const bg = input.brandGroup.trim().toLowerCase();
      assets = assets.filter((a) => (a.brandGroup || "").toLowerCase() === bg);
    }
    if (input.allowedAssetIds !== undefined && input.allowedAssetIds !== null) {
      const allowed = new Set(input.allowedAssetIds);
      assets = assets.filter((a) => allowed.has(a.assetId));
    }

    const allBindings = await this.fetchEnrichedBindings(tenantId, { provider });
    const bindingsByAsset = new Map<string, EnrichedBindingView[]>();
    for (const b of allBindings) {
      const list = bindingsByAsset.get(b.assetId) || [];
      list.push(b);
      bindingsByAsset.set(b.assetId, list);
    }

    let overlapCount = 0;
    let unboundAssets = 0;
    const matrixRows = assets.map((asset) => {
      const list = bindingsByAsset.get(asset.assetId) || [];
      if (list.length === 0) unboundAssets += 1;
      const byProv: Record<string, { canonical: EnrichedBindingView | null; count: number; hasOverlap: boolean }> = Object.create(null);
      const acctSets = new Map<string, Set<string>>();
      for (const b of list) {
        if (!byProv[b.provider]) {
          byProv[b.provider] = { canonical: null, count: 0, hasOverlap: false };
          acctSets.set(b.provider, new Set());
        }
        byProv[b.provider].count += 1;
        acctSets.get(b.provider)!.add(b.accountId);
        if (b.isCanonical) byProv[b.provider].canonical = b;
      }
      for (const [prov, set] of acctSets.entries()) {
        if (set.size > 1) {
          byProv[prov].hasOverlap = true;
          overlapCount += 1;
        }
      }
      return { asset, bindingsByProvider: byProv };
    });

    const accounts = await this.listProviderAccounts(tenantId, provider);
    const vaultBackends = await this.listVaultBackends(tenantId);

    return {
      tenantId,
      assets: matrixRows,
      accounts,
      vaultBackends,
      summary: {
        totalAssets: matrixRows.length,
        totalAccounts: accounts.length,
        totalBindings: allBindings.filter((b) => matrixRows.some((r) => r.asset.assetId === b.assetId)).length,
        overlapCount,
        unboundAssets,
      },
    };
  }

  public async queryOverlapsAndGaps(
    tenantIdRaw: string,
    expectedProvidersRaw: string[] = ["gsc", "bing_webmaster"],
    assetKind?: AssetKind
  ): Promise<{
    tenantId: string;
    overlaps: Array<{ assetId: string; provider: string; accounts: string[]; canonicalAccountId: string | null }>;
    gaps: Array<{ assetId: string; missingProviders: string[] }>;
  }> {
    const tenantId = requireSafeId(tenantIdRaw, "tenantId");
    const expectedProviders = requireSafeStringArray(expectedProvidersRaw, "expectedProviders").map((p) => p.toLowerCase());
    const assets = await this.listAssets(tenantId, assetKind);
    const bindings = await this.fetchEnrichedBindings(tenantId);

    const byAssetProvider = new Map<string, EnrichedBindingView[]>();
    for (const b of bindings) {
      const key = `${b.assetId}|${b.provider}`;
      const list = byAssetProvider.get(key) || [];
      list.push(b);
      byAssetProvider.set(key, list);
    }

    const overlaps: Array<{ assetId: string; provider: string; accounts: string[]; canonicalAccountId: string | null }> = [];
    const gaps: Array<{ assetId: string; missingProviders: string[] }> = [];

    for (const [key, list] of byAssetProvider.entries()) {
      const distinctAccounts = [...new Set(list.map((b) => b.accountId))].sort();
      if (distinctAccounts.length > 1) {
        const [assetId, provider] = key.split("|");
        const canonical = list.find((b) => b.isCanonical);
        overlaps.push({
          assetId,
          provider,
          accounts: distinctAccounts,
          canonicalAccountId: canonical ? canonical.accountId : null,
        });
      }
    }

    for (const asset of assets) {
      const missing: string[] = [];
      for (const prov of expectedProviders) {
        const list = byAssetProvider.get(`${asset.assetId}|${prov}`) || [];
        if (!list.some((b) => b.isCanonical)) {
          missing.push(prov);
        }
      }
      if (missing.length > 0) {
        gaps.push({ assetId: asset.assetId, missingProviders: missing });
      }
    }

    return { tenantId, overlaps, gaps };
  }

  public async queryAuditEvents(tenantIdRaw: string, sinceSeq = 0, limit = 100): Promise<AuditEventRecord[]> {
    const tenantId = requireSafeId(tenantIdRaw, "tenantId");
    const safeSince = Number.isInteger(sinceSeq) && sinceSeq >= 0 ? sinceSeq : 0;
    const safeLimit = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, 500) : 100;
    const res = await this.db
      .prepare("SELECT * FROM acc_audit_events WHERE tenant_id = ? AND event_seq > ? ORDER BY event_seq ASC LIMIT ?")
      .bind(tenantId, safeSince, safeLimit)
      .all<any>();
    return (res.results || []).map((r) => ({
      eventSeq: Number(r.event_seq),
      tenantId: String(r.tenant_id),
      entityType: String(r.entity_type),
      entityId: String(r.entity_id),
      action: String(r.action),
      actorId: String(r.actor_id),
      summary: String(r.summary),
      createdAt: Number(r.created_at),
    }));
  }

  public async getCockpitCounts(): Promise<{
    vaultBackendCount: number;
    principalCount: number;
    accountCount: number;
    connectionCount: number;
    assetCount: number;
    bindingCount: number;
    recentAudit: AuditEventRecord[];
  }> {
    const countOf = async (table: string) => {
      const row = await this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first<any>();
      return Number(row?.c || 0);
    };
    const [vaultBackendCount, principalCount, accountCount, connectionCount, assetCount, bindingCount] = await Promise.all([
      countOf("acc_vault_backends"),
      countOf("acc_principals"),
      countOf("acc_provider_accounts"),
      countOf("acc_connections"),
      countOf("acc_assets"),
      countOf("acc_asset_bindings"),
    ]);
    const recentRes = await this.db
      .prepare("SELECT * FROM acc_audit_events ORDER BY event_seq DESC LIMIT 20")
      .all<any>();
    const recentAudit = (recentRes.results || []).map((r) => ({
      eventSeq: Number(r.event_seq),
      tenantId: String(r.tenant_id),
      entityType: String(r.entity_type),
      entityId: String(r.entity_id),
      action: String(r.action),
      actorId: String(r.actor_id),
      summary: String(r.summary),
      createdAt: Number(r.created_at),
    }));
    return { vaultBackendCount, principalCount, accountCount, connectionCount, assetCount, bindingCount, recentAudit };
  }
}
