// @futr-work/pod-kernel: Edge-native Cloudflare Workers MCP v2 Server
// Implements JSON-RPC 2.0 Model Context Protocol (2024-11-05 / 2026-07-28)
// Runs natively in Cloudflare Workers V8 isolates, Bun, and Node.js without node:http dependencies.

import type { PodReceipt } from "./types.js";

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

export interface McpToolContext {
  request: Request;
  env?: any;
  podName: string;
  podRole?: string;
  now: number;
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
  authGate?: (request: Request) => boolean;
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
 * Creates an edge-native Cloudflare Workers MCP v2 HTTP fetch handler
 */
export function createEdgeMcpHandler(options: EdgeMcpServerOptions) {
  const {
    podName,
    podRole = "worker",
    version = "1.0.0",
    bearerToken,
    authGate,
  } = options;

  // Combine core contract tools + pod-specific tools
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

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  const checkAuth = (request: Request): boolean => {
    if (authGate) return authGate(request);
    if (!bearerToken) return true;
    const auth = request.headers.get("authorization") || request.headers.get("Authorization");
    if (!auth) return false;
    return auth === `Bearer ${bearerToken}`;
  };

  return async function handleMcpRequest(request: Request, env?: any): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 1. GET /mcp: Discovery document (open without credentials for capability inspection)
    if (method === "GET") {
      const toolSummaries = Array.from(toolMap.values()).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

      return new Response(
        JSON.stringify({
          mcpVersion: "2024-11-05",
          server: {
            name: podName,
            role: podRole,
            version,
          },
          capabilities: {
            tools: {},
          },
          tools: toolSummaries,
        }, null, 2),
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
    if (!checkAuth(request)) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32001, message: "Unauthorized: Invalid or missing Bearer token" },
        }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let body: JsonRpcRequest;
    try {
      body = (await request.json()) as JsonRpcRequest;
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

    const { jsonrpc, id = null, method: rpcMethod, params = {} } = body;

    if (jsonrpc !== "2.0") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32600, message: "Invalid Request: jsonrpc must be '2.0'" },
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. initialize handshake
    if (rpcMethod === "initialize") {
      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: podName,
            role: podRole,
            version,
          },
        },
      };
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. notifications (e.g. notifications/initialized)
    if (rpcMethod.startsWith("notifications/")) {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 4. ping
    if (rpcMethod === "ping") {
      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id,
        result: {},
      };
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 5. tools/list
    if (rpcMethod === "tools/list") {
      const toolSummaries = Array.from(toolMap.values()).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id,
        result: {
          tools: toolSummaries,
        },
      };
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 6. tools/call
    if (rpcMethod === "tools/call") {
      const toolName = params.name;
      const toolArgs = params.arguments || {};
      const tool = toolMap.get(toolName);

      if (!tool) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Tool not found: '${toolName}'` },
          }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const context: McpToolContext = {
        request,
        env,
        podName,
        podRole,
        now: Date.now(),
      };

      try {
        const result = await tool.handler(toolArgs, context);
        const textContent = typeof result === "string" ? result : JSON.stringify(result, null, 2);

        const response: JsonRpcResponse = {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: textContent,
              },
            ],
          },
        };

        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err: any) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: err.message || "Tool execution failed" },
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Unknown method
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: '${rpcMethod}'` },
      }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  };
}
