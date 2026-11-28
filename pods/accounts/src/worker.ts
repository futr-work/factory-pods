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
import { createAccountsMcpHandler } from "./mcp.js";
import {
  AccountsService,
  ConflictError,
  ensureAccountsSchemaReady,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "./service.js";
import { renderPodUiHtml } from "./ui.js";
import { assertNoEmbeddedSecretPayload, redactSecrets } from "./vault/adapters.js";
import type { AssetKind, TaskRecord } from "./types.js";

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

function errorResponse(err: unknown): Response {
  if (err instanceof ValidationError) return jsonResponse({ error: redactSecrets(err.message) }, 400);
  if (err instanceof ForbiddenError) return jsonResponse({ error: redactSecrets(err.message) }, 403);
  if (err instanceof ConflictError) return jsonResponse({ error: redactSecrets(err.message) }, 409);
  if (err instanceof NotFoundError) return jsonResponse({ error: redactSecrets(err.message) }, 404);
  return jsonResponse({ error: "Internal server error" }, 500);
}

const ALLOWED_TASK_BODY_KEYS = new Set(["taskId", "topic", "spec"]);
const ALLOWED_TASK_SPEC_KEYS = new Set([
  "action",
  "payload",
  "tenantId",
  "assetId",
  "assetKind",
  "provider",
  "brandGroup",
  "expectedProviders",
  "accountId",
  "connectionId",
  "autoCreateAssets",
  "items",
]);

function sanitizeHttpTaskRequest(body: Record<string, any>): {
  taskId: string;
  topic: string;
  action: string;
  tenantId: string;
  assetId?: string;
  isWrite: boolean;
  spec: Record<string, unknown>;
} {
  try {
    assertNoEmbeddedSecretPayload(body, "task");
  } catch (err: any) {
    throw new ValidationError(err?.message || "Task payload contains forbidden secret material");
  }
  for (const k of Object.keys(body)) {
    if (!ALLOWED_TASK_BODY_KEYS.has(k)) {
      throw new ValidationError("Unsupported task field");
    }
  }
  const rawSpec = body.spec;
  if (!rawSpec || typeof rawSpec !== "object" || Array.isArray(rawSpec)) {
    throw new ValidationError("Task spec must be an object");
  }
  for (const k of Object.keys(rawSpec)) {
    if (!ALLOWED_TASK_SPEC_KEYS.has(k)) {
      throw new ValidationError("Unsupported task spec field");
    }
  }
  if (rawSpec.payload !== undefined) {
    if (!rawSpec.payload || typeof rawSpec.payload !== "object" || Array.isArray(rawSpec.payload)) {
      throw new ValidationError("Task spec.payload must be an object");
    }
    for (const k of Object.keys(rawSpec.payload)) {
      if (!ALLOWED_TASK_SPEC_KEYS.has(k)) {
        throw new ValidationError("Unsupported task payload field");
      }
    }
  }
  const topic = typeof body.topic === "string" && body.topic.trim() ? body.topic.trim() : "accounts.matrix";
  const payload = rawSpec.payload && typeof rawSpec.payload === "object" ? rawSpec.payload : rawSpec;
  const action =
    typeof rawSpec.action === "string"
      ? rawSpec.action.trim()
      : topic.includes(".")
        ? topic.split(".")[1].trim()
        : "";
  if (!["who_owns", "overlaps", "gaps", "discover", "ingest_discovery", "matrix"].includes(action)) {
    throw new ValidationError("Unsupported accounts task action");
  }
  const tenantId = typeof payload.tenantId === "string" ? payload.tenantId.trim() : "";
  if (!tenantId) {
    throw new ValidationError("Scoped accounts task requires an explicit tenantId");
  }
  const assetId = typeof payload.assetId === "string" && payload.assetId.trim() ? payload.assetId.trim() : undefined;
  if (action === "who_owns" && !assetId) {
    throw new ValidationError("who_owns task requires an explicit assetId");
  }
  const isWrite = action === "discover" || action === "ingest_discovery";
  const taskId = typeof body.taskId === "string" && body.taskId.trim() ? body.taskId.trim() : `task_${Date.now()}`;
  const normalizedPayload = { ...payload, tenantId, ...(assetId ? { assetId } : {}) };
  delete (normalizedPayload as any).action;
  delete (normalizedPayload as any).payload;
  const normalizedSpec = { action, payload: normalizedPayload };
  return { taskId, topic, action, tenantId, assetId, isWrite, spec: normalizedSpec };
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
 * Authorize account registry domain routes strictly via scoped caller credentials & server-side grants.
 * A shared FACTORY_HUB_TOKEN alone NEVER grants tenant data access (fails closed).
 */
async function resolveAndAuthorize(
  request: Request,
  env: Env,
  req: { tenantId: string; resourceId?: string; action: string }
): Promise<{ caller: ResolvedCaller; denied: null } | { caller: null; denied: Response }> {
  const configured = parseScopedCallerGrants(env.SCOPED_CALLER_GRANTS);
  const caller = await resolveScopedCaller(request, configured);
  const denied = authorizeScopedCaller(caller, req, "accounts-pod");
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

    // 1. Open liveness probe only (zero tenant data)
    if (url.pathname === "/health") {
      return jsonResponse({
        status: "healthy",
        podId: config.id,
        name: config.name,
        role: config.role,
        lob: config.lob,
        mcpVersion: "2026-07-28",
        codeMode: true,
        zeroSecretControlPlane: true,
        timestamp: Date.now(),
      });
    }

    const storage = toPodStorage(env.DB);
    await ensureAccountsSchemaReady(storage);
    const service = new AccountsService(storage);

    // 2. MCP v2 + Code Mode endpoint (enforces per-tool scoped caller grants internally)
    if (url.pathname === "/mcp") {
      const configured = parseScopedCallerGrants(env.SCOPED_CALLER_GRANTS);
      const scoped = await resolveScopedCaller(request, configured);
      if (!scoped) {
        const hubDenied = authGate(request, env as any, "accounts-pod");
        if (hubDenied) return hubDenied;
      }
      const mcpHandler = createAccountsMcpHandler(env as any, config);
      return mcpHandler(request, env, ctx);
    }

    // 3. Operator Cockpit UI (protected by FACTORY_HUB_TOKEN)
    if (method === "GET" && (url.pathname === "/" || url.pathname === "/ui")) {
      const denied = authGate(request, env as any, "accounts-pod");
      if (denied) return denied;
      const [snapshot, tasksRes, hbRow] = await Promise.all([
        service.getCockpitCounts(),
        storage.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 20").all<any>(),
        storage.prepare("SELECT * FROM heartbeats ORDER BY id DESC LIMIT 1").first<any>(),
      ]);
      const tasks: TaskRecord[] = (tasksRes.results || []).map((r) => ({
        taskId: String(r.task_id),
        ownerId: String(r.owner_id || "hub"),
        topic: String(r.topic),
        source: String(r.source),
        spec: JSON.parse(String(r.spec_json || "{}")),
        status: String(r.status),
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
      }));
      return new Response(renderPodUiHtml(config, snapshot, tasks, hbRow), {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // 4. Scoped Accounts Domain API (/api/accounts/*)
    if (url.pathname.startsWith("/api/accounts/")) {
      try {
        const now = Date.now();

        // Vault backends
        if (url.pathname === "/api/accounts/vault-backends" && method === "POST") {
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          const auth = await resolveAndAuthorize(request, env, { tenantId, action: "write" });
          if (auth.denied) return auth.denied;
          const record = await service.upsertVaultBackend(body as any, auth.caller.callerId, now);
          return jsonResponse(record, 201);
        }
        if (url.pathname === "/api/accounts/vault-backends" && method === "GET") {
          const tenantId = (url.searchParams.get("tenantId") || "").trim();
          const auth = await resolveAndAuthorize(request, env, { tenantId, action: "read" });
          if (auth.denied) return auth.denied;
          const items = await service.listVaultBackends(tenantId);
          return jsonResponse({ tenantId, items });
        }

        // Principals
        if (url.pathname === "/api/accounts/principals" && method === "POST") {
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          const auth = await resolveAndAuthorize(request, env, { tenantId, action: "write" });
          if (auth.denied) return auth.denied;
          const record = await service.upsertPrincipal(body as any, auth.caller.callerId, now);
          return jsonResponse(record, 201);
        }
        if (url.pathname === "/api/accounts/principals" && method === "GET") {
          const tenantId = (url.searchParams.get("tenantId") || "").trim();
          const auth = await resolveAndAuthorize(request, env, { tenantId, action: "read" });
          if (auth.denied) return auth.denied;
          const items = await service.listPrincipals(tenantId);
          return jsonResponse({ tenantId, items });
        }

        // Provider accounts
        if (url.pathname === "/api/accounts/provider-accounts" && method === "POST") {
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          const auth = await resolveAndAuthorize(request, env, { tenantId, action: "write" });
          if (auth.denied) return auth.denied;
          const record = await service.upsertProviderAccount(body as any, auth.caller.callerId, now);
          return jsonResponse(record, 201);
        }
        if (url.pathname === "/api/accounts/provider-accounts" && method === "GET") {
          const tenantId = (url.searchParams.get("tenantId") || "").trim();
          const provider = (url.searchParams.get("provider") || "").trim() || undefined;
          const auth = await resolveAndAuthorize(request, env, { tenantId, action: "read" });
          if (auth.denied) return auth.denied;
          const items = await service.listProviderAccounts(tenantId, provider);
          return jsonResponse({ tenantId, items });
        }

        // Connections & atomic vault switching
        if (url.pathname === "/api/accounts/connections" && method === "POST") {
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          const auth = await resolveAndAuthorize(request, env, { tenantId, action: "write" });
          if (auth.denied) return auth.denied;
          const record = await service.upsertConnection(body as any, auth.caller.callerId, now);
          return jsonResponse(record, 201);
        }
        if (url.pathname === "/api/accounts/connections" && method === "GET") {
          const tenantId = (url.searchParams.get("tenantId") || "").trim();
          const accountId = (url.searchParams.get("accountId") || "").trim() || undefined;
          const auth = await resolveAndAuthorize(request, env, { tenantId, action: "read" });
          if (auth.denied) return auth.denied;
          const items = await service.listConnections(tenantId, accountId);
          return jsonResponse({ tenantId, items });
        }
        const switchMatch = url.pathname.match(/^\/api\/accounts\/connections\/([^/]+)\/switch-vault$/);
        if (switchMatch && method === "POST") {
          const connectionId = decodeURIComponent(switchMatch[1]);
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          const auth = await resolveAndAuthorize(request, env, { tenantId, action: "write" });
          if (auth.denied) return auth.denied;
          const record = await service.switchConnectionVault({ ...(body as any), tenantId, connectionId }, auth.caller.callerId, now);
          return jsonResponse(record, 200);
        }

        // Assets
        if (url.pathname === "/api/accounts/assets" && method === "POST") {
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          const assetId = typeof body.assetId === "string" ? body.assetId.trim() : undefined;
          const auth = await resolveAndAuthorize(request, env, { tenantId, resourceId: assetId, action: "write" });
          if (auth.denied) return auth.denied;
          const record = await service.upsertAsset(body as any, auth.caller.callerId, now);
          return jsonResponse(record, 201);
        }
        if (url.pathname === "/api/accounts/assets" && method === "GET") {
          const tenantId = (url.searchParams.get("tenantId") || "").trim();
          const assetKind = ((url.searchParams.get("assetKind") || "").trim() || undefined) as AssetKind | undefined;
          const auth = await resolveAndAuthorize(request, env, { tenantId, action: "read" });
          if (auth.denied) return auth.denied;
          const items = await service.listAssets(tenantId, assetKind);
          return jsonResponse({ tenantId, items });
        }

        // Bindings & canonical selection
        if (url.pathname === "/api/accounts/bindings" && method === "POST") {
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          const assetId = typeof body.assetId === "string" ? body.assetId.trim() : undefined;
          const auth = await resolveAndAuthorize(request, env, { tenantId, resourceId: assetId, action: "write" });
          if (auth.denied) return auth.denied;
          const record = await service.upsertBinding(body as any, auth.caller.callerId, now);
          return jsonResponse(record, 201);
        }
        const canonicalMatch = url.pathname.match(/^\/api\/accounts\/bindings\/([^/]+)\/canonical$/);
        if (canonicalMatch && method === "POST") {
          const bindingId = decodeURIComponent(canonicalMatch[1]);
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          const auth = await resolveAndAuthorize(request, env, { tenantId, action: "write" });
          if (auth.denied) return auth.denied;
          const record = await service.setCanonicalBinding(tenantId, bindingId, auth.caller.callerId, now);
          return jsonResponse(record, 200);
        }

        // Discovery ingestion
        if (url.pathname === "/api/accounts/discover" && method === "POST") {
          const body = await parseJsonBody(request);
          const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
          const auth = await resolveAndAuthorize(request, env, { tenantId, action: "write" });
          if (auth.denied) return auth.denied;
          const result = await service.ingestDiscovery(body as any, auth.caller.callerId, now);
          return jsonResponse(result, 200);
        }

        // Anti-blindness query endpoints
        if (url.pathname === "/api/accounts/who-owns" && method === "GET") {
          const tenantId = (url.searchParams.get("tenantId") || "").trim();
          const assetId = (url.searchParams.get("assetId") || "").trim();
          const expectedRaw = (url.searchParams.get("expectedProviders") || "").trim();
          const expectedProviders = expectedRaw ? expectedRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
          const auth = await resolveAndAuthorize(request, env, { tenantId, resourceId: assetId || undefined, action: "read" });
          if (auth.denied) return auth.denied;
          const result = await service.whoOwns(tenantId, assetId, expectedProviders);
          return jsonResponse(result, 200);
        }

        if (url.pathname === "/api/accounts/matrix" && method === "GET") {
          const tenantId = (url.searchParams.get("tenantId") || "").trim();
          const assetKind = ((url.searchParams.get("assetKind") || "").trim() || undefined) as AssetKind | undefined;
          const provider = (url.searchParams.get("provider") || "").trim() || undefined;
          const brandGroup = (url.searchParams.get("brandGroup") || "").trim() || undefined;
          const auth = await resolveAndAuthorize(request, env, { tenantId, action: "read" });
          if (auth.denied) return auth.denied;
          const result = await service.queryMatrix({ tenantId, assetKind, provider, brandGroup });
          return jsonResponse(result, 200);
        }

        if (url.pathname === "/api/accounts/overlaps-and-gaps" && method === "GET") {
          const tenantId = (url.searchParams.get("tenantId") || "").trim();
          const assetKind = ((url.searchParams.get("assetKind") || "").trim() || undefined) as AssetKind | undefined;
          const expectedRaw = (url.searchParams.get("expectedProviders") || "").trim();
          const expectedProviders = expectedRaw
            ? expectedRaw.split(",").map((s) => s.trim()).filter(Boolean)
            : ["gsc", "bing_webmaster"];
          const auth = await resolveAndAuthorize(request, env, { tenantId, action: "read" });
          if (auth.denied) return auth.denied;
          const result = await service.queryOverlapsAndGaps(tenantId, expectedProviders, assetKind);
          return jsonResponse(result, 200);
        }

        if (url.pathname === "/api/accounts/audit" && method === "GET") {
          const tenantId = (url.searchParams.get("tenantId") || "").trim();
          const sinceSeq = Number.parseInt(url.searchParams.get("sinceSeq") || "0", 10) || 0;
          const limit = Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100;
          const auth = await resolveAndAuthorize(request, env, { tenantId, action: "read" });
          if (auth.denied) return auth.denied;
          const events = await service.queryAuditEvents(tenantId, sinceSeq, limit);
          return jsonResponse({ tenantId, events }, 200);
        }

        return jsonResponse({ error: "Not found" }, 404);
      } catch (err) {
        return errorResponse(err);
      }
    }

    // 5. Scoped task execution endpoint (strictly requires scoped caller tenant/resource/action grant; hub token alone fails closed)
    if (url.pathname === "/api/tasks" && method === "POST") {
      try {
        const body = await parseJsonBody(request);
        const taskInput = sanitizeHttpTaskRequest(body);
        const auth = await resolveAndAuthorize(request, env, {
          tenantId: taskInput.tenantId,
          resourceId: taskInput.action === "who_owns" ? taskInput.assetId : undefined,
          action: taskInput.isWrite ? "write" : "read",
        });
        if (auth.denied) return auth.denied;

        const now = Date.now();
        await storage
          .prepare(
            `INSERT INTO tasks (task_id, owner_id, topic, source, spec_json, status, created_at, updated_at)
             VALUES (?, ?, ?, 'api', ?, 'running', ?, ?)`
          )
          .bind(taskInput.taskId, auth.caller.callerId, taskInput.topic, JSON.stringify(taskInput.spec), now, now)
          .run();

        const tincan = new TincanClient(config, env.FACTORY_HUB);
        const output = await activeHandler.handle(
          {
            taskId: taskInput.taskId,
            ownerId: auth.caller.callerId,
            topic: taskInput.topic,
            source: "api",
            spec: taskInput.spec,
            status: "running",
            createdAt: now,
            updatedAt: now,
          },
          {
            podConfig: config,
            now,
            storage,
            publishEvent: (t, target, payload) => tincan.publish(t, target, payload),
          }
        );
        await storage
          .prepare("UPDATE tasks SET status = 'completed', result_json = ?, updated_at = ? WHERE task_id = ?")
          .bind(JSON.stringify(output), Date.now(), taskInput.taskId)
          .run();
        return jsonResponse(output, 200);
      } catch (err) {
        return errorResponse(err);
      }
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
