import type { PodStorage } from "@futr-work/pod-kernel/storage";

export type VaultDriver =
  | "infisical"
  | "onepassword_connect"
  | "onepassword_cli"
  | "lastpass"
  | "bitwarden"
  | "aws_sm"
  | "gcp_sm"
  | "cf_secret"
  | "oauth_broker";

export type PrincipalKind = "human" | "service_account" | "oauth_app" | "org";

export type AuthType =
  | "oauth2_refresh"
  | "oauth2_client_credentials"
  | "gcp_service_account"
  | "api_key"
  | "bearer_token"
  | "ssh_key"
  | "github_app"
  | "session";

export type ConnectionStatus = "healthy" | "needs_auth" | "expired" | "revoked" | "unconfigured";

export type AssetKind = "site" | "domain" | "repo" | "worker" | "database" | "server" | "project";

export type DiscoveryState = "verified" | "missing_grant" | "overlap_conflict" | "stale" | "manual";

export interface PodConfig {
  id: string;
  name: string;
  role: string;
  lob: string;
  hubUrl: string;
  hubToken: string;
  port: number;
  capabilities: string[];
}

export interface TaskRecord {
  taskId: string;
  ownerId: string;
  topic: string;
  source: string;
  spec: any;
  status: string;
  result?: any;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface HandlerContext {
  podConfig: PodConfig;
  now: number;
  storage: PodStorage;
  publishEvent: (topic: string, target: string, payload: any) => Promise<any>;
}

export interface TaskHandler {
  name: string;
  canHandle(topic: string, spec: any): boolean;
  handle(task: TaskRecord, context: HandlerContext): Promise<any>;
}

export interface VaultBackendRecord {
  tenantId: string;
  backendId: string;
  driver: VaultDriver;
  label: string;
  config: Record<string, unknown>;
  capabilities: string[];
  status: "active" | "degraded" | "disabled";
  createdAt: number;
  updatedAt: number;
}

export interface PrincipalRecord {
  tenantId: string;
  principalId: string;
  kind: PrincipalKind;
  displayName: string;
  email: string | null;
  status: "active" | "disabled";
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderAccountRecord {
  tenantId: string;
  accountId: string;
  provider: string;
  externalAccountId: string | null;
  ownerPrincipalId: string;
  label: string;
  environment: string;
  status: "active" | "disabled";
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ConnectionRecord {
  tenantId: string;
  connectionId: string;
  accountId: string;
  authType: AuthType;
  vaultBackendId: string;
  vaultUri: string;
  fallbackVaultUri: string | null;
  scopes: string[];
  oauthMeta: Record<string, unknown>;
  zeroSpendConfirmed: boolean;
  status: ConnectionStatus;
  lastVerifiedAt: number | null;
  lastErrorClass: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AssetRecord {
  tenantId: string;
  assetId: string;
  assetKind: AssetKind;
  canonicalName: string;
  brandGroup: string | null;
  lifecycleStatus: "active" | "parked" | "archived";
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface AssetBindingRecord {
  tenantId: string;
  bindingId: string;
  assetId: string;
  accountId: string;
  connectionId: string | null;
  provider: string;
  externalResourceId: string;
  roleOrPermission: string;
  isCanonical: boolean;
  discoveryState: DiscoveryState;
  lastDiscoveredAt: number | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface AuditEventRecord {
  eventSeq: number;
  tenantId: string;
  entityType: string;
  entityId: string;
  action: string;
  actorId: string;
  summary: string;
  createdAt: number;
}

export interface EnrichedBindingView extends AssetBindingRecord {
  accountLabel: string;
  ownerPrincipalId: string;
  ownerEmail: string | null;
  vaultBackendId: string | null;
  vaultDriver: VaultDriver | null;
  vaultUri: string | null;
  fallbackVaultUri: string | null;
  connectionStatus: ConnectionStatus | null;
}

export interface WhoOwnsResult {
  tenantId: string;
  asset: AssetRecord;
  providers: Record<
    string,
    {
      canonical: EnrichedBindingView | null;
      allBindings: EnrichedBindingView[];
      hasOverlap: boolean;
    }
  >;
  missingProviders: string[];
}
