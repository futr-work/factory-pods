// @futr-work/pod-kernel: Edge-native Cloudflare Workers MCP v2 Server + Code Mode
// Implements stateless JSON-RPC 2.0 Model Context Protocol (2026-07-28 default, 2024-11-05 compatible)
// with Cloudflare Code Mode (`search` + `execute` isolated SDK execution).
// Runs natively in Cloudflare Workers V8 isolates (with Dynamic Worker Loader), Bun, and Node.js.

import type { PodReceipt } from "./types.js";

export const MCP_V2_PROTOCOL_VERSION = "2026-07-28";
export const MCP_V1_PROTOCOL_VERSION = "2024-11-05";
export const SUPPORTED_PROTOCOL_VERSIONS = [MCP_V2_PROTOCOL_VERSION, MCP_V1_PROTOCOL_VERSION] as const;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface McpToolProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: Record<string, any>;
  properties?: Record<string, any>;
  required?: string[];
  [key: string]: any;
}

export interface McpToolInputSchema {
  type: "object";
  properties: Record<string, McpToolProperty>;
  required?: string[];
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
  handler: (args: any, context: McpToolContext) => Promise<any> | any;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  read: (context: McpToolContext) => Promise<{ text?: string; blob?: string; mimeType?: string }> | { text?: string; blob?: string; mimeType?: string };
}

/**
 * MCP 2026-07-28 `io.modelcontextprotocol/tasks` extension wire types.
 */
export interface McpTaskSummary {
  taskId: string;
  status: string;
  createdAt?: string;
  lastUpdatedAt?: string;
  ttl?: number | null;
  pollInterval?: number;
  statusMessage?: string;
  [key: string]: any;
}

export interface McpTaskDetail extends McpTaskSummary {
  resultType?: "complete" | "pending" | "failed" | "cancelled";
}

export interface McpTasksExtension {
  list: (
    params: { limit?: number; cursor?: string },
    context: McpToolContext
  ) => Promise<{ tasks: McpTaskSummary[]; nextCursor?: string }> | { tasks: McpTaskSummary[]; nextCursor?: string };
  get: (
    params: { taskId: string },
    context: McpToolContext
  ) => Promise<McpTaskDetail | null> | McpTaskDetail | null;
  cancel?: (
    params: { taskId: string },
    context: McpToolContext
  ) => Promise<McpTaskDetail> | McpTaskDetail;
}

export interface CodeModeSpecEntry {
  name: string;
  method: string;
  description: string;
  signature: string;
  tags?: string[];
}

export type CodeModeExecutor = (
  code: string,
  sdk: Record<string, (...args: any[]) => Promise<any> | any>,
  options: { timeoutMs: number; env?: any }
) => Promise<any>;

/**
 * Cloudflare Dynamic Worker Loader binding shape (`env.LOADER` / `env.CODE_LOADER`).
 */
export interface DynamicWorkerLoaderLike {
  get: (
    id: string,
    getCode: () => Promise<{
      compatibilityDate: string;
      mainModule: string;
      modules: Record<string, string>;
      globalOutbound?: null;
      env?: Record<string, any>;
    }>
  ) => {
    getEntrypoint: () => {
      fetch: (request: Request) => Promise<Response>;
    };
  };
}

export interface CodeModeOptions {
  /** Human- and agent-readable typed SDK entries searchable via `search(query)`. */
  spec: CodeModeSpecEntry[];
  /** Builds the caller-scoped SDK methods injected as `pod` inside `execute(code)`. */
  createSdk: (context: McpToolContext) => Record<string, (...args: any[]) => Promise<any> | any>;
  /**
   * Optional custom sandbox executor.
   * When omitted:
   *  - If `env[workerLoaderBinding]` (default `"CODE_LOADER"`) is present (Cloudflare Workers Dynamic Worker Loader),
   *    executes inside a fresh network-disabled Dynamic Worker isolate with a serialized RPC bridge.
   *  - Otherwise in Node.js, executes inside a dedicated, terminable `worker_threads` Worker with a serialized
   *    JSON-only `MessagePort` SDK bridge, `process.env` cleared, external network disabled, and hard `.terminate()`
   *    plus SDK revocation on timeout.
   */
  executor?: CodeModeExecutor;
  /** Cloudflare Worker binding name for the Dynamic Worker Loader (default: "CODE_LOADER"). */
  workerLoaderBinding?: string;
  /** Maximum execution timeout in milliseconds (default: 2000, hard cap: 10000). */
  timeoutMs?: number;
  /** Maximum source code length in bytes (default: 16384). */
  maxCodeBytes?: number;
}

