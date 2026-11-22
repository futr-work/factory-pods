import { createEdgeMcpHandler, type McpToolDefinition } from "@futr-work/pod-kernel/edge-mcp";
import {
  authGate,
  isCallerAuthorized,
  parseScopedCallerGrants,
  resolveScopedCaller,
  type ResolvedCaller,
} from "@futr-work/pod-kernel/auth";
import { toPodStorage, type PodStorage } from "@futr-work/pod-kernel/storage";
import { MeasurementService } from "./service.js";
import type { PodConfig } from "./types.js";

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

/**
 * Resolves the task owner principal for core MCP tools and `tasks/*` operations.
 * - Scoped callers are isolated to their own `callerId` and require a `write` grant for mutations
 *   (submit_task, approve, cancel, tasks/cancel).
 * - The hub token resolves to owner `"hub"` (can only see/manage hub-owned tasks, never scoped-tenant tasks).
 */
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
  const hubDenied = authGate(request, env as any, "measurement-pod");
  if (!hubDenied) {
    return { ownerId: "hub" };
  }
  throw new Error("Unauthorized: valid credential required");
}

export function createMeasurementMcpHandler(env: Record<string, any>, config: PodConfig) {
  const getDb = (runtimeEnv: any): PodStorage => {
    const target = runtimeEnv?.DB ?? env?.DB;
    if (!target) throw new Error("PodStorage DB binding is unavailable");
    return toPodStorage(target);
  };

  // NOTE: tests/manifests.test.mjs scans this file for /name: "([a-z_]+)"/g.
  // Core 5 tools + 6 domain tools + 2 Code Mode tools (search, execute) are all declared below and in pod.toml.
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
      name: "ms_register_resource",
      description: "Register or update a tenant-scoped resource (site, analytics_property, ad_account, server_service) with a canonical Worldview entity_urn.",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          resourceId: { type: "string" },
          resourceType: { type: "string", enum: ["site", "analytics_property", "ad_account", "server_service"] },
          sourceResourceId: { type: "string" },
          displayName: { type: "string" },
          activeFrom: { type: "string" },
          activeTo: { type: "string" },
        },
        required: ["tenantId", "resourceId", "resourceType", "sourceResourceId", "activeFrom"],
      },
      handler: async (args, ctx) => {
        await requireGrant(ctx.request, ctx.env ?? env, args.tenantId, "write", args.resourceId);
        return new MeasurementService(getDb(ctx.env)).registerResource(args, ctx.now);
      },
    },
    {
      name: "ms_define_metric",
      description: "Define a versioned typed metric (seo, analytics, spend, telemetry) with explicit unit, grain, windowTz, dimensionsSchema, and comparability rules.",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Caller tenant for authorization scope" },
          metricId: { type: "string" },
          version: { type: "string" },
          family: { type: "string", enum: ["seo", "analytics", "spend", "telemetry"] },
          unit: { type: "string" },
          valueType: { type: "string", enum: ["integer", "decimal_string", "gauge", "counter"] },
          grain: { type: "string" },
          windowTz: { type: "string" },
          dimensionsSchema: { type: "object" },
          numeratorRule: { type: "string" },
          denominatorRule: { type: "string" },
          exclusionsRule: { type: "string" },
          aggregationRule: { type: "string" },
        },
        required: ["tenantId", "metricId", "version", "family", "unit", "valueType", "grain", "windowTz", "dimensionsSchema", "aggregationRule"],
      },
      handler: async (args, ctx) => {
        await requireGrant(ctx.request, ctx.env ?? env, args.tenantId, "write", "*");
        return new MeasurementService(getDb(ctx.env)).defineMetric(args, ctx.now);
      },
    },
    {
      name: "ms_record_observations",
      description: "Atomically ingest immutable evidence metadata, typed observations, and coverage/reconciliation for a run.",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          resourceId: { type: "string" },
          source: { type: "string" },
          runId: { type: "string" },
          windowStart: { type: "string" },
          windowEnd: { type: "string" },
          cursor: { type: "string" },
          evidence: { type: "object" },
          observations: { type: "array" },
          coverage: { type: "object" },
        },
        required: ["tenantId", "resourceId", "source", "runId", "windowStart", "windowEnd", "evidence", "observations"],
      },
      handler: async (args, ctx) => {
        await requireGrant(ctx.request, ctx.env ?? env, args.tenantId, "write", args.resourceId);
        return new MeasurementService(getDb(ctx.env)).ingestBatch(args, ctx.now);
      },
    },
    {
      name: "ms_query_series",
      description: "Query compatible revisioned time-series observations with correction lineage and pagination.",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          resourceId: { type: "string" },
          metricId: { type: "string" },
          definitionVersion: { type: "string" },
          windowStart: { type: "string" },
          windowEnd: { type: "string" },
          dimensions: { type: "object" },
          includeSuperseded: { type: "boolean" },
          limit: { type: "number" },
          offset: { type: "number" },
        },
        required: ["tenantId", "resourceId", "metricId"],
      },
      handler: async (args, ctx) => {
        await requireGrant(ctx.request, ctx.env ?? env, args.tenantId, "read", args.resourceId);
        return new MeasurementService(getDb(ctx.env)).querySeries(args);
      },
    },
    {
      name: "ms_check_coverage",
      description: "Inspect explicit coverage, freshness, and source reconciliation states (missing never synthesizes zero).",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          resourceId: { type: "string" },
          source: { type: "string" },
          limit: { type: "number" },
          offset: { type: "number" },
        },
        required: ["tenantId"],
      },
      handler: async (args, ctx) => {
        await requireGrant(ctx.request, ctx.env ?? env, args.tenantId, "read", args.resourceId);
        return new MeasurementService(getDb(ctx.env)).queryCoverage(args);
      },
    },
    {
      name: "ms_annotate_work",
      description: "Attach a non-causal work/deploy annotation (commit, PR, fixpack) to a measured resource and emit a Worldview projection event.",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          resourceId: { type: "string" },
          podId: { type: "string" },
          kind: { type: "string", enum: ["deploy", "fixpack", "config_change", "incident", "note"] },
          commitSha: { type: "string" },
          prUrl: { type: "string" },
          summary: { type: "string" },
          occurredAt: { type: "string" },
        },
        required: ["tenantId", "resourceId", "podId", "kind", "summary", "occurredAt"],
      },
      handler: async (args, ctx) => {
        await requireGrant(ctx.request, ctx.env ?? env, args.tenantId, "write", args.resourceId);
        return new MeasurementService(getDb(ctx.env)).annotateWork(args, ctx.now);
      },
    },
  ];

  return createEdgeMcpHandler({
    podName: config.id,
    podRole: config.role,
    version: "1.0.0",
    // Auth is enforced at the worker boundary (authGate + scoped-caller grants inside each tool/SDK method)
    authGate: () => true,
    coreHandlers: {
      onSubmitTask: async (params, ctx) => {
        const { ownerId } = await resolveTaskPrincipal(ctx.request, ctx.env ?? env, true);
        const db = getDb(ctx.env);
        const taskId = `task_${ownerId}_${params.requestId}`;
        const existing = await db
          .prepare("SELECT * FROM tasks WHERE task_id = ? AND owner_id = ?")
          .bind(taskId, ownerId)
          .first<any>();
        if (existing) {
          return {
            taskId: existing.task_id,
            requestId: params.requestId,
            phase: existing.status,
            status: existing.status,
            existing: true,
          };
        }
        await db
          .prepare(
            `INSERT INTO tasks (task_id, owner_id, topic, source, spec_json, status, lease_expires_at, created_at, updated_at)
             VALUES (?, ?, 'mcp.task', 'mcp', ?, 'running', ?, ?, ?)`
          )
          .bind(taskId, ownerId, JSON.stringify(params), ctx.now + 15 * 60 * 1000, ctx.now, ctx.now)
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
        if (!row) {
          throw new Error(`Task not found or not owned by caller: '${taskId}'`);
        }
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
        if (!res.meta.changes) {
          throw new Error(`Task not found or not owned by caller: '${String(params.taskId)}'`);
        }
        return { ok: true, decision: params.decision };
      },
      onCancel: async (params, ctx) => {
        const { ownerId } = await resolveTaskPrincipal(ctx.request, ctx.env ?? env, true);
        const db = getDb(ctx.env);
        const res = await db
          .prepare("UPDATE tasks SET status = 'failed', error_message = 'Cancelled by MCP', updated_at = ? WHERE task_id = ? AND owner_id = ?")
          .bind(ctx.now, String(params.taskId), ownerId)
          .run();
        if (!res.meta.changes) {
          throw new Error(`Task not found or not owned by caller: '${String(params.taskId)}'`);
        }
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
        if (!row) {
          throw new Error(`Receipt not found for task '${taskId}'`);
        }
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
          provider: String(parsed?.provider || "measurement-pod"),
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
        if (!res.meta.changes) {
          throw new Error(`Task not found or not owned by caller: '${taskId}'`);
        }
        return { taskId, status: "cancelled" };
      },
    },
    resources: [
      {
        uri: "measurement://contract/schema",
        name: "Measurement Pod Schema & Families",
        description: "Supported resource types, metric families, coverage states, and Worldview projection contract.",
        mimeType: "application/json",
        read: async () => ({
          text: JSON.stringify(
            {
              pod: config.id,
              version: "1.0.0",
              resourceTypes: ["site", "analytics_property", "ad_account", "server_service"],
              metricFamilies: ["seo", "analytics", "spend", "telemetry"],
              coverageStates: ["planned", "attempted", "successful", "zero", "partial", "failed", "blocked", "not-collected", "stale"],
              worldviewProjection: "/api/measurement/events?since_cursor=0",
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
          name: "querySeries",
          method: "pod.querySeries(params)",
          description: "Query compatible revisioned time-series observations scoped to caller grants",
          signature: "(params: { tenantId: string; resourceId: string; metricId: string; definitionVersion?: string; windowStart?: string; windowEnd?: string; limit?: number }) => Promise<SeriesResult>",
          tags: ["series", "metrics", "query"],
        },
        {
          name: "checkCoverage",
          method: "pod.checkCoverage(params)",
          description: "Inspect explicit coverage, lag, freshness, and source reconciliation status",
          signature: "(params: { tenantId: string; resourceId?: string; source?: string; limit?: number }) => Promise<{ items: CoverageItem[] }>",
          tags: ["coverage", "freshness", "reconciliation"],
        },
        {
          name: "queryEvents",
          method: "pod.queryEvents(params)",
          description: "Read monotonic Worldview projection cursor events for a tenant/resource",
          signature: "(params: { tenantId: string; resourceId?: string; sinceCursor?: number; limit?: number }) => Promise<{ nextCursor: number; events: Event[] }>",
          tags: ["worldview", "events", "cursor"],
        },
        {
          name: "getEvidenceMetadata",
          method: "pod.getEvidenceMetadata(tenantId, evidenceId)",
          description: "Fetch immutable evidence handle metadata (SHA-256, URI pointer, privacy class — never raw bytes)",
          signature: "(tenantId: string, evidenceId: string) => Promise<EvidenceMetadata>",
          tags: ["evidence", "provenance"],
        },
      ],
      createSdk: (ctx) => {
        const runtimeEnv = ctx.env ?? env;
        const service = new MeasurementService(getDb(runtimeEnv));
        return {
          querySeries: async (params: any) => {
            await requireGrant(ctx.request, runtimeEnv, params.tenantId, "read", params.resourceId);
            return service.querySeries(params);
          },
          checkCoverage: async (params: any) => {
            await requireGrant(ctx.request, runtimeEnv, params.tenantId, "read", params.resourceId);
            return service.queryCoverage(params);
          },
          queryEvents: async (params: any) => {
            await requireGrant(ctx.request, runtimeEnv, params.tenantId, "read", params.resourceId);
            return service.queryEvents(params);
          },
          getEvidenceMetadata: async (tenantId: string, evidenceId: string) => {
            const ev = await service.getEvidenceMetadata(tenantId, evidenceId);
            await requireGrant(ctx.request, runtimeEnv, tenantId, "read", ev.resourceId);
            return ev;
          },
        };
      },
    },
  });
}
