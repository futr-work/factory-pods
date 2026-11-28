import { createEdgeMcpHandler, type McpToolDefinition } from "@futr-work/pod-kernel/edge-mcp";
import {
  authGate,
  isCallerAuthorized,
  parseScopedCallerGrants,
  resolveScopedCaller,
  type ResolvedCaller,
} from "@futr-work/pod-kernel/auth";
import { toPodStorage, type PodStorage } from "@futr-work/pod-kernel/storage";
import { AccountsService } from "./service.js";
import { assertNoEmbeddedSecretPayload } from "./vault/adapters.js";
import type { PodConfig } from "./types.js";

const ALLOWED_MCP_TASK_KEYS = new Set(["requestId", "objective", "repo", "branch", "title", "constraints", "tenantId", "assetId", "provider"]);

function sanitizeMcpTaskParams(params: Record<string, any>): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Invalid task parameters");
  }
  assertNoEmbeddedSecretPayload(params, "task");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (!ALLOWED_MCP_TASK_KEYS.has(k)) {
      throw new Error(`Unsupported task field '${k}'`);
    }
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

async function requireGrant(
  request: Request,
  env: Record<string, any>,
  tenantId: string,
  action: string,
  resourceId?: string
): Promise<ResolvedCaller> {
  const configured = parseScopedCallerGrants(env?.SCOPED_CALLER_GRANTS);
  const caller = await resolveScopedCaller(request, configured);
  if (!caller) {
    throw new Error("Unauthorized: scoped caller credential required (shared hub token has no tenant grants)");
  }
  if (!isCallerAuthorized(caller, { tenantId, resourceId, action })) {
    throw new Error("Forbidden: caller lacks tenant/resource grant for requested operation");
  }
  return caller;
}

async function resolveTaskPrincipal(
  request: Request,
  env: Record<string, any>,
  mutation: boolean
): Promise<{ ownerId: string }> {
  const configured = parseScopedCallerGrants(env?.SCOPED_CALLER_GRANTS);
  const scoped = await resolveScopedCaller(request, configured);
  if (scoped) {
    if (mutation) {
      const hasAnyWrite = scoped.grants.some((g) => g.actions.includes("*") || g.actions.includes("write"));
      if (!hasAnyWrite) {
        throw new Error("Forbidden: read-only caller cannot mutate or cancel tasks");
      }
    }
    return { ownerId: scoped.callerId };
  }
  const hubDenied = authGate(request, env as any, "accounts-pod");
  if (!hubDenied) {
    return { ownerId: "hub" };
  }
  throw new Error("Unauthorized: valid credential required");
}