export interface McpToolContext {
  request: Request;
  env?: any;
  podName: string;
  podRole?: string;
  now: number;
  protocolVersion: string;
}

export interface CorePodHandlers {
  onSubmitTask?: (params: {
    repo: string;
    issue: number;
    requestId: string;
    remote?: string;
    title?: string;
    body?: string;
  }, context: McpToolContext) => Promise<{ taskId: string; requestId: string; phase: string; status: string; existing?: boolean }>;

  onTaskStatus?: (params: {
    taskId?: string | number;
    requestId?: string;
  }, context: McpToolContext) => Promise<{ taskId: string; phase: string; status: string; checks?: string[]; diffHash?: string; error?: string }>;

  onApprove?: (params: {
    taskId: string | number;
    decision: "approve" | "reject";
  }, context: McpToolContext) => Promise<{ ok: boolean; decision: string }>;

  onCancel?: (params: {
    taskId: string | number;
  }, context: McpToolContext) => Promise<{ ok: boolean; status: string }>;

  onGetReceipt?: (params: {
    taskId: string | number;
  }, context: McpToolContext) => Promise<PodReceipt>;
}

export interface EdgeMcpServerOptions {
  podName: string;
  podRole?: string;
  version?: string;
  bearerToken?: string;
  tools?: McpToolDefinition[];
  coreHandlers?: CorePodHandlers;
  resources?: McpResourceDefinition[];
  tasks?: McpTasksExtension;
  codeMode?: CodeModeOptions;
  /** Default protocol version (defaults to MCP v2 "2026-07-28"). */
  defaultProtocolVersion?: string;
  authGate?: (request: Request) => boolean | Promise<boolean>;
}

function isSupportedProtocolVersion(v: string): boolean {
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(v);
}

