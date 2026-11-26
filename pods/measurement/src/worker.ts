import { toPodStorage, type D1DatabaseLike, type PodStorage } from "@futr-work/pod-kernel/storage";
import {
  authGate,
  authorizeScopedCaller,
  parseScopedCallerGrants,
  resolveScopedCaller,
  type ResolvedCaller,
} from "@futr-work/pod-kernel/auth";
import { TincanClient } from "@futr-work/pod-kernel/tincan";
import { loadPodConfig } from "./config.js";
import { activeHandler } from "./handler.js";
import { createMeasurementMcpHandler } from "./mcp.js";
import { ConflictError, ForbiddenError, MeasurementService, NotFoundError, ValidationError } from "./service.js";
import { renderPodUiHtml } from "./ui.js";
import type { TaskRecord } from "./types.js";

export interface Env {
  DB: D1Database | D1DatabaseLike | PodStorage;
  FACTORY_HUB?: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  CODE_LOADER?: any;
  POD_ID?: string;
  POD_NAME?: string;
  POD_ROLE?: string;
  POD_LOB?: string;
  FACTORY_HUB_URL?: string;
  FACTORY_HUB_TOKEN?: string;
  SCOPED_CALLER_GRANTS?: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Version, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function hasAnyTenantWriteGrant(
  caller: { grants: Array<{ tenantId: string; resourceIds: string[]; actions: string[] }> },
  tenantId: string
): boolean {
  return caller.grants.some(
    (g) =>
      g.tenantId === tenantId &&
      g.resourceIds.length > 0 &&
      (g.actions.includes("*") || g.actions.includes("write"))
  );
}

function errorResponse(err: unknown): Response {
  if (err instanceof ValidationError) return jsonResponse({ error: err.message }, 400);
  if (err instanceof ForbiddenError) return jsonResponse({ error: err.message }, 403);
  if (err instanceof ConflictError) return jsonResponse({ error: err.message }, 409);
  if (err instanceof NotFoundError) return jsonResponse({ error: err.message }, 404);
  const message = err instanceof Error ? err.message : "Internal error";
  return jsonResponse({ error: message }, 500);
}

async function parseJsonBody(request: Request): Promise<Record<string, any>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ValidationError("Invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("JSON body must be an object");
  }
  return parsed as Record<string, any>;
}

/**
 * Authorize measurement domain routes strictly via scoped caller credentials & server-side grants.
 * A shared FACTORY_HUB_TOKEN alone NEVER grants tenant data access (fails closed).
 */
async function resolveAndAuthorize(
  request: Request,
  env: Env,
  req: { tenantId: string; resourceId?: string; action: string }
): Promise<{ caller: ResolvedCaller; denied: null } | { caller: null; denied: Response }> {
  const configured = parseScopedCallerGrants(env.SCOPED_CALLER_GRANTS);
  const caller = await resolveScopedCaller(request, configured);
  const denied = authorizeScopedCaller(caller, req, "measurement-pod");
  if (denied) return { caller: null, denied };
  return { caller: caller!, denied: null };
}

