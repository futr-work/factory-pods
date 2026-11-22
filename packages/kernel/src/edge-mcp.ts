// @futr-work/pod-kernel: Edge-native Cloudflare Workers MCP v2 Server + Code Mode
// Implements stateless JSON-RPC 2.0 Model Context Protocol (2026-07-28 default, 2024-11-05 compatible)
// with optional Cloudflare Code Mode (`search` + `execute` sandboxed SDK execution).
// Runs natively in Cloudflare Workers V8 isolates, Bun, and Node.js without node:http dependencies.

import type { PodReceipt } from "./types.js";

export const MCP_V2_PROTOCOL_VERSION = "2026-07-28";
export const MCP_V1_PROTOCOL_VERSION = "2024-11-05";

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

export interface McpTasksExtension {
  list: (params: { limit?: number; cursor?: string }, context: McpToolContext) => Promise<{ tasks: any[]; nextCursor?: string }> | { tasks: any[]; nextCursor?: string };
  get: (params: { taskId: string }, context: McpToolContext) => Promise<{ task: any | null }> | { task: any | null };
  cancel?: (params: { taskId: string }, context: McpToolContext) => Promise<{ ok: boolean; status: string }> | { ok: boolean; status: string };
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
  options: { timeoutMs: number }
) => Promise<any>;