function validateVersionHeader(
  request: Request,
  fallback: string
): { ok: true; version: string; explicit: boolean } | { ok: false; status: number; message: string } {
  const header = request.headers.get("MCP-Protocol-Version") || request.headers.get("Mcp-Version");
  if (!header) {
    return { ok: true, version: fallback, explicit: false };
  }
  const trimmed = header.trim();
  if (!isSupportedProtocolVersion(trimmed)) {
    return {
      ok: false,
      status: 400,
      message: `Unsupported MCP protocol version '${trimmed}'. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
    };
  }
  return { ok: true, version: trimmed, explicit: true };
}

/**
 * Validate MCP Streamable HTTP routing headers against the JSON-RPC body before dispatch.
 * Rejects mismatches (e.g. header claiming `tools/list` while body invokes `tools/call`) with HTTP 400.
 */
function validateRoutingHeaders(
  request: Request,
  body: any
): { ok: true } | { ok: false; status: number; message: string } {
  const methodHeader = request.headers.get("MCP-Method") || request.headers.get("X-MCP-Method");
  const toolHeader = request.headers.get("MCP-Tool-Name") || request.headers.get("X-MCP-Tool");

  if (!methodHeader && !toolHeader) return { ok: true };

  if (Array.isArray(body)) {
    return {
      ok: false,
      status: 400,
      message: "MCP routing headers (MCP-Method / MCP-Tool-Name) cannot be used with batch requests",
    };
  }

  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, message: "Invalid JSON-RPC body for MCP routing header validation" };
  }

  if (methodHeader && body.method !== methodHeader.trim()) {
    return {
      ok: false,
      status: 400,
      message: `MCP routing header mismatch: header declares method '${methodHeader.trim()}' but body invokes '${String(body.method)}'`,
    };
  }

  if (toolHeader) {
    const bodyTool = body.params && typeof body.params === "object" ? body.params.name : undefined;
    if (body.method !== "tools/call" || bodyTool !== toolHeader.trim()) {
      return {
        ok: false,
        status: 400,
        message: `MCP routing header mismatch: header declares tool '${toolHeader.trim()}' but body invokes '${String(bodyTool)}'`,
      };
    }
  }

  return { ok: true };
}

/**
 * Cloudflare Dynamic Worker Loader Code Mode executor.
 * Spins up an isolated V8 worker with `globalOutbound: null` (external network disabled) and
 * bridges `pod.*` calls over a narrow JSON-only Service Binding RPC that revokes access on timeout.
 */
export async function executeInDynamicWorkerLoader(
  loader: DynamicWorkerLoaderLike,
  code: string,
  sdk: Record<string, (...args: any[]) => Promise<any> | any>,
  options: { timeoutMs: number }
): Promise<any> {
  const methodNames = Object.keys(sdk).filter((k) => typeof sdk[k] === "function");
  let revoked = false;

  const rpcBridge = {
    async fetch(req: Request): Promise<Response> {
      if (revoked) {
        return new Response(JSON.stringify({ error: "Code Mode execution deadline expired; SDK access revoked" }), {
          status: 408,
          headers: { "Content-Type": "application/json" },
        });
      }
      try {
        const { method, args } = (await req.json()) as { method: string; args: any[] };
        if (!methodNames.includes(method)) {
          return new Response(JSON.stringify({ error: `Unknown SDK method: ${method}` }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        const safeArgs = Array.isArray(args) ? JSON.parse(JSON.stringify(args)) : [];
        const result = await sdk[method](...safeArgs);
        if (revoked) {
          return new Response(JSON.stringify({ error: "Code Mode execution deadline expired; SDK access revoked" }), {
            status: 408,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true, result: result ?? null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err?.message || "SDK call failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    },
  };

  const runId = `codemode-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const workerModule = `
export default {
  async fetch(request, env) {
    const methods = ${JSON.stringify(methodNames)};
    const pod = Object.create(null);
    for (const m of methods) {
      pod[m] = async (...args) => {
        const res = await env.POD_SDK.fetch("https://pod-sdk.internal/call", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: m, args }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || "SDK call failed");
        return data.result;
      };
    }
    Object.freeze(pod);
    try {
      const result = await (async (pod) => {
        ${code}
      })(pod);
      return new Response(JSON.stringify({ ok: true, result: result ?? null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
};
`;

  const worker = loader.get(runId, async () => ({
    compatibilityDate: "2024-11-01",
    mainModule: "index.mjs",
    modules: { "index.mjs": workerModule },
    globalOutbound: null,
    env: { POD_SDK: rpcBridge },
  }));

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const execPromise = worker
      .getEntrypoint()
      .fetch(new Request("https://sandbox.internal/run", { method: "POST" }))
      .then(async (resp) => {
        const data = (await resp.json()) as any;
        if (!resp.ok || data.ok === false) {
          throw new Error(data.error || "Code Mode execution failed");
        }
        return data.result;
      });
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        revoked = true;
        reject(new Error(`Code Mode execution timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
    });
    return await Promise.race([execPromise, timeoutPromise]);
  } finally {
    revoked = true;
    if (timer) clearTimeout(timer);
  }
}

/**
 * Isolated Node.js `worker_threads` Code Mode executor (hermetic tests & local Node runtime).
 * - Runs in a separate V8 isolate (`new Worker(..., { eval: true, env: {} })`) with empty `env` so
 *   host `process.env` secrets are physically absent from the isolate.
 * - Disables `fetch`, `WebSocket`, `XMLHttpRequest`, and blocks `node:http`/`node:https`/`node:net`
 *   in the isolate before evaluating user code.
 * - Bridges `pod.*` strictly through JSON-serialized `parentPort` messages; no host objects or
 *   constructors ever cross into the isolate.
 * - On timeout, revokes SDK access immediately and hard-terminates the worker thread (`worker.terminate()`),
 *   stopping both synchronous CPU loops and post-`await` work.
 */
export async function executeInIsolatedWorkerThread(
  code: string,
  sdk: Record<string, (...args: any[]) => Promise<any> | any>,
  options: { timeoutMs: number }
): Promise<any> {
  let wt: any;
  try {
    const spec = "node:" + "worker_threads";
    wt = await import(/* @vite-ignore */ spec);
  } catch {
    throw new Error(
      "No Code Mode sandbox executor configured for this runtime. Bind a Cloudflare Dynamic Worker Loader (CODE_LOADER) or pass codeMode.executor."
    );
  }

  const methodNames = Object.keys(sdk).filter((k) => typeof sdk[k] === "function");

  const bootstrap = `
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const Module = require("node:module");

// Block all module loading from inside user code and disable network globals
const origLoad = Module._load;
Module._load = function() {
  throw new Error("Sandbox policy violation: module loading is disabled");
};
try { Object.defineProperty(globalThis, "fetch", { value: undefined, writable: false, configurable: false }); } catch {}
try { Object.defineProperty(globalThis, "WebSocket", { value: undefined, writable: false, configurable: false }); } catch {}
try { Object.defineProperty(globalThis, "XMLHttpRequest", { value: undefined, writable: false, configurable: false }); } catch {}
for (const k of Object.keys(process.env)) { delete process.env[k]; }

let nextCallId = 1;
const pending = new Map();
parentPort.on("message", (msg) => {
  if (!msg || msg.type !== "sdk_response") return;
  const entry = pending.get(msg.callId);
  if (!entry) return;
  pending.delete(msg.callId);
  if (msg.ok) entry.resolve(msg.result);
  else entry.reject(new Error(msg.error || "SDK call failed"));
});

function invokeSdk(method, args) {
  return new Promise((resolve, reject) => {
    const callId = nextCallId++;
    pending.set(callId, { resolve, reject });
    let serializedArgs;
    try {
      serializedArgs = JSON.parse(JSON.stringify(args));
    } catch {
      pending.delete(callId);
      reject(new Error("SDK arguments must be JSON-serializable"));
      return;
    }
    parentPort.postMessage({ type: "sdk_call", callId, method, args: serializedArgs });
  });
}

// Create a fresh VM context inside the isolated worker thread with NO host constructors or globals injected.
// User code only sees its own context's built-ins and a serialized JSON-RPC bridge function.
const ctx = vm.createContext(
  {
    __invokeSdkJson: (method, argsJson) => {
      const parsed = JSON.parse(argsJson);
      return invokeSdk(String(method), Array.isArray(parsed) ? parsed : []).then((res) =>
        JSON.stringify(res === undefined ? null : res)
      );
    },
  },
  { codeGeneration: { strings: false, wasm: false } }
);

const runnerSource = \`
(async () => {
  const __methods = \${JSON.stringify(workerData.methodNames)};
  const pod = Object.create(null);
  for (const m of __methods) {
    pod[m] = async (...args) => {
      const raw = await __invokeSdkJson(m, JSON.stringify(args));
      return JSON.parse(raw);
    };
  }
  Object.freeze(pod);
  const __result = await (async (pod) => {
    \${workerData.code}
  })(pod);
  return JSON.stringify(__result === undefined ? null : __result);
})()
\`;

(async () => {
  try {
    const script = new vm.Script(runnerSource, { filename: "code-mode-isolate.js" });
    const resultJson = await script.runInContext(ctx);
    parentPort.postMessage({ type: "done", ok: true, result: JSON.parse(resultJson) });
  } catch (err) {
    parentPort.postMessage({
      type: "done",
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }
})();
`;

  return await new Promise((resolve, reject) => {
    let settled = false;
    let revoked = false;

    const worker = new wt.Worker(bootstrap, {
      eval: true,
      env: {}, // Physically empty environment — zero host secrets in the isolate
      workerData: { code, methodNames },
    });

    const finish = (err: Error | null, value?: any) => {
      if (settled) return;
      settled = true;
      revoked = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      revoked = true;
      finish(new Error(`Code Mode execution timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    worker.on("message", async (msg: any) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "done") {
        if (msg.ok) finish(null, msg.result);
        else finish(new Error(msg.error || "Code Mode execution failed"));
        return;
      }
      if (msg.type === "sdk_call") {
        if (revoked) {
          worker.postMessage({
            type: "sdk_response",
            callId: msg.callId,
            ok: false,
            error: "Code Mode execution deadline expired; SDK access revoked",
          });
          return;
        }
        const method = String(msg.method ?? "");
        if (!methodNames.includes(method)) {
          worker.postMessage({
            type: "sdk_response",
            callId: msg.callId,
            ok: false,
            error: `Unknown SDK method: ${method}`,
          });
          return;
        }
        try {
          const safeArgs = Array.isArray(msg.args) ? msg.args : [];
          const result = await sdk[method](...safeArgs);
          if (revoked) return;
          worker.postMessage({
            type: "sdk_response",
            callId: msg.callId,
            ok: true,
            result: result === undefined ? null : JSON.parse(JSON.stringify(result)),
          });
        } catch (err: any) {
          if (revoked) return;
          worker.postMessage({
            type: "sdk_response",
            callId: msg.callId,
            ok: false,
            error: err?.message || "SDK call failed",
          });
        }
      }
    });

    worker.on("error", (err: Error) => {
      finish(err);
    });

    worker.on("exit", (exitCode: number) => {
      if (!settled) {
        finish(new Error(`Code Mode isolate exited unexpectedly (code ${exitCode})`));
      }
    });
  });
}

/**
 * Default Code Mode executor: prefers Cloudflare Dynamic Worker Loader when bound on `env`,
 * otherwise falls back to an isolated, terminable Node.js `worker_threads` sandbox.
 */
export async function defaultIsolatedCodeExecutor(
  code: string,
  sdk: Record<string, (...args: any[]) => Promise<any> | any>,
  options: { timeoutMs: number; env?: any; workerLoaderBinding?: string }
): Promise<any> {
  const bindingName = options.workerLoaderBinding || "CODE_LOADER";
  const loader = options.env?.[bindingName] as DynamicWorkerLoaderLike | undefined;
  if (loader && typeof loader.get === "function") {
    return executeInDynamicWorkerLoader(loader, code, sdk, { timeoutMs: options.timeoutMs });
  }
  return executeInIsolatedWorkerThread(code, sdk, { timeoutMs: options.timeoutMs });
}

/**
 * Creates the standard 5 core MCP tools per pod-contract.md
 */
export function buildCoreTools(handlers: CorePodHandlers): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [];

  if (handlers.onSubmitTask) {
    tools.push({
      name: "submit_task",
      description: "Submit an issue to be worked by the pod. Idempotent on requestId.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Target repository owner/name" },
          issue: { type: "number", description: "GitHub issue number" },
          requestId: { type: "string", description: "Unique idempotency key" },
          remote: { type: "string", description: "Optional git remote clone URL" },
          title: { type: "string", description: "Optional issue title" },
          body: { type: "string", description: "Optional issue description" },
        },
        required: ["repo", "issue", "requestId"],
      },
      handler: (args, ctx) => handlers.onSubmitTask!(args, ctx),
    });
  }

  if (handlers.onTaskStatus) {
    tools.push({
      name: "task_status",
      description: "Get the current phase, status, and outcome of a task by taskId or requestId.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID" },
          requestId: { type: "string", description: "Request idempotency key" },
        },
      },
      handler: (args, ctx) => handlers.onTaskStatus!(args, ctx),
    });
  }

  if (handlers.onApprove) {
    tools.push({
      name: "approve",
      description: "Submit human or external decision ('approve' | 'reject') for a task in await_approval.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID to approve or reject" },
          decision: { type: "string", enum: ["approve", "reject"], description: "Approval decision" },
        },
        required: ["taskId", "decision"],
      },
      handler: (args, ctx) => handlers.onApprove!(args, ctx),
    });
  }

  if (handlers.onCancel) {
    tools.push({
      name: "cancel",
      description: "Durably abort a running or pending task.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID to cancel" },
        },
        required: ["taskId"],
      },
      handler: (args, ctx) => handlers.onCancel!(args, ctx),
    });
  }

  if (handlers.onGetReceipt) {
    tools.push({
      name: "get_receipt",
      description: "Fetch cryptographic receipt for a completed task (diff hash, verify results, commit, PR).",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID" },
        },
        required: ["taskId"],
      },
      handler: (args, ctx) => handlers.onGetReceipt!(args, ctx),
    });
  }

  return tools;
}

/**
 * Creates the Cloudflare Code Mode (`search` + `execute`) MCP tool pair.
 */
export function buildCodeModeTools(options: CodeModeOptions): McpToolDefinition[] {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 2000, 50), 10_000);
  const maxCodeBytes = Math.min(Math.max(options.maxCodeBytes ?? 16_384, 256), 65_536);

  return [
    {
      name: "search",
      description: "Search the pod's typed Code Mode SDK specification to discover available `pod.*` methods and signatures.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keyword or method prefix to filter SDK entries (empty returns all entries).",
          },
        },
      },
      handler: async (args) => {
        const q = typeof args?.query === "string" ? args.query.trim().toLowerCase() : "";
        const matches = q
          ? options.spec.filter(
              (entry) =>
                entry.name.toLowerCase().includes(q) ||
                entry.method.toLowerCase().includes(q) ||
                entry.description.toLowerCase().includes(q) ||
                (entry.tags ?? []).some((t) => t.toLowerCase().includes(q))
            )
          : options.spec;
        return {
          mode: "code-mode",
          total: matches.length,
          entries: matches,
        };
      },
    },
    {
      name: "execute",
      description: "Execute a short JS snippet inside an isolated, network-disabled sandbox with the caller-scoped `pod` SDK bound. Return a JSON-serializable result.",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "Async function body using `pod.*` methods and returning a result (e.g. `return await pod.ping('hi');`).",
          },
        },
        required: ["code"],
      },
      handler: async (args, ctx) => {
        const code = typeof args?.code === "string" ? args.code : "";
        if (!code.trim()) {
          throw new Error("Code Mode `code` argument must be a non-empty string");
        }
        if (new TextEncoder().encode(code).byteLength > maxCodeBytes) {
          throw new Error(`Code Mode snippet exceeds max size (${maxCodeBytes} bytes)`);
        }
        const sdk = options.createSdk(ctx);
        const value = options.executor
          ? await options.executor(code, sdk, { timeoutMs, env: ctx.env })
          : await defaultIsolatedCodeExecutor(code, sdk, {
              timeoutMs,
              env: ctx.env,
              workerLoaderBinding: options.workerLoaderBinding,
            });
        return { ok: true, result: value ?? null };
      },
    },
  ];
}

/**
 * Creates an edge-native Cloudflare Workers MCP v2 HTTP fetch handler
 */
export function createEdgeMcpHandler(options: EdgeMcpServerOptions) {
  const {
    podName,
    podRole = "worker",
    version = "1.0.0",
    bearerToken,
    authGate,
    resources = [],
    tasks,
    codeMode,
    defaultProtocolVersion = MCP_V2_PROTOCOL_VERSION,
  } = options;

  const toolMap = new Map<string, McpToolDefinition>();

  if (options.coreHandlers) {
    for (const t of buildCoreTools(options.coreHandlers)) {
      toolMap.set(t.name, t);
    }
  }

  if (options.tools) {
    for (const t of options.tools) {
      toolMap.set(t.name, t);
    }
  }

  if (codeMode) {
    for (const t of buildCodeModeTools(codeMode)) {
      toolMap.set(t.name, t);
    }
  }

  const resourceMap = new Map<string, McpResourceDefinition>();
  for (const r of resources) {
    resourceMap.set(r.uri, r);
  }

  const buildCapabilities = () => {
    const extensions: Record<string, any> = {};
    if (tasks) {
      extensions["io.modelcontextprotocol/tasks"] = {
        list: true,
        get: true,
        cancel: Boolean(tasks.cancel),
      };
    }
    return {
      tools: { listChanged: false },
      ...(resourceMap.size > 0 ? { resources: { subscribe: false } } : {}),
      ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
      ...(codeMode ? { experimental: { codeMode: { search: true, execute: true } } } : {}),
    };
  };

  const checkAuth = async (request: Request): Promise<boolean> => {
    if (authGate) return await authGate(request);
    if (!bearerToken) return true;
    const auth = request.headers.get("authorization") || request.headers.get("Authorization");
    if (!auth) return false;
    return auth === `Bearer ${bearerToken}`;
  };

  async function processSingleRpc(
    body: any,
    request: Request,
    env: any,
    protocolVersion: string
  ): Promise<{ status: number; response: JsonRpcResponse | null; negotiatedVersion?: string }> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return {
        status: 400,
        response: {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid Request: expected JSON-RPC object" },
        },
      };
    }

    const hasId = Object.prototype.hasOwnProperty.call(body, "id");
    const id = hasId ? body.id : undefined;
    const rpcMethod = body.method;
    const rawParams = body.params;

    if (body.jsonrpc !== "2.0" || typeof rpcMethod !== "string" || !rpcMethod) {
      return {
        status: 400,
        response: {
          jsonrpc: "2.0",
          id: hasId ? id : null,
          error: { code: -32600, message: "Invalid Request: jsonrpc must be '2.0' and method must be a string" },
        },
      };
    }

    if (rawParams !== undefined && (rawParams === null || typeof rawParams !== "object" || Array.isArray(rawParams))) {
      if (!hasId) return { status: 204, response: null };
      return {
        status: 400,
        response: {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Invalid params: expected object" },
        },
      };
    }

    const params: Record<string, any> = rawParams ?? {};

    // Per JSON-RPC 2.0, any message without an `id` member is a notification and receives no response.
    if (!hasId) {
      return { status: 204, response: null };
    }

    // 1. MCP v2 mandatory `server/discover`
    if (rpcMethod === "server/discover") {
      return {
        status: 200,
        response: {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_V2_PROTOCOL_VERSION,
            supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
            capabilities: buildCapabilities(),
            serverInfo: {
              name: podName,
              role: podRole,
              version,
            },
          },
        },
      };
    }

    // 2. Legacy `initialize` handshake with exact version validation
    if (rpcMethod === "initialize") {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion.trim() : protocolVersion;
      if (!isSupportedProtocolVersion(requested)) {
        return {
          status: 400,
          response: {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: `Unsupported protocolVersion '${requested}'. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
              data: { supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS] },
            },
          },
        };
      }
      return {
        status: 200,
        negotiatedVersion: requested,
        response: {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: requested,
            supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
            capabilities: buildCapabilities(),
            serverInfo: {
              name: podName,
              role: podRole,
              version,
            },
          },
        },
      };
    }

    // 3. ping
    if (rpcMethod === "ping") {
      return {
        status: 200,
        response: { jsonrpc: "2.0", id, result: {} },
      };
    }

    // 4. tools/list
    if (rpcMethod === "tools/list") {
      const toolSummaries = Array.from(toolMap.values()).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return {
        status: 200,
        response: {
          jsonrpc: "2.0",
          id,
          result: { tools: toolSummaries },
        },
      };
    }

    const context: McpToolContext = {
      request,
      env,
      podName,
      podRole,
      now: Date.now(),
      protocolVersion,
    };

    // 5. tools/call
    if (rpcMethod === "tools/call") {
      const toolName = typeof params.name === "string" ? params.name : "";
      if (!toolName) {
        return {
          status: 400,
          response: {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid params: 'name' string is required" },
          },
        };
      }
      const toolArgs = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const tool = toolMap.get(toolName);

      if (!tool) {
        return {
          status: 404,
          response: {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Tool not found: '${toolName}'` },
          },
        };
      }

      try {
        const result = await tool.handler(toolArgs, context);
        const textContent = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return {
          status: 200,
          response: {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: textContent }],
            },
          },
        };
      } catch (err: any) {
        return {
          status: 500,
          response: {
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: err?.message || "Tool execution failed" },
          },
        };
      }
    }

    // 6. MCP v2 `io.modelcontextprotocol/tasks` extension
    if (rpcMethod === "tasks/list" && tasks) {
      try {
        const res = await tasks.list(params, context);
        return { status: 200, response: { jsonrpc: "2.0", id, result: res } };
      } catch (err: any) {
        return {
          status: 500,
          response: { jsonrpc: "2.0", id, error: { code: -32000, message: err?.message || "tasks/list failed" } },
        };
      }
    }

    if (rpcMethod === "tasks/get" && tasks) {
      const taskId = typeof params.taskId === "string" ? params.taskId : "";
      if (!taskId) {
        return {
          status: 400,
          response: { jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params: 'taskId' string is required" } },
        };
      }
      try {
        const detail = await tasks.get({ taskId }, context);
        if (!detail) {
          return {
            status: 404,
            response: { jsonrpc: "2.0", id, error: { code: -32602, message: `Task not found: '${taskId}'` } },
          };
        }
        return {
          status: 200,
          response: {
            jsonrpc: "2.0",
            id,
            result: {
              resultType: detail.resultType ?? "complete",
              ...detail,
            },
          },
        };
      } catch (err: any) {
        return {
          status: 500,
          response: { jsonrpc: "2.0", id, error: { code: -32000, message: err?.message || "tasks/get failed" } },
        };
      }
    }

    if (rpcMethod === "tasks/cancel" && tasks?.cancel) {
      const taskId = typeof params.taskId === "string" ? params.taskId : "";
      if (!taskId) {
        return {
          status: 400,
          response: { jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params: 'taskId' string is required" } },
        };
      }
      try {
        const detail = await tasks.cancel({ taskId }, context);
        return {
          status: 200,
          response: {
            jsonrpc: "2.0",
            id,
            result: {
              resultType: detail.resultType ?? "cancelled",
              ...detail,
            },
          },
        };
      } catch (err: any) {
        return {
          status: 500,
          response: { jsonrpc: "2.0", id, error: { code: -32000, message: err?.message || "tasks/cancel failed" } },
        };
      }
    }

    // 7. MCP v2 Resources extension
    if (rpcMethod === "resources/list") {
      const list = Array.from(resourceMap.values()).map((r) => ({
        uri: r.uri,
        name: r.name,
        ...(r.description ? { description: r.description } : {}),
        ...(r.mimeType ? { mimeType: r.mimeType } : {}),
      }));
      return { status: 200, response: { jsonrpc: "2.0", id, result: { resources: list } } };
    }

    if (rpcMethod === "resources/read") {
      const uri = typeof params.uri === "string" ? params.uri : "";
      const resource = resourceMap.get(uri);
      if (!resource) {
        return {
          status: 404,
          response: {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: `Resource not found: '${uri}'` },
          },
        };
      }
      try {
        const content = await resource.read(context);
        return {
          status: 200,
          response: {
            jsonrpc: "2.0",
            id,
            result: {
              contents: [
                {
                  uri: resource.uri,
                  mimeType: content.mimeType || resource.mimeType || "application/json",
                  ...(content.text !== undefined ? { text: content.text } : {}),
                  ...(content.blob !== undefined ? { blob: content.blob } : {}),
                },
              ],
            },
          },
        };
      } catch (err: any) {
        return {
          status: 500,
          response: { jsonrpc: "2.0", id, error: { code: -32000, message: err?.message || "resources/read failed" } },
        };
      }
    }

    // Unknown method
    return {
      status: 404,
      response: {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: '${rpcMethod}'` },
      },
    };
  }

  return async function handleMcpRequest(request: Request, env?: any): Promise<Response> {
    const method = request.method;

    const baseCorsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Version, MCP-Protocol-Version, MCP-Method, MCP-Tool-Name",
    };

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: baseCorsHeaders });
    }

    const versionCheck = validateVersionHeader(request, defaultProtocolVersion);
    if (!versionCheck.ok) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32600,
            message: versionCheck.message,
            data: { supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS] },
          },
        }),
        { status: versionCheck.status, headers: { ...baseCorsHeaders, "Content-Type": "application/json" } }
      );
    }

    const protocolVersion = versionCheck.version;
    const makeHeaders = (ver: string) => ({
      ...baseCorsHeaders,
      "Content-Type": "application/json",
      "Mcp-Version": ver,
      "MCP-Protocol-Version": ver,
    });

    // GET /mcp: Discovery document (open without credentials for capability inspection)
    if (method === "GET") {
      const toolSummaries = Array.from(toolMap.values()).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      const resourceSummaries = Array.from(resourceMap.values()).map((r) => ({
        uri: r.uri,
        name: r.name,
        ...(r.description ? { description: r.description } : {}),
        ...(r.mimeType ? { mimeType: r.mimeType } : {}),
      }));

      return new Response(
        JSON.stringify(
          {
            mcpVersion: protocolVersion,
            supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
            server: {
              name: podName,
              role: podRole,
              version,
            },
            capabilities: buildCapabilities(),
            tools: toolSummaries,
            ...(resourceSummaries.length > 0 ? { resources: resourceSummaries } : {}),
          },
          null,
          2
        ),
        {
          status: 200,
          headers: makeHeaders(protocolVersion),
        }
      );
    }

    if (method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: baseCorsHeaders });
    }

    // Auth verification on POST
    if (!(await checkAuth(request))) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32001, message: "Unauthorized: Invalid or missing Bearer token" },
        }),
        { status: 401, headers: makeHeaders(protocolVersion) }
      );
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error: Invalid JSON" },
        }),
        { status: 400, headers: makeHeaders(protocolVersion) }
      );
    }

    // Validate routing headers against JSON-RPC body before dispatch
    const routeCheck = validateRoutingHeaders(request, body);
    if (!routeCheck.ok) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body && typeof body === "object" && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, "id") ? body.id : null,
          error: { code: -32600, message: routeCheck.message },
        }),
        { status: routeCheck.status, headers: makeHeaders(protocolVersion) }
      );
    }

    // Batch JSON-RPC support (each member isolated; notifications excluded)
    if (Array.isArray(body)) {
      if (body.length === 0) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Invalid Request: empty batch" },
          }),
          { status: 400, headers: makeHeaders(protocolVersion) }
        );
      }
      const settled = await Promise.all(
        body.map(async (reqItem) => {
          try {
            return await processSingleRpc(reqItem, request, env, protocolVersion);
          } catch (err: any) {
            return {
              status: 500,
              response: {
                jsonrpc: "2.0" as const,
                id: reqItem && typeof reqItem === "object" && Object.prototype.hasOwnProperty.call(reqItem, "id") ? reqItem.id : null,
                error: { code: -32603, message: err?.message || "Internal error" },
              },
            };
          }
        })
      );
      const responses = settled.map((s) => s.response).filter((r): r is JsonRpcResponse => r !== null);
      if (responses.length === 0) {
        return new Response(null, { status: 204, headers: makeHeaders(protocolVersion) });
      }
      return new Response(JSON.stringify(responses), {
        status: 200,
        headers: makeHeaders(protocolVersion),
      });
    }

    const { status, response, negotiatedVersion } = await processSingleRpc(body, request, env, protocolVersion);
    const effectiveVersion = negotiatedVersion ?? protocolVersion;
    if (response === null) {
      return new Response(null, { status: 204, headers: makeHeaders(effectiveVersion) });
    }
    return new Response(JSON.stringify(response), {
      status,
      headers: makeHeaders(effectiveVersion),
    });
  };
}