export default {
  async fetch(request: Request, env: Env, ctx?: any): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const config = loadPodConfig(env as any);

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 1. Open liveness probe only (no tenant data)
    if (url.pathname === "/health") {
      return jsonResponse({
        status: "healthy",
        podId: config.id,
        name: config.name,
        role: config.role,
        lob: config.lob,
        mcpVersion: "2026-07-28",
        codeMode: true,
        timestamp: Date.now(),
      });
    }

    const db: PodStorage = toPodStorage(env.DB);
    const service = new MeasurementService(db);

    // 2. Scoped measurement REST & Worldview projection API (/api/measurement/*)
    //    Authenticated strictly via scoped caller credentials (never accepts ungranted shared hub token).
    if (url.pathname.startsWith("/api/measurement/")) {
      try {
        // POST /api/measurement/resources
        if (method === "POST" && url.pathname === "/api/measurement/resources") {
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          const resourceId = typeof body.resourceId === "string" ? body.resourceId.trim() : "";
          const { denied } = await resolveAndAuthorize(request, env, { tenantId, resourceId, action: "write" });
          if (denied) return denied;
          const result = await service.registerResource(body as any);
          return jsonResponse(result, 201);
        }

        // POST /api/measurement/definitions (tenant-scoped catalog)
        if (method === "POST" && url.pathname === "/api/measurement/definitions") {
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          const { denied } = await resolveAndAuthorize(request, env, { tenantId, resourceId: "*", action: "write" });
          if (denied) return denied;
          const result = await service.defineMetric({ ...body, tenantId } as any);
          return jsonResponse(result, 201);
        }

        // POST /api/measurement/runs
        if (method === "POST" && url.pathname === "/api/measurement/runs") {
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          const resourceId = typeof body.resourceId === "string" ? body.resourceId.trim() : "";
          const { denied } = await resolveAndAuthorize(request, env, { tenantId, resourceId, action: "write" });
          if (denied) return denied;
          const { run, existing } = await service.createRun(body as any);
          return jsonResponse({ ...run, existing }, existing ? 200 : 201);
        }

        // POST /api/measurement/runs/:runId/attempts
        const attemptMatch = url.pathname.match(/^\/api\/measurement\/runs\/([^/]+)\/attempts$/);
        if (method === "POST" && attemptMatch) {
          const runId = decodeURIComponent(attemptMatch[1]);
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          // Look up run's resourceId after confirming caller identity so cross-tenant access fails closed
          const configured = parseScopedCallerGrants(env.SCOPED_CALLER_GRANTS);
          const caller = await resolveScopedCaller(request, configured);
          if (!caller) return jsonResponse({ error: "unauthorized" }, 401);
          const runRow = await db
            .prepare("SELECT resource_id FROM ms_runs WHERE run_id = ? AND tenant_id = ?")
            .bind(runId, tenantId)
            .first<any>();
          if (!runRow) {
            // Check whether caller even has write access to tenant; if not -> 403
            const tenantCheck = authorizeScopedCaller(caller, { tenantId, resourceId: "*", action: "write" }, "measurement-pod");
            if (tenantCheck) return tenantCheck;
            return jsonResponse({ error: `Run '${runId}' not found` }, 404);
          }
          const denied = authorizeScopedCaller(caller, { tenantId, resourceId: runRow.resource_id, action: "write" }, "measurement-pod");
          if (denied) return denied;
          const attempt = await service.recordAttempt({ ...body, tenantId, runId } as any);
          return jsonResponse(attempt, 201);
        }

        // GET /api/measurement/runs/:runId
        const getRunMatch = url.pathname.match(/^\/api\/measurement\/runs\/([^/]+)$/);
        if (method === "GET" && getRunMatch) {
          const runId = decodeURIComponent(getRunMatch[1]);
          const tenantId = (url.searchParams.get("tenantId") || "").trim();
          const configured = parseScopedCallerGrants(env.SCOPED_CALLER_GRANTS);
          const caller = await resolveScopedCaller(request, configured);
          if (!caller) return jsonResponse({ error: "unauthorized" }, 401);
          const runRow = await db
            .prepare("SELECT resource_id FROM ms_runs WHERE run_id = ? AND tenant_id = ?")
            .bind(runId, tenantId)
            .first<any>();
          if (!runRow) {
            const tenantCheck = authorizeScopedCaller(caller, { tenantId, resourceId: "*", action: "read" }, "measurement-pod");
            if (tenantCheck) return tenantCheck;
            return jsonResponse({ error: `Run '${runId}' not found` }, 404);
          }
          const denied = authorizeScopedCaller(caller, { tenantId, resourceId: runRow.resource_id, action: "read" }, "measurement-pod");
          if (denied) return denied;
          const run = await service.getRun(tenantId, runId);
          return jsonResponse(run, 200);
        }

        // POST /api/measurement/ingest
        if (method === "POST" && url.pathname === "/api/measurement/ingest") {
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          const resourceId = typeof body.resourceId === "string" ? body.resourceId.trim() : "";
          const { denied } = await resolveAndAuthorize(request, env, { tenantId, resourceId, action: "write" });
          if (denied) return denied;
          const result = await service.ingestBatch(body as any);
          return jsonResponse(result, 200);
        }

        // POST /api/measurement/ingest-atomic (multi-group / up to 1,000 observations and 1,000 groups in one atomic transaction)
        if (method === "POST" && url.pathname === "/api/measurement/ingest-atomic") {
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          const configured = parseScopedCallerGrants(env.SCOPED_CALLER_GRANTS);
          const caller = await resolveScopedCaller(request, configured);
          if (!caller) return jsonResponse({ error: "unauthorized" }, 401);
          if (!tenantId) {
            return jsonResponse({ error: "Field 'tenantId' must be a non-empty string" }, 400);
          }
          if (!hasAnyTenantWriteGrant(caller, tenantId)) {
            return jsonResponse({ error: "forbidden" }, 403);
          }
          if (!Array.isArray(body.groups) || body.groups.length === 0 || body.groups.length > 1000) {
            const tenantDenied = authorizeScopedCaller(caller, { tenantId, resourceId: "*", action: "write" }, "measurement-pod");
            if (tenantDenied) return tenantDenied;
            return jsonResponse({ error: "Field 'groups' must contain 1 to 1000 items" }, 400);
          }
          const uniqueResourceIds = new Set<string>();
          for (let i = 0; i < body.groups.length; i++) {
            const g = body.groups[i];
            if (!g || typeof g !== "object" || Array.isArray(g)) {
              return jsonResponse({ error: `groups[${i}] must be a JSON object` }, 400);
            }
            const rid = typeof g.resourceId === "string" ? g.resourceId.trim() : "";
            if (!rid) {
              return jsonResponse({ error: `groups[${i}].resourceId must be a non-empty string` }, 400);
            }
            uniqueResourceIds.add(rid);
          }
          for (const rid of uniqueResourceIds) {
            const denied = authorizeScopedCaller(caller, { tenantId, resourceId: rid, action: "write" }, "measurement-pod");
            if (denied) return denied;
          }
          const result = await service.ingestAtomicBatch(body as any);
          return jsonResponse(result, 200);
        }

        // POST /api/measurement/imports/stage (stage an invisible chunk for all-or-nothing atomic finalization up to 20,000 obs)
        if (method === "POST" && url.pathname === "/api/measurement/imports/stage") {
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          const configured = parseScopedCallerGrants(env.SCOPED_CALLER_GRANTS);
          const caller = await resolveScopedCaller(request, configured);
          if (!caller) return jsonResponse({ error: "unauthorized" }, 401);
          if (!tenantId) {
            return jsonResponse({ error: "Field 'tenantId' must be a non-empty string" }, 400);
          }
          if (!hasAnyTenantWriteGrant(caller, tenantId)) {
            return jsonResponse({ error: "forbidden" }, 403);
          }
          if (!Array.isArray(body.groups) || body.groups.length === 0 || body.groups.length > 1000) {
            const tenantDenied = authorizeScopedCaller(caller, { tenantId, resourceId: "*", action: "write" }, "measurement-pod");
            if (tenantDenied) return tenantDenied;
            return jsonResponse({ error: "Field 'groups' must contain 1 to 1000 items" }, 400);
          }
          const uniqueResourceIds = new Set<string>();
          for (let i = 0; i < body.groups.length; i++) {
            const g = body.groups[i];
            if (!g || typeof g !== "object" || Array.isArray(g)) {
              return jsonResponse({ error: `groups[${i}] must be a JSON object` }, 400);
            }
            const rid = typeof g.resourceId === "string" ? g.resourceId.trim() : "";
            if (!rid) {
              return jsonResponse({ error: `groups[${i}].resourceId must be a non-empty string` }, 400);
            }
            uniqueResourceIds.add(rid);
          }
          for (const rid of uniqueResourceIds) {
            const denied = authorizeScopedCaller(caller, { tenantId, resourceId: rid, action: "write" }, "measurement-pod");
            if (denied) return denied;
          }
          const result = await service.stageImportChunk(body as any, Date.now(), {
            callerId: caller.callerId,
            authorizeResourceWrite: (rid: string) => {
              const denied = authorizeScopedCaller(caller, { tenantId, resourceId: rid, action: "write" }, "measurement-pod");
              if (denied) throw new ForbiddenError("forbidden");
            },
          });
          return jsonResponse(result, result.existing ? 200 : 201);
        }

        // POST /api/measurement/imports/:importId/commit (authorizes and commits the EXACT same read snapshot atomically)
        const commitImportMatch = url.pathname.match(/^\/api\/measurement\/imports\/([^/]+)\/commit$/);
        if (method === "POST" && commitImportMatch) {
          const importId = decodeURIComponent(commitImportMatch[1]);
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          const configured = parseScopedCallerGrants(env.SCOPED_CALLER_GRANTS);
          const caller = await resolveScopedCaller(request, configured);
          if (!caller) return jsonResponse({ error: "unauthorized" }, 401);
          if (!tenantId) {
            return jsonResponse({ error: "Field 'tenantId' must be a non-empty string" }, 400);
          }
          if (!hasAnyTenantWriteGrant(caller, tenantId)) {
            return jsonResponse({ error: "forbidden" }, 403);
          }
          const result = await service.commitStagedImport(
            {
              tenantId,
              importId,
              expectedChunks: body.expectedChunks,
            },
            Date.now(),
            {
              authorizeResourceWrite: (rid: string) => {
                const denied = authorizeScopedCaller(caller, { tenantId, resourceId: rid, action: "write" }, "measurement-pod");
                if (denied) throw new ForbiddenError("forbidden");
              },
            }
          );
          return jsonResponse(result, 200);
        }

        // POST /api/measurement/imports/:importId/abort (authorizes and discards ONLY the exact authorized snapshot rows)
        const abortImportMatch = url.pathname.match(/^\/api\/measurement\/imports\/([^/]+)\/abort$/);
        if (method === "POST" && abortImportMatch) {
          const importId = decodeURIComponent(abortImportMatch[1]);
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          const configured = parseScopedCallerGrants(env.SCOPED_CALLER_GRANTS);
          const caller = await resolveScopedCaller(request, configured);
          if (!caller) return jsonResponse({ error: "unauthorized" }, 401);
          if (!tenantId) {
            return jsonResponse({ error: "Field 'tenantId' must be a non-empty string" }, 400);
          }
          if (!hasAnyTenantWriteGrant(caller, tenantId)) {
            return jsonResponse({ error: "forbidden" }, 403);
          }
          const result = await service.abortStagedImport(tenantId, importId, {
            authorizeResourceWrite: (rid: string) => {
              const denied = authorizeScopedCaller(caller, { tenantId, resourceId: rid, action: "write" }, "measurement-pod");
              if (denied) throw new ForbiddenError("forbidden");
            },
          });
          return jsonResponse(result, 200);
        }

        // POST /api/measurement/annotations
        if (method === "POST" && url.pathname === "/api/measurement/annotations") {
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          const resourceId = typeof body.resourceId === "string" ? body.resourceId.trim() : "";
          const { denied } = await resolveAndAuthorize(request, env, { tenantId, resourceId, action: "write" });
          if (denied) return denied;
          const result = await service.annotateWork(body as any);
          return jsonResponse(result, 201);
        }

        // GET /api/measurement/series
        if (method === "GET" && url.pathname === "/api/measurement/series") {
          const tenantId = (url.searchParams.get("tenantId") || "").trim();
          const resourceId = (url.searchParams.get("resourceId") || "").trim();
          const metricId = (url.searchParams.get("metricId") || "").trim();
          const { denied } = await resolveAndAuthorize(request, env, { tenantId, resourceId, action: "read" });
          if (denied) return denied;
          const rawDims = url.searchParams.get("dimensions");
          let dimensions: Record<string, any> | undefined;
          if (rawDims) {
            try {
              dimensions = JSON.parse(rawDims);
            } catch {
              throw new ValidationError("Query param 'dimensions' must be valid JSON");
            }
          }
          const result = await service.querySeries({
            tenantId,
            resourceId,
            metricId,
            definitionVersion: url.searchParams.get("definitionVersion") || undefined,
            windowStart: url.searchParams.get("windowStart") || undefined,
            windowEnd: url.searchParams.get("windowEnd") || undefined,
            dimensions,
            includeSuperseded: url.searchParams.get("includeSuperseded") === "true",
            limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
            offset: url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined,
          });
          return jsonResponse(result, 200);
        }

        // GET /api/measurement/coverage
        if (method === "GET" && url.pathname === "/api/measurement/coverage") {
          const tenantId = (url.searchParams.get("tenantId") || "").trim();
          const resourceId = url.searchParams.get("resourceId")?.trim() || undefined;
          const { denied } = await resolveAndAuthorize(request, env, { tenantId, resourceId, action: "read" });
          if (denied) return denied;
          const result = await service.queryCoverage({
            tenantId,
            resourceId,
            source: url.searchParams.get("source") || undefined,
            limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
            offset: url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined,
          });
          return jsonResponse(result, 200);
        }

        // GET /api/measurement/evidence/:evidenceId (metadata only, never file bytes)
        const evMatch = url.pathname.match(/^\/api\/measurement\/evidence\/([^/]+)$/);
        if (method === "GET" && evMatch) {
          const evidenceId = decodeURIComponent(evMatch[1]);
          const tenantId = (url.searchParams.get("tenantId") || "").trim();
          const configured = parseScopedCallerGrants(env.SCOPED_CALLER_GRANTS);
          const caller = await resolveScopedCaller(request, configured);
          if (!caller) return jsonResponse({ error: "unauthorized" }, 401);
          const evRow = await db
            .prepare("SELECT resource_id FROM ms_evidence WHERE evidence_id = ? AND tenant_id = ?")
            .bind(evidenceId, tenantId)
            .first<any>();
          if (!evRow) {
            const tenantCheck = authorizeScopedCaller(caller, { tenantId, resourceId: "*", action: "read" }, "measurement-pod");
            if (tenantCheck) return tenantCheck;
            return jsonResponse({ error: `Evidence '${evidenceId}' not found` }, 404);
          }
          const denied = authorizeScopedCaller(caller, { tenantId, resourceId: evRow.resource_id, action: "read" }, "measurement-pod");
          if (denied) return denied;
          const meta = await service.getEvidenceMetadata(tenantId, evidenceId);
          return jsonResponse(meta, 200);
        }

        // GET /api/measurement/events?tenantId=...&since_cursor=... (Worldview-ready cursor delta feed)
        if (method === "GET" && url.pathname === "/api/measurement/events") {
          const tenantId = (url.searchParams.get("tenantId") || "").trim();
          const resourceId = url.searchParams.get("resourceId")?.trim() || undefined;
          const { denied } = await resolveAndAuthorize(request, env, { tenantId, resourceId, action: "read" });
          if (denied) return denied;
          const sinceCursor = Number(url.searchParams.get("since_cursor") || url.searchParams.get("sinceCursor") || "0");
          const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
          const result = await service.queryEvents({ tenantId, resourceId, sinceCursor, limit });
          return jsonResponse(result, 200);
        }

        return jsonResponse({ error: "Not found" }, 404);
      } catch (err) {
        return errorResponse(err);
      }
    }

    // 3. MCP v2 + Code Mode endpoint (/mcp or /api/mcp)
    //    Accepts either a valid scoped caller credential OR the hub token (individual domain tools still enforce scoped grants).
    if (url.pathname === "/mcp" || url.pathname === "/api/mcp") {
      if (method === "POST") {
        const hubDenied = authGate(request, env as any, "measurement-pod");
        if (hubDenied) {
          const configured = parseScopedCallerGrants(env.SCOPED_CALLER_GRANTS);
          const scoped = await resolveScopedCaller(request, configured);
          if (!scoped) return hubDenied;
        }
      }
      const mcpHandler = createMeasurementMcpHandler(env as any, config);
      return mcpHandler(request, env, ctx);
    }

    // 3b. Scoped Measurement Task Dispatch (/api/task)
    //     Runs BEFORE the hub-token-only operator gate so valid scoped callers can submit tasks,
    //     while ungranted hub tokens fail closed (401). Normalizes the payload once for both
    //     authorization and handler execution.
    if (method === "POST" && url.pathname === "/api/task") {
      try {
        const body = await parseJsonBody(request);
        const taskId = typeof body.taskId === "string" && body.taskId ? body.taskId : `task_${Date.now()}`;
        const topic = typeof body.topic === "string" && body.topic ? body.topic : "measurement.coverage";
        const source = typeof body.source === "string" && body.source ? body.source : "api";
        const rawSpec = body.spec && typeof body.spec === "object" && !Array.isArray(body.spec) ? body.spec : {};
        const normalizedPayload =
          rawSpec.payload && typeof rawSpec.payload === "object" && !Array.isArray(rawSpec.payload)
            ? rawSpec.payload
            : rawSpec;
        const action = rawSpec.action || (topic.includes(".") ? topic.split(".")[1] : "coverage");

        const isWriteAction = ["register", "register_resource", "define", "define_metric", "ingest", "record", "annotate"].includes(action);
        const requiredAction = isWriteAction ? "write" : "read";
        const targetTenantId = typeof normalizedPayload.tenantId === "string" ? normalizedPayload.tenantId.trim() : "";
        const targetResourceId =
          action === "define" || action === "define_metric"
            ? "*"
            : typeof normalizedPayload.resourceId === "string" && normalizedPayload.resourceId.trim()
              ? normalizedPayload.resourceId.trim()
              : undefined;

        const { caller, denied: taskDenied } = await resolveAndAuthorize(request, env, {
          tenantId: targetTenantId,
          resourceId: targetResourceId,
          action: requiredAction,
        });
        if (taskDenied) return taskDenied;

        const normalizedSpec = { action, payload: normalizedPayload };
        const now = Date.now();
        const leaseExpiresAt = now + 15 * 60 * 1000;
        const tincan = new TincanClient(config, env.FACTORY_HUB);

        const insertRes = await db
          .prepare(
            `INSERT INTO tasks (task_id, owner_id, topic, source, spec_json, status, lease_expires_at, retry_count, max_retries, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'running', ?, 0, 3, ?, ?)`
          )
          .bind(taskId, caller.callerId, topic, source, JSON.stringify(normalizedSpec), leaseExpiresAt, now, now)
          .run();

        const taskRecord: TaskRecord = {
          id: Number(insertRes.meta.last_row_id || 0),
          taskId,
          topic,
          source,
          spec: normalizedSpec,
          status: "running",
          leaseExpiresAt,
          retryCount: 0,
          maxRetries: 3,
          createdAt: now,
          updatedAt: now,
        };

        try {
          const result = await activeHandler.handle(taskRecord, {
            podConfig: config,
            now,
            storage: db,
            publishEvent: async (evTopic, toPod, payload) => {
              await tincan.publish(evTopic, toPod, payload);
            },
          });

          await db
            .prepare("UPDATE tasks SET status = 'completed', result_json = ?, lease_expires_at = NULL, updated_at = ? WHERE task_id = ?")
            .bind(JSON.stringify(result), Date.now(), taskId)
            .run();

          return jsonResponse({ success: true, taskId, status: "completed", result }, 200);
        } catch (execErr: any) {
          await db
            .prepare("UPDATE tasks SET status = 'failed', error_message = ?, lease_expires_at = NULL, updated_at = ? WHERE task_id = ?")
            .bind(execErr?.message || String(execErr), Date.now(), taskId)
            .run();
          return errorResponse(execErr);
        }
      } catch (err) {
        return errorResponse(err);
      }
    }

    // 4. Operator Cockpit & Hub Mesh routes — protected by shared kernel authGate
    const denied = authGate(request, env as any, "measurement-pod");
    if (denied) return denied;

    const tincan = new TincanClient(config, env.FACTORY_HUB);

    if ((method === "GET" || method === "HEAD") && (url.pathname === "/" || url.pathname === "/index.html")) {
      const snapshot = await service.getCockpitSnapshot();
      const tasks = await getTasks(db, 30);
      const hbRow = await db.prepare("SELECT value_json FROM pod_info WHERE key = 'heartbeat'").first<any>();
      const lastHb = hbRow?.value_json ? JSON.parse(hbRow.value_json) : null;
      const html = renderPodUiHtml(config, snapshot, tasks, lastHb);
      return new Response(method === "HEAD" ? null : html, {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (method === "GET" && url.pathname === "/api/tasks") {
      const limit = Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50;
      const tasks = await getTasks(db, Math.min(Math.max(limit, 1), 100));
      return jsonResponse({ tasks }, 200);
    }

    if (url.pathname === "/api/heartbeat") {
      if (method === "GET") {
        const row = await db.prepare("SELECT value_json FROM pod_info WHERE key = 'heartbeat'").first<any>();
        const parsed = row?.value_json ? JSON.parse(row.value_json) : null;
        return jsonResponse({
          status: "healthy",
          podId: config.id,
          heartbeat: parsed || { status: "healthy", lastHeartbeat: Date.now(), deliveredToHub: false, hubUrl: config.hubUrl },
        });
      }
      if (method === "POST") {
        const ok = await tincan.sendHeartbeat();
        const now = Date.now();
        await recordPodHeartbeat(db, config.id, {
          status: "healthy",
          lastHeartbeat: now,
          hubUrl: config.hubUrl,
          deliveredToHub: ok,
          role: config.role,
          capabilities: config.capabilities,
        });
        return jsonResponse({ success: true, status: "healthy", podId: config.id, deliveredToHub: ok, lastHeartbeat: now });
      }
    }

    return jsonResponse({ error: "Not found" }, 404);
  },

  async scheduled(_event: any, env: Env): Promise<void> {
    const config = loadPodConfig(env as any);
    const tincan = new TincanClient(config, env.FACTORY_HUB);
    const db: PodStorage = toPodStorage(env.DB);

    const hbOk = await tincan.sendHeartbeat();
    await recordPodHeartbeat(db, config.id, {
      status: "healthy",
      lastHeartbeat: Date.now(),
      hubUrl: config.hubUrl,
      deliveredToHub: hbOk,
      role: config.role,
      capabilities: config.capabilities,
    });

    // Sweep expired task leases
    const now = Date.now();
    await db
      .prepare(
        `UPDATE tasks
         SET status = CASE WHEN retry_count < max_retries THEN 'pending' ELSE 'failed' END,
             error_message = 'Task execution lease expired',
             retry_count = retry_count + 1,
             lease_expires_at = NULL,
             updated_at = ?
         WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`
      )
      .bind(now, now)
      .run();

    // Poll Tincan inbox for assigned measurement tasks
    const messages = await tincan.pollInbox(5);
    for (const msg of messages) {
      if (msg.topic === "task.assigned" && msg.payload) {
        const taskId = msg.payload.taskId || msg.id;
        const ts = Date.now();
        await db
          .prepare(
            `INSERT INTO tasks (task_id, topic, source, spec_json, status, lease_expires_at, retry_count, max_retries, created_at, updated_at)
             VALUES (?, ?, 'factory-hub-mesh', ?, 'running', ?, 0, 3, ?, ?)
             ON CONFLICT(task_id) DO NOTHING`
          )
          .bind(taskId, msg.topic, JSON.stringify(msg.payload.spec || msg.payload), ts + 15 * 60 * 1000, ts, ts)
          .run();

        try {
          const result = await activeHandler.handle(
            {
              id: 0,
              taskId,
              topic: msg.topic,
              source: "factory-hub-mesh",
              spec: msg.payload.spec || msg.payload,
              status: "running",
              retryCount: 0,
              maxRetries: 3,
              createdAt: ts,
              updatedAt: ts,
            },
            {
              podConfig: config,
              now: ts,
              storage: db,
              publishEvent: async (evTopic, toPod, pl) => {
                await tincan.publish(evTopic, toPod, pl);
              },
            }
          );
          await db
            .prepare("UPDATE tasks SET status = 'completed', result_json = ?, lease_expires_at = NULL, updated_at = ? WHERE task_id = ?")
            .bind(JSON.stringify(result), Date.now(), taskId)
            .run();
        } catch (err: any) {
          await db
            .prepare("UPDATE tasks SET status = 'failed', error_message = ?, lease_expires_at = NULL, updated_at = ? WHERE task_id = ?")
            .bind(err?.message || "Execution error", Date.now(), taskId)
            .run();
        }
        await tincan.acknowledge(msg.id);
      }
    }
  },
};

async function getTasks(db: PodStorage, limit = 50): Promise<TaskRecord[]> {
  try {
    const res = await db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").bind(limit).all<any>();
    return (res.results || []).map((r) => ({
      id: r.id,
      taskId: r.task_id,
      topic: r.topic,
      source: r.source,
      spec: JSON.parse(r.spec_json || "{}"),
      status: r.status,
      result: r.result_json ? JSON.parse(r.result_json) : undefined,
      errorMessage: r.error_message,
      leaseExpiresAt: r.lease_expires_at,
      retryCount: r.retry_count,
      maxRetries: r.max_retries,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  } catch {
    return [];
  }
}

async function recordPodHeartbeat(db: PodStorage, podId: string, info: Record<string, any>): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO pod_info (key, value_json, updated_at)
       VALUES ('heartbeat', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    )
    .bind(JSON.stringify({ podId, ...info, updatedAt: now }), now)
    .run();
}
