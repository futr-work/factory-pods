// @futr-work/pod-kernel: Edge-native Cloudflare Workers MCP v2 Server + Code Mode
// Implements stateless JSON-RPC 2.0 Model Context Protocol (2026-07-28 default, 2024-11-05 compatible)
// with Cloudflare Code Mode (`search` + `execute` isolated SDK execution).
// Runs natively in Cloudflare Workers V8 isolates (with Dynamic Worker Loader + ctx.exports/RpcTarget)
// and locally in Node.js (via OS-level `node --permission` subprocess with zero FS/network/env capabilities).

import type { PodReceipt } from "./types.js";

export const MCP_V2_PROTOCOL_VERSION = "2026-07-28";
export const MCP_V1_PROTOCOL_VERSION = "2024-11-05";
export const SUPPORTED_PROTOCOL_VERSIONS = [MCP_V2_PROTOCOL_VERSION, MCP_V1_PROTOCOL_VERSION] as const;

export const MCP_ERROR_HEADER_MISMATCH = -32020;

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
  /** RPC result discriminator is always `"complete"` on the wire regardless of task `status`. */
  resultType?: "complete";
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
  ) => Promise<Record<string, any>> | Record<string, any>;
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
  options: { timeoutMs: number; env?: any; ctx?: any }
) => Promise<any>;

/**
 * Cloudflare Dynamic Worker Loader binding shape (`env.LOADER` / `env.CODE_LOADER`).
 */