export function createAccountsMcpHandler(env: Record<string, any>, config: PodConfig) {
  const getDb = (runtimeEnv: any): PodStorage => {
    const target = runtimeEnv?.DB ?? env?.DB;
    if (!target) throw new Error("PodStorage DB binding is unavailable");
    return toPodStorage(target);
  };

  // NOTE: tests/manifests.test.mjs scans this file for /name: "([a-z_]+)"/g.
  // Core 5 tools + 6 domain tools + 2 Code Mode tools (search, execute) match pod.toml exactly.
  const coreToolSpecs = [
    { name: "submit_task" },
    { name: "task_status" },
    { name: "approve" },
    { name: "cancel" },
    { name: "get_receipt" },
    { name: "search" },
    { name: "execute" },
  ];
  void coreToolSpecs;

  const domainTools: McpToolDefinition[] = [
    {
      name: "acc_who_owns",
      description: "Answer which provider accounts, principals, and non-secret vault pointers own an asset across all providers (GSC, Bing, Cloudflare, GitHub, Coolify, etc.).",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          assetId: { type: "string" },
          expectedProviders: { type: "array", items: { type: "string" } },
        },
        required: ["tenantId", "assetId"],
      },
      handler: async (args, ctx) => {
        await requireGrant(ctx.request, ctx.env ?? env, args.tenantId, "read", args.assetId);
        return new AccountsService(getDb(ctx.env)).whoOwns(args.tenantId, args.assetId, args.expectedProviders || []);
      },
    },
    {
      name: "acc_query_matrix",
      description: "Query the full Asset x Provider x Account ownership matrix and configured vault backends (zero raw secrets).",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          assetKind: { type: "string", enum: ["site", "domain", "repo", "worker", "database", "server", "project"] },
          provider: { type: "string" },
          brandGroup: { type: "string" },
        },
        required: ["tenantId"],
      },
      handler: async (args, ctx) => {
        await requireGrant(ctx.request, ctx.env ?? env, args.tenantId, "read");
        return new AccountsService(getDb(ctx.env)).queryMatrix(args);
      },
    },
    {
      name: "acc_overlaps_and_gaps",
      description: "Detect dual-account ownership overlaps and missing provider grants across a tenant's portfolio assets.",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          expectedProviders: { type: "array", items: { type: "string" } },
          assetKind: { type: "string", enum: ["site", "domain", "repo", "worker", "database", "server", "project"] },
        },
        required: ["tenantId"],
      },
      handler: async (args, ctx) => {
        await requireGrant(ctx.request, ctx.env ?? env, args.tenantId, "read");
        return new AccountsService(getDb(ctx.env)).queryOverlapsAndGaps(
          args.tenantId,
          args.expectedProviders || ["gsc", "bing_webmaster"],
          args.assetKind
        );
      },
    },
    {
      name: "acc_upsert_binding",
      description: "Create or update an asset-to-provider-account binding and optionally set it as the single canonical owner.",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          assetId: { type: "string" },
          accountId: { type: "string" },
          connectionId: { type: "string" },
          provider: { type: "string" },
          externalResourceId: { type: "string" },
          roleOrPermission: { type: "string" },
          isCanonical: { type: "boolean" },
          discoveryState: { type: "string", enum: ["verified", "missing_grant", "overlap_conflict", "stale", "manual"] },
        },
        required: ["tenantId", "assetId", "accountId", "provider", "externalResourceId"],
      },
      handler: async (args, ctx) => {
        const caller = await requireGrant(ctx.request, ctx.env ?? env, args.tenantId, "write", args.assetId);
        return new AccountsService(getDb(ctx.env)).upsertBinding(args, caller.callerId, ctx.now);
      },
    },
    {
      name: "acc_switch_vault",
      description: "Switch a connection's secret pointer between pluggable vault backends (e.g., Infisical <-> 1Password <-> LastPass <-> Bitwarden) without touching consumers.",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          connectionId: { type: "string" },
          vaultBackendId: { type: "string" },
          vaultUri: { type: "string" },
          fallbackVaultUri: { type: "string" },
        },
        required: ["tenantId", "connectionId", "vaultBackendId", "vaultUri"],
      },
      handler: async (args, ctx) => {
        const caller = await requireGrant(ctx.request, ctx.env ?? env, args.tenantId, "write");
        return new AccountsService(getDb(ctx.env)).switchConnectionVault(args, caller.callerId, ctx.now);
      },
    },
    {
      name: "acc_ingest_discovery",
      description: "Ingest discovered provider assets for an account, preserving explicit canonical ownership and flagging dual-account overlaps.",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          accountId: { type: "string" },
          connectionId: { type: "string" },
          autoCreateAssets: { type: "boolean" },
          items: { type: "array" },
        },
        required: ["tenantId", "accountId", "items"],
      },
      handler: async (args, ctx) => {
        const caller = await requireGrant(ctx.request, ctx.env ?? env, args.tenantId, "write");
        return new AccountsService(getDb(ctx.env)).ingestDiscovery(args, caller.callerId, ctx.now);
      },
    },
  ];

  return createEdgeMcpHandler({
    podName: config.id,
    podRole: config.role,
    version: "1.0.0",
    authGate: () => true,
    coreHandlers: {
      onSubmitTask: async (params, ctx) => {
        const { ownerId } = await resolveTaskPrincipal(ctx.request, ctx.env ?? env, true);
        const sanitizedParams = sanitizeMcpTaskParams(params as any);
        const db = getDb(ctx.env);
        const taskId = `task_${ownerId}_${params.requestId}`;
        const existing = await db
          .prepare("SELECT * FROM tasks WHERE task_id = ? AND owner_id = ?")
          .bind(taskId, ownerId)
          .first<any>();
        if (existing) {
          return { taskId: existing.task_id, requestId: params.requestId, phase: existing.status, status: existing.status, existing: true };
        }
        await db
          .prepare(
            `INSERT INTO tasks (task_id, owner_id, topic, source, spec_json, status, lease_expires_at, created_at, updated_at)
             VALUES (?, ?, 'mcp.task', 'mcp', ?, 'running', ?, ?, ?)`
          )
          .bind(taskId, ownerId, JSON.stringify(sanitizedParams), ctx.now + 15 * 60 * 1000, ctx.now, ctx.now)
          .run();
        return { taskId, requestId: params.requestId, phase: "running", status: "running", existing: false };
      },
      onTaskStatus: async (params, ctx) => {
        const { ownerId } = await resolveTaskPrincipal(ctx.request, ctx.env ?? env, false);
        const db = getDb(ctx.env);
        const taskId = String(params.taskId || (params.requestId ? `task_${ownerId}_${params.requestId}` : ""));
        const row = await db
          .prepare("SELECT * FROM tasks WHERE task_id = ? AND owner_id = ?")
          .bind(taskId, ownerId)
          .first<any>();
        if (!row) throw new Error(`Task not found or not owned by caller: '${taskId}'`);
        return {
          taskId,
          phase: row.status,
          status: row.status,
          checks: row.status === "completed" ? ["PASS task-completed"] : [],
          error: row.error_message || undefined,
        };
      },
      onApprove: async (params, ctx) => {
        const { ownerId } = await resolveTaskPrincipal(ctx.request, ctx.env ?? env, true);
        const db = getDb(ctx.env);
        const res = await db
          .prepare("UPDATE tasks SET updated_at = ? WHERE task_id = ? AND owner_id = ?")
          .bind(ctx.now, String(params.taskId), ownerId)
          .run();
        if (!res.meta.changes) throw new Error(`Task not found or not owned by caller: '${String(params.taskId)}'`);
        return { ok: true, decision: params.decision };
      },
      onCancel: async (params, ctx) => {
        const { ownerId } = await resolveTaskPrincipal(ctx.request, ctx.env ?? env, true);
        const db = getDb(ctx.env);
        const res = await db
          .prepare("UPDATE tasks SET status = 'failed', error_message = 'Cancelled by MCP', updated_at = ? WHERE task_id = ? AND owner_id = ?")
          .bind(ctx.now, String(params.taskId), ownerId)
          .run();
        if (!res.meta.changes) throw new Error(`Task not found or not owned by caller: '${String(params.taskId)}'`);
        return { ok: true, status: "aborted" };
      },
      onGetReceipt: async (params, ctx) => {
        const { ownerId } = await resolveTaskPrincipal(ctx.request, ctx.env ?? env, false);
        const db = getDb(ctx.env);
        const taskId = String(params.taskId);
        const row = await db
          .prepare("SELECT * FROM tasks WHERE task_id = ? AND owner_id = ?")
          .bind(taskId, ownerId)
          .first<any>();
        if (!row) throw new Error(`Receipt not found for task '${taskId}'`);
        if (row.status !== "completed" || !row.result_json) {
          throw new Error(`Receipt not ready: task '${taskId}' is in status '${row.status}'`);
        }
        const parsed = JSON.parse(row.result_json);
        return {
          taskId,
          pr: String(parsed?.pr || ""),
          commit: String(parsed?.commit || ""),
          checks: Array.isArray(parsed?.checks) ? parsed.checks : [],
          diffHash: String(parsed?.receiptHash || ""),
          model: String(parsed?.model || "deterministic"),
          provider: String(parsed?.provider || "accounts-pod"),
          family: String(parsed?.family || "deterministic"),
          runtime: "pod-kernel",
        };
      },
    },
    tools: domainTools,
    tasks: {
      list: async ({ limit }, ctx) => {
        const { ownerId } = await resolveTaskPrincipal(ctx.request, ctx.env ?? env, false);
        const db = getDb(ctx.env);
        const rows = await db
          .prepare("SELECT task_id, topic, status, created_at, updated_at FROM tasks WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?")
          .bind(ownerId, Math.min(limit ?? 20, 100))
          .all<any>();
        return {
          tasks: (rows.results || []).map((r) => ({
            taskId: r.task_id,
            status: r.status,
            createdAt: new Date(r.created_at).toISOString(),
            lastUpdatedAt: new Date(r.updated_at).toISOString(),
          })),
        };
      },
      get: async ({ taskId }, ctx) => {
        const { ownerId } = await resolveTaskPrincipal(ctx.request, ctx.env ?? env, false);
        const db = getDb(ctx.env);
        const row = await db
          .prepare("SELECT * FROM tasks WHERE task_id = ? AND owner_id = ?")
          .bind(taskId, ownerId)
          .first<any>();
        if (!row) return null;
        return {
          taskId: row.task_id,
          status: row.status,
          createdAt: new Date(row.created_at).toISOString(),
          lastUpdatedAt: new Date(row.updated_at).toISOString(),
        };
      },
      cancel: async ({ taskId }, ctx) => {
        const { ownerId } = await resolveTaskPrincipal(ctx.request, ctx.env ?? env, true);
        const db = getDb(ctx.env);
        const res = await db
          .prepare("UPDATE tasks SET status = 'failed', error_message = 'Cancelled by MCP tasks/cancel', updated_at = ? WHERE task_id = ? AND owner_id = ?")
          .bind(ctx.now, taskId, ownerId)
          .run();
        if (!res.meta.changes) throw new Error(`Task not found or not owned by caller: '${taskId}'`);
        return { taskId, status: "cancelled" };
      },
    },
    resources: [
      {
        uri: "accounts://contract/schema",
        name: "Accounts Pod Contract & Vault Drivers",
        description: "Supported vault drivers, principal kinds, asset kinds, and zero-secret vault:// pointer contract.",
        mimeType: "application/json",
        read: async () => ({
          text: JSON.stringify(
            {
              pod: config.id,
              version: "1.0.0",
              vaultDrivers: ["infisical", "onepassword_connect", "onepassword_cli", "lastpass", "bitwarden", "aws_sm", "gcp_sm", "cf_secret", "oauth_broker"],
              principalKinds: ["human", "service_account", "oauth_app", "org"],
              assetKinds: ["site", "domain", "repo", "worker", "database", "server", "project"],
              vaultUriFormat: "vault://<backendId>/<locator>[#<fragment>]",
            },
            null,
            2
          ),
        }),
      },
    ],
    codeMode: {
      timeoutMs: 2000,
      spec: [
        {
          name: "whoOwns",
          method: "pod.whoOwns(tenantId, assetId, expectedProviders?)",
          description: "Inspect canonical provider accounts, overlaps, and non-secret vault pointers for a single asset",
          signature: "(tenantId: string, assetId: string, expectedProviders?: string[]) => Promise<WhoOwnsResult>",
          tags: ["ownership", "accounts", "vault"],
        },
        {
          name: "queryMatrix",
          method: "pod.queryMatrix(params)",
          description: "Query Asset x Provider x Account ownership matrix scoped to caller grants",
          signature: "(params: { tenantId: string; assetKind?: string; provider?: string; brandGroup?: string }) => Promise<MatrixResult>",
          tags: ["matrix", "portfolio", "accounts"],
        },
        {
          name: "overlapsAndGaps",
          method: "pod.overlapsAndGaps(tenantId, expectedProviders?, assetKind?)",
          description: "Find dual-account overlaps and missing provider bindings",
          signature: "(tenantId: string, expectedProviders?: string[], assetKind?: string) => Promise<{ overlaps: any[]; gaps: any[] }>",
          tags: ["overlaps", "gaps", "audit"],
        },
      ],
      createSdk: (ctx) => {
        const runtimeEnv = ctx.env ?? env;
        const service = new AccountsService(getDb(runtimeEnv));
        return {
          whoOwns: async (tenantId: string, assetId: string, expectedProviders: string[] = []) => {
            await requireGrant(ctx.request, runtimeEnv, tenantId, "read", assetId);
            return service.whoOwns(tenantId, assetId, expectedProviders);
          },
          queryMatrix: async (params: any) => {
            await requireGrant(ctx.request, runtimeEnv, params.tenantId, "read");
            return service.queryMatrix(params);
          },
          overlapsAndGaps: async (tenantId: string, expectedProviders: string[] = ["gsc", "bing_webmaster"], assetKind?: any) => {
            await requireGrant(ctx.request, runtimeEnv, tenantId, "read");
            return service.queryOverlapsAndGaps(tenantId, expectedProviders, assetKind);
          },
        };
      },
    },
  });
}