export interface CodeModeOptions {
  /** Human- and agent-readable typed SDK entries searchable via `search(query)`. */
  spec: CodeModeSpecEntry[];
  /** Builds the caller-scoped SDK methods injected as `pod` inside `execute(code)`. */
  createSdk: (context: McpToolContext) => Record<string, (...args: any[]) => Promise<any> | any>;
  /**
   * Optional custom sandbox executor (e.g. Cloudflare Dynamic Worker Loader in production).
   * When omitted, falls back to a restricted Node `vm` isolate with external network and globals stripped.
   */
  executor?: CodeModeExecutor;
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

function negotiateProtocolVersion(request: Request, fallback: string): string {
  const header = request.headers.get("Mcp-Version") || request.headers.get("mcp-protocol-version");
  if (!header) return fallback;
  if (header.startsWith("2024")) return MCP_V1_PROTOCOL_VERSION;
  if (header.startsWith("2026")) return MCP_V2_PROTOCOL_VERSION;
  return fallback;
}

/**
 * Default restricted sandbox executor for Node.js environments (hermetic tests & local runtime).
 * Strips global `fetch`, `process`, `require`, `globalThis` escape hatches, and enforces timeout.
 * In Cloudflare Workers, pass a Dynamic Worker Loader `executor` in `CodeModeOptions`.
 */
export async function defaultRestrictedCodeExecutor(
  code: string,
  sdk: Record<string, (...args: any[]) => Promise<any> | any>,
  options: { timeoutMs: number }
): Promise<any> {
  // Reject obvious prototype/constructor escape attempts before execution
  if (/\b(?:process|require|import|globalThis|global|Function|eval|fetch|WebSocket|XMLHttpRequest)\b/.test(code)) {
    throw new Error("Sandbox policy violation: forbidden global or host primitive referenced");
  }
  if (/constructor\s*\.\s*constructor|__proto__|prototype\s*\[/.test(code)) {
    throw new Error("Sandbox policy violation: prototype traversal is not permitted");
  }

  // Dynamically load node:vm only when executing in Node.js (keeps Cloudflare Worker bundles clean)
  let vm: any;
  try {
    const spec = "node:" + "vm";
    vm = await import(/* @vite-ignore */ spec);
  } catch {
    throw new Error("No Code Mode sandbox executor configured for this runtime (provide codeMode.executor)");
  }

  const frozenPod: Record<string, any> = Object.create(null);
  for (const [key, fn] of Object.entries(sdk)) {
    if (typeof fn === "function") {
      frozenPod[key] = (...args: any[]) => fn(...args);
    }
  }
  Object.freeze(frozenPod);

  const sandbox: Record<string, any> = Object.create(null);
  sandbox.pod = frozenPod;
  sandbox.JSON = JSON;
  sandbox.Math = Math;
  sandbox.Date = Date;
  sandbox.Array = Array;
  sandbox.Object = Object;
  sandbox.Number = Number;
  sandbox.String = String;
  sandbox.Boolean = Boolean;
  sandbox.Map = Map;
  sandbox.Set = Set;
  sandbox.Promise = Promise;
  sandbox.fetch = undefined;
  sandbox.process = undefined;
  sandbox.require = undefined;

  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  const wrapped = `(async () => {\n${code}\n})()`;
  const script = new vm.Script(wrapped, { filename: "code-mode-sandbox.js" });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const execPromise = Promise.resolve(
      script.runInContext(context, { timeout: options.timeoutMs })
    );
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Code Mode execution timed out after ${options.timeoutMs}ms`)),
        options.timeoutMs
      );
    });
    return await Promise.race([execPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const executor = options.executor ?? defaultRestrictedCodeExecutor;

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
      description: "Execute a short JS snippet inside a network-disabled sandbox with the caller-scoped `pod` SDK bound. Return a JSON-serializable result.",
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
        const value = await executor(code, sdk, { timeoutMs });
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

  // Combine core contract tools + pod-specific tools + optional Code Mode tools
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

  const buildCapabilities = () => ({
    tools: { listChanged: false },
    ...(tasks ? { tasks: { list: true, get: true, cancel: Boolean(tasks.cancel) } } : {}),
    ...(resourceMap.size > 0 ? { resources: { subscribe: false } } : {}),
    ...(codeMode ? { experimental: { codeMode: { search: true, execute: true } } } : {}),
  });

  const checkAuth = async (request: Request): Promise<boolean> => {
    if (authGate) return await authGate(request);
    if (!bearerToken) return true;
    const auth = request.headers.get("authorization") || request.headers.get("Authorization");
    if (!auth) return false;
    return auth === `Bearer ${bearerToken}`;
  };

  async function processSingleRpc(
    body: JsonRpcRequest,
    request: Request,
    env: any,
    protocolVersion: string
  ): Promise<{ status: number; response: JsonRpcResponse | null }> {
    if (!body || typeof body !== "object") {
      return {
        status: 400,
        response: {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid Request: expected JSON-RPC object" },
        },
      };
    }

    const { jsonrpc, id = null, method: rpcMethod, params = {} } = body;

    if (jsonrpc !== "2.0" || typeof rpcMethod !== "string") {
      return {
        status: 400,
        response: {
          jsonrpc: "2.0",
          id,
          error: { code: -32600, message: "Invalid Request: jsonrpc must be '2.0'" },
        },
      };
    }

    // 1. initialize handshake
    if (rpcMethod === "initialize") {
      const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : protocolVersion;
      const negotiated = requested.startsWith("2024") ? MCP_V1_PROTOCOL_VERSION : protocolVersion;
      return {
        status: 200,
        response: {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: negotiated,
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

    // 2. notifications (e.g. notifications/initialized)
    if (rpcMethod.startsWith("notifications/")) {
      return { status: 204, response: null };
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
      const toolName = params.name;
      const toolArgs = params.arguments || {};
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

    // 6. MCP v2 Tasks extension
    if (rpcMethod === "tasks/list" && tasks) {
      try {
        const res = await tasks.list(params || {}, context);
        return { status: 200, response: { jsonrpc: "2.0", id, result: res } };
      } catch (err: any) {
        return {
          status: 500,
          response: { jsonrpc: "2.0", id, error: { code: -32000, message: err?.message || "tasks/list failed" } },
        };
      }
    }

    if (rpcMethod === "tasks/get" && tasks) {
      try {
        const res = await tasks.get({ taskId: String(params?.taskId ?? "") }, context);
        return { status: 200, response: { jsonrpc: "2.0", id, result: res } };
      } catch (err: any) {
        return {
          status: 500,
          response: { jsonrpc: "2.0", id, error: { code: -32000, message: err?.message || "tasks/get failed" } },
        };
      }
    }

    if (rpcMethod === "tasks/cancel" && tasks?.cancel) {
      try {
        const res = await tasks.cancel({ taskId: String(params?.taskId ?? "") }, context);
        return { status: 200, response: { jsonrpc: "2.0", id, result: res } };
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
      const uri = typeof params?.uri === "string" ? params.uri : "";
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
    const protocolVersion = negotiateProtocolVersion(request, defaultProtocolVersion);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Version, Mcp-Protocol-Version",
      "Mcp-Version": protocolVersion,
    };

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

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
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }

    // Auth verification on POST
    if (!(await checkAuth(request))) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32001, message: "Unauthorized: Invalid or missing Bearer token" },
        }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Batch JSON-RPC support (MCP v2)
    if (Array.isArray(body)) {
      if (body.length === 0) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Invalid Request: empty batch" },
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const settled = await Promise.all(
        body.map((reqItem) => processSingleRpc(reqItem, request, env, protocolVersion))
      );
      const responses = settled.map((s) => s.response).filter((r): r is JsonRpcResponse => r !== null);
      if (responses.length === 0) {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      return new Response(JSON.stringify(responses), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { status, response } = await processSingleRpc(body, request, env, protocolVersion);
    if (response === null) {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    return new Response(JSON.stringify(response), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  };
}