export interface DynamicWorkerLoaderLike {
  load?: (config: {
    compatibilityDate: string;
    mainModule: string;
    modules: Record<string, string | { js: string }>;
    globalOutbound?: any;
    env?: Record<string, any>;
  }) => {
    getEntrypoint: () => {
      fetch: (request: Request) => Promise<Response>;
    };
  };
  get?: (
    id: string,
    getCode: () => Promise<{
      compatibilityDate: string;
      mainModule: string;
      modules: Record<string, string | { js: string }>;
      globalOutbound?: any;
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
   *    executes inside a fresh network-disabled (`globalOutbound: null`) Dynamic Worker isolate using a `.js` module
   *    and a Cloudflare `RpcTarget` / Service Binding callback bridge (no plain-object functions passed to `env`).
   *  - Otherwise in Node.js, executes inside an OS-isolated `node --permission` child process with empty `env`,
   *    zero filesystem/network permissions, JSON-lines stdin/stdout SDK RPC, and hard `SIGKILL` + SDK revocation on timeout.
   */
  executor?: CodeModeExecutor;
  /** Cloudflare Worker binding name for the Dynamic Worker Loader (default: "CODE_LOADER"). */
  workerLoaderBinding?: string;
  /**
   * Optional Cloudflare WorkerEntrypoint / Service Binding factory for bridging `pod.*` into the Dynamic Worker
   * (e.g. `({ runId }) => ctx.exports.CodeModeSdkBridge({ props: { runId } })`).
   * If omitted in Cloudflare Workers, the kernel attempts `new RpcTarget` from `cloudflare:workers`.
   */
  createWorkerSdkBinding?: (
    dispatch: (method: string, args: any[]) => Promise<any>,
    context: { env?: any; ctx?: any; runId: string }
  ) => Promise<any> | any;
  /** Maximum execution timeout in milliseconds (default: 2000, hard cap: 10000). */
  timeoutMs?: number;
  /** Maximum source code length in bytes (default: 16384). */
  maxCodeBytes?: number;
}

export interface McpToolContext {
  request: Request;
  env?: any;
  ctx?: any;
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
 * Validate MCP 2026-07-28 Streamable HTTP routing headers (`Mcp-Method`, `Mcp-Name`, `MCP-Protocol-Version`)
 * and body `_meta` protocolVersion agreement before dispatch.
 * Rejects mismatches with HTTP 400 and MCP `HeaderMismatch` error (`-32020`).
 */
function validateRoutingHeaders(
  request: Request,
  body: any,
  headerVersion: string
): { ok: true } | { ok: false; status: number; code: number; errorName: string; message: string } {
  const methodHeader = request.headers.get("Mcp-Method") || request.headers.get("X-MCP-Method");
  const nameHeader =
    request.headers.get("Mcp-Name") ||
    request.headers.get("MCP-Tool-Name") ||
    request.headers.get("X-MCP-Tool");

  const checkSingleBodyMeta = (item: any) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const metaVer =
      item.params &&
      typeof item.params === "object" &&
      item.params._meta &&
      typeof item.params._meta === "object" &&
      typeof item.params._meta.protocolVersion === "string"
        ? item.params._meta.protocolVersion.trim()
        : null;
    if (metaVer !== null) {
      if (!isSupportedProtocolVersion(metaVer)) {
        return {
          ok: false as const,
          status: 400,
          code: MCP_ERROR_HEADER_MISMATCH,
          errorName: "HeaderMismatch",
          message: `Unsupported body _meta.protocolVersion '${metaVer}'. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
        };
      }
      if (metaVer !== headerVersion) {
        return {
          ok: false as const,
          status: 400,
          code: MCP_ERROR_HEADER_MISMATCH,
          errorName: "HeaderMismatch",
          message: `HeaderMismatch: protocol version header '${headerVersion}' disagrees with body _meta.protocolVersion '${metaVer}'`,
        };
      }
    }
    return null;
  };

  if (Array.isArray(body)) {
    if (methodHeader || nameHeader) {
      return {
        ok: false,
        status: 400,
        code: MCP_ERROR_HEADER_MISMATCH,
        errorName: "HeaderMismatch",
        message: "HeaderMismatch: Mcp-Method / Mcp-Name headers cannot be used with batch requests",
      };
    }
    for (const item of body) {
      const metaErr = checkSingleBodyMeta(item);
      if (metaErr) return metaErr;
    }
    return { ok: true };
  }

  const metaErr = checkSingleBodyMeta(body);
  if (metaErr) return metaErr;

  if (!methodHeader && !nameHeader) return { ok: true };

  if (!body || typeof body !== "object") {
    return {
      ok: false,
      status: 400,
      code: MCP_ERROR_HEADER_MISMATCH,
      errorName: "HeaderMismatch",
      message: "HeaderMismatch: invalid JSON-RPC body for routing header validation",
    };
  }

  if (methodHeader && body.method !== methodHeader.trim()) {
    return {
      ok: false,
      status: 400,
      code: MCP_ERROR_HEADER_MISMATCH,
      errorName: "HeaderMismatch",
      message: `HeaderMismatch: Mcp-Method header '${methodHeader.trim()}' does not match body method '${String(body.method)}'`,
    };
  }

  if (nameHeader) {
    const expectedName = nameHeader.trim();
    const params = body.params && typeof body.params === "object" ? body.params : {};
    const bodyName =
      body.method === "tools/call" || body.method === "prompts/get"
        ? params.name
        : body.method === "resources/read"
          ? params.uri
          : undefined;
    if (bodyName !== expectedName) {
      return {
        ok: false,
        status: 400,
        code: MCP_ERROR_HEADER_MISMATCH,
        errorName: "HeaderMismatch",
        message: `HeaderMismatch: Mcp-Name header '${expectedName}' does not match body target '${String(bodyName)}'`,
      };
    }
  }

  return { ok: true };
}

/**
 * Cloudflare Dynamic Worker Loader Code Mode executor.
 * Uses `worker.js` with `globalOutbound: null` (external network disabled) and passes the
 * `RpcTarget` SDK bridge as an RPC argument to a `WorkerEntrypoint` method on the loaded worker
 * (workerd allows passing `RpcTarget` in RPC method arguments, whereas `loader.load({ env })`
 * only accepts static JSON/service bindings).
 */
export async function executeInDynamicWorkerLoader(
  loader: DynamicWorkerLoaderLike,
  code: string,
  sdk: Record<string, (...args: any[]) => Promise<any> | any>,
  options: {
    timeoutMs: number;
    env?: any;
    ctx?: any;
    createWorkerSdkBinding?: CodeModeOptions["createWorkerSdkBinding"];
  }
): Promise<any> {
  const methodNames = Object.keys(sdk).filter((k) => typeof sdk[k] === "function");
  let revoked = false;
  const deadlineMs = Date.now() + options.timeoutMs;
  const isExpired = () => revoked || Date.now() >= deadlineMs;

  const dispatchSdk = async (method: string, args: any[]) => {
    if (isExpired()) {
      revoked = true;
      throw new Error("Code Mode execution deadline expired; SDK access revoked");
    }
    if (!methodNames.includes(method)) {
      throw new Error(`Unknown SDK method: ${method}`);
    }
    const safeArgs = Array.isArray(args) ? JSON.parse(JSON.stringify(args)) : [];
    const result = await sdk[method](...safeArgs);
    if (isExpired()) {
      revoked = true;
      throw new Error("Code Mode execution deadline expired; SDK access revoked");
    }
    return result === undefined ? null : JSON.parse(JSON.stringify(result));
  };

  const runId = `codemode-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  let rpcArg: any = null;
  let envBinding: any = null;
  if (options.createWorkerSdkBinding) {
    envBinding = await options.createWorkerSdkBinding(dispatchSdk, {
      env: options.env,
      ctx: options.ctx,
      runId,
    });
  } else {
    try {
      const cfWorkersSpec = "cloudflare:" + "workers";
      const cfWorkers: any = await import(/* @vite-ignore */ cfWorkersSpec);
      if (cfWorkers && typeof cfWorkers.RpcTarget === "function") {
        class CodeModeRpcBridge extends cfWorkers.RpcTarget {
          async call(method: string, argsJson: string): Promise<string> {
            const parsedArgs = JSON.parse(argsJson);
            const res = await dispatchSdk(String(method), Array.isArray(parsedArgs) ? parsedArgs : []);
            return JSON.stringify(res);
          }
        }
        rpcArg = new CodeModeRpcBridge();
      }
    } catch {
      // Not running inside workerd/Cloudflare Workers
    }
  }

  const workerModule = `
import { WorkerEntrypoint } from "cloudflare:workers";

function buildPod(bridge) {
  const methods = ${JSON.stringify(methodNames)};
  const pod = Object.create(null);
  for (const m of methods) {
    pod[m] = async (...args) => {
      if (!bridge) throw new Error("POD_SDK bridge is unavailable in Dynamic Worker");
      if (typeof bridge.call === "function") {
        const raw = await bridge.call(m, JSON.stringify(args));
        return JSON.parse(raw);
      }
      if (typeof bridge.fetch === "function") {
        const res = await bridge.fetch("https://pod-sdk.internal/call", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: m, args }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || "SDK call failed");
        return data.result;
      }
      throw new Error("Unsupported POD_SDK bridge interface");
    };
  }
  return Object.freeze(pod);
}

export default class CodeModeRunner extends WorkerEntrypoint {
  async run(rpcBridge) {
    const pod = buildPod(rpcBridge || (this.env && this.env.POD_SDK));
    try {
      const result = await (async (pod) => {
        ${code}
      })(pod);
      return JSON.stringify({ ok: true, result: result === undefined ? null : result });
    } catch (err) {
      return JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  }

  async fetch() {
    const raw = await this.run(null);
    const parsed = JSON.parse(raw);
    return new Response(raw, {
      status: parsed.ok ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
`;

  const workerConfig = {
    compatibilityDate: "2026-05-01",
    mainModule: "worker.js",
    modules: { "worker.js": workerModule },
    globalOutbound: null,
    ...(envBinding ? { env: { POD_SDK: envBinding } } : {}),
  };

  const worker =
    typeof loader.load === "function"
      ? loader.load(workerConfig)
      : loader.get!(runId, async () => workerConfig);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const entrypoint: any = worker.getEntrypoint();
    const execPromise =
      rpcArg && typeof entrypoint.run === "function"
        ? Promise.resolve(entrypoint.run(rpcArg)).then((raw: string) => {
            if (isExpired()) {
              revoked = true;
              throw new Error(`Code Mode execution timed out after ${options.timeoutMs}ms`);
            }
            const data = typeof raw === "string" ? JSON.parse(raw) : raw;
            if (!data || data.ok === false) {
              throw new Error(data?.error || "Code Mode execution failed");
            }
            return data.result;
          })
        : entrypoint
            .fetch(new Request("https://sandbox.internal/run", { method: "POST" }))
            .then(async (resp: Response) => {
              if (isExpired()) {
                revoked = true;
                throw new Error(`Code Mode execution timed out after ${options.timeoutMs}ms`);
              }
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
 * OS-process-isolated Node.js Code Mode executor (hermetic tests & local Node runtime).
 * Spawns a fresh `node --permission` subprocess with:
 * - NO `--allow-fs-read`, NO `--allow-fs-write`, NO `--allow-net`, NO `--allow-child-process`, NO `--allow-worker`.
 *   Even if untrusted code reaches `process.getBuiltinModule("node:fs")` or `node:http` / `node:net`,
 *   the Node Permission Model rejects every filesystem read/write and network connection with `ERR_ACCESS_DENIED`.
 * - Physically empty `env: {}` so host secrets are absent from the child process.
 * - Strictly serialized JSON-lines IPC over stdin/stdout (zero shared V8 heap, zero outer-realm objects).
 * - Hard `SIGKILL` + SDK revocation on deadline expiry, stopping both synchronous CPU loops and post-`await` work.
 */
export async function executeInIsolatedNodeSubprocess(
  code: string,
  sdk: Record<string, (...args: any[]) => Promise<any> | any>,
  options: { timeoutMs: number }
): Promise<any> {
  let cp: any;
  try {
    const spec = "node:" + "child_process";
    cp = await import(/* @vite-ignore */ spec);
  } catch {
    throw new Error(
      "No Code Mode sandbox executor configured for this runtime. Bind a Cloudflare Dynamic Worker Loader (CODE_LOADER) or pass codeMode.executor."
    );
  }

  // Fail closed on Node versions (< 26) where `--permission` does not enforce network isolation.
  const majorNode = Number.parseInt(String(process.versions?.node ?? "0").split(".")[0] || "0", 10);
  if (!Number.isFinite(majorNode) || majorNode < 26) {
    throw new Error(
      `Code Mode local Node sandbox requires Node >= 26 for OS-enforced network permission isolation (detected Node ${process.versions?.node ?? "unknown"}). Use Cloudflare Dynamic Worker Loader (CODE_LOADER) or pass a custom codeMode.executor.`
    );
  }

  const methodNames = Object.keys(sdk).filter((k) => typeof sdk[k] === "function");

  // Child process runner: uses dedicated Node IPC channel (`process.send` / `process.on("message")`)
  // so arbitrary `console.log(...)` on stdout never collides with or crashes IPC parsing.
  const childBootstrap = `
const sendIpc = (obj) => new Promise((resolve) => {
  if (typeof process.send !== "function") { resolve(); return; }
  process.send(obj, undefined, undefined, () => resolve());
});

let started = false;
let nextCallId = 1;
const pending = new Map();

function invokeSdk(method, args) {
  return new Promise((resolve, reject) => {
    const callId = nextCallId++;
    pending.set(callId, { resolve, reject });
    let safeArgs;
    try {
      safeArgs = JSON.parse(JSON.stringify(args));
    } catch {
      pending.delete(callId);
      reject(new Error("SDK arguments must be JSON-serializable"));
      return;
    }
    void sendIpc({ type: "sdk_call", callId, method, args: safeArgs });
  });
}

process.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (!started && msg.type === "init") {
    started = true;
    const pod = Object.create(null);
    for (const m of msg.methodNames || []) {
      pod[m] = (...args) => invokeSdk(m, args);
    }
    Object.freeze(pod);
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    Promise.resolve()
      .then(() => new AsyncFunction("pod", msg.code)(pod))
      .then(async (result) => {
        const safeResult = result === undefined ? null : JSON.parse(JSON.stringify(result));
        await sendIpc({ type: "done", ok: true, result: safeResult });
        if (typeof process.disconnect === "function") process.disconnect();
      })
      .catch(async (err) => {
        await sendIpc({ type: "done", ok: false, error: err && err.message ? err.message : String(err) });
        if (typeof process.disconnect === "function") process.disconnect();
      });
    return;
  }
  if (msg.type === "sdk_response") {
    const entry = pending.get(msg.callId);
    if (!entry) return;
    pending.delete(msg.callId);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error || "SDK call failed"));
  }
});
`;

  return await new Promise((resolve, reject) => {
    let settled = false;
    let revoked = false;
    const deadlineMs = Date.now() + options.timeoutMs;
    const isExpired = () => revoked || Date.now() >= deadlineMs;
    let stderrBuf = "";

    const child = cp.spawn(process.execPath, ["--permission", "-e", childBootstrap], {
      env: {}, // Physically empty environment — zero host secrets in child process
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });

    const finish = (err: Error | null, value?: any) => {
      if (settled) return;
      settled = true;
      revoked = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {}
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      revoked = true;
      finish(new Error(`Code Mode execution timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    const handleMessage = async (msg: any) => {
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
      if (msg.type === "done") {
        if (isExpired()) {
          finish(new Error(`Code Mode execution timed out after ${options.timeoutMs}ms`));
          return;
        }
        if (msg.ok) finish(null, msg.result);
        else finish(new Error(typeof msg.error === "string" ? msg.error : "Code Mode execution failed"));
        return;
      }
      if (msg.type === "sdk_call") {
        if (isExpired()) {
          revoked = true;
          return;
        }
        const method = String(msg.method ?? "");
        if (!methodNames.includes(method)) {
          try {
            child.send({ type: "sdk_response", callId: msg.callId, ok: false, error: `Unknown SDK method: ${method}` });
          } catch {}
          return;
        }
        try {
          const safeArgs = Array.isArray(msg.args) ? msg.args : [];
          const result = await sdk[method](...safeArgs);
          if (isExpired()) {
            revoked = true;
            return;
          }
          child.send({
            type: "sdk_response",
            callId: msg.callId,
            ok: true,
            result: result === undefined ? null : JSON.parse(JSON.stringify(result)),
          });
        } catch (err: any) {
          if (isExpired()) return;
          try {
            child.send({ type: "sdk_response", callId: msg.callId, ok: false, error: err?.message || "SDK call failed" });
          } catch {}
        }
      }
    };

    child.on("message", (msg: any) => {
      void handleMessage(msg).catch((err) => {
        finish(err instanceof Error ? err : new Error(String(err)));
      });
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderrBuf.length < 2048) stderrBuf += chunk;
    });

    child.on("error", (err: Error) => {
      finish(err);
    });

    child.on("close", (exitCode: number | null) => {
      if (!settled) {
        const detail = stderrBuf.trim() ? `: ${stderrBuf.trim().slice(0, 240)}` : "";
        finish(new Error(`Code Mode isolate exited unexpectedly (code ${exitCode})${detail}`));
      }
    });

    try {
      child.send({ type: "init", code, methodNames });
    } catch (err: any) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Default Code Mode executor: prefers Cloudflare Dynamic Worker Loader when bound on `env`,
 * otherwise falls back to an OS-isolated `node --permission` subprocess.
 */
export async function defaultIsolatedCodeExecutor(
  code: string,
  sdk: Record<string, (...args: any[]) => Promise<any> | any>,
  options: {
    timeoutMs: number;
    env?: any;
    ctx?: any;
    workerLoaderBinding?: string;
    createWorkerSdkBinding?: CodeModeOptions["createWorkerSdkBinding"];
  }
): Promise<any> {
  const bindingName = options.workerLoaderBinding || "CODE_LOADER";
  const loader = options.env?.[bindingName] as DynamicWorkerLoaderLike | undefined;
  if (loader && (typeof loader.load === "function" || typeof loader.get === "function")) {
    return executeInDynamicWorkerLoader(loader, code, sdk, {
      timeoutMs: options.timeoutMs,
      env: options.env,
      ctx: options.ctx,
      createWorkerSdkBinding: options.createWorkerSdkBinding,
    });
  }
  return executeInIsolatedNodeSubprocess(code, sdk, { timeoutMs: options.timeoutMs });
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
          ? await options.executor(code, sdk, { timeoutMs, env: ctx.env, ctx: ctx.ctx })
          : await defaultIsolatedCodeExecutor(code, sdk, {
              timeoutMs,
              env: ctx.env,
              ctx: ctx.ctx,
              workerLoaderBinding: options.workerLoaderBinding,
              createWorkerSdkBinding: options.createWorkerSdkBinding,
            });
        return { ok: true, result: value ?? null };
      },
    },
  ];
}

/**
 * Decorates a JSON-RPC result object with `resultType: "complete"` when responding on MCP v2 (`2026-07-28`).
 * Always enforces `resultType: "complete"` after spread so caller payloads cannot override the discriminator.
 */
function formatVersionedResult(protocolVersion: string, payload: Record<string, any>): Record<string, any> {
  if (protocolVersion === MCP_V2_PROTOCOL_VERSION) {
    return { ...payload, resultType: "complete" };
  }
  return payload;
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
    execCtx: any,
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
      if (!hasId) return { status: 202, response: null };
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

    // Per JSON-RPC 2.0 & MCP 2026-07-28 Streamable HTTP: any message without `id` is a notification -> 202 Accepted, no body.
    if (!hasId) {
      return { status: 202, response: null };
    }

    // 1. MCP v2 mandatory `server/discover`
    if (rpcMethod === "server/discover") {
      return {
        status: 200,
        response: {
          jsonrpc: "2.0",
          id,
          result: formatVersionedResult(MCP_V2_PROTOCOL_VERSION, {
            protocolVersion: MCP_V2_PROTOCOL_VERSION,
            supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
            capabilities: buildCapabilities(),
            serverInfo: {
              name: podName,
              role: podRole,
              version,
            },
          }),
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
              data: { supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS] },
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
          result: formatVersionedResult(requested, {
            protocolVersion: requested,
            supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
            capabilities: buildCapabilities(),
            serverInfo: {
              name: podName,
              role: podRole,
              version,
            },
          }),
        },
      };
    }

    // 3. ping
    if (rpcMethod === "ping") {
      return {
        status: 200,
        response: { jsonrpc: "2.0", id, result: formatVersionedResult(protocolVersion, {}) },
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
          result: formatVersionedResult(protocolVersion, { tools: toolSummaries }),
        },
      };
    }

    const context: McpToolContext = {
      request,
      env,
      ctx: execCtx,
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
            result: formatVersionedResult(protocolVersion, {
              content: [{ type: "text", text: textContent }],
            }),
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
        return {
          status: 200,
          response: { jsonrpc: "2.0", id, result: formatVersionedResult(protocolVersion, res) },
        };
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
            result: formatVersionedResult(protocolVersion, { ...detail }),
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
            result: formatVersionedResult(protocolVersion, detail && typeof detail === "object" ? { ...detail } : {}),
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
      return {
        status: 200,
        response: { jsonrpc: "2.0", id, result: formatVersionedResult(protocolVersion, { resources: list }) },
      };
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
            result: formatVersionedResult(protocolVersion, {
              contents: [
                {
                  uri: resource.uri,
                  mimeType: content.mimeType || resource.mimeType || "application/json",
                  ...(content.text !== undefined ? { text: content.text } : {}),
                  ...(content.blob !== undefined ? { blob: content.blob } : {}),
                },
              ],
            }),
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

  return async function handleMcpRequest(request: Request, env?: any, execCtx?: any): Promise<Response> {
    const method = request.method;

    const baseCorsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Version, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
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
            data: { supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS] },
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
            supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
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

    // Validate routing headers (`Mcp-Method`, `Mcp-Name`, `_meta.protocolVersion`) before dispatch
    const routeCheck = validateRoutingHeaders(request, body, protocolVersion);
    if (!routeCheck.ok) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body && typeof body === "object" && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, "id") ? body.id : null,
          error: {
            code: routeCheck.code,
            message: routeCheck.message,
            data: { error: routeCheck.errorName },
          },
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
            return await processSingleRpc(reqItem, request, env, execCtx, protocolVersion);
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
        return new Response(null, { status: 202, headers: makeHeaders(protocolVersion) });
      }
      return new Response(JSON.stringify(responses), {
        status: 200,
        headers: makeHeaders(protocolVersion),
      });
    }

    const { status, response, negotiatedVersion } = await processSingleRpc(body, request, env, execCtx, protocolVersion);
    const effectiveVersion = negotiatedVersion ?? protocolVersion;
    if (response === null) {
      return new Response(null, { status: 202, headers: makeHeaders(effectiveVersion) });
    }
    return new Response(JSON.stringify(response), {
      status,
      headers: makeHeaders(effectiveVersion),
    });
  };
}
