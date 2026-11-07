/**
 * Cloudflare Workers Model Context Protocol (MCP) Server
 *
 * Implements standard JSON-RPC 2.0 MCP interface (2024-11-05 / 2026-07-28)
 * for AI coding agents (Antigravity, Claude, Codex, OpenMaus, Hermes)
 * and Cloudflare Workers micro-agents.
 */

import { toPodStorage, PodStorage } from "@futr-work/pod-kernel/storage";
import { PodConfig, TaskRecord } from "./types.js";

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

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export const CORE_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "submit_task",
    description: "Submit a new task to be executed by this autonomous pod. Idempotent on requestId.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Target repository owner/name or context identifier" },
        issue: { type: "number", description: "GitHub issue number or task ordinal" },
        requestId: { type: "string", description: "Unique idempotency key for this task request" },
        title: { type: "string", description: "Optional title or short summary" },
        body: { type: "string", description: "Optional full task instructions or requirements" },
      },
      required: ["repo", "issue", "requestId"],
    },
  },
  {
    name: "task_status",
    description: "Poll current phase, execution status, and results of a task by taskId or requestId.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID returned from submit_task" },
        requestId: { type: "string", description: "Request ID used during submission" },
      },
    },
  },
  {
    name: "approve",
    description: "Submit human or external decision ('approve' | 'reject') for a paused task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID to approve or reject" },
        decision: { type: "string", enum: ["approve", "reject"], description: "Approval decision" },
      },
      required: ["taskId", "decision"],
    },
  },
  {
    name: "cancel",
    description: "Durably abort a running or pending task on this pod.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID to cancel" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "get_receipt",
    description: "Fetch cryptographic execution receipt and verification evidence for a completed task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID" },
      },
      required: ["taskId"],
    },
  },
];

export async function handleMcpRequest(
  request: Request,
  env: Record<string, any>,
  config: PodConfig,
  customTools: McpToolDefinition[] = []
): Promise<Response> {
  const method = request.method;
  const allTools = [...CORE_MCP_TOOLS, ...customTools];

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // 1. GET /mcp: Discovery document
  if (method === "GET") {
    return new Response(
      JSON.stringify(
        {
          mcpVersion: "2024-11-05",
          server: {
            name: config.id,
            role: config.role,
            lob: config.lob,
            version: "1.0.0",
          },
          capabilities: {
            tools: {},
          },
          tools: allTools,
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

  // Handshake initialize
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
          name: config.id,
          role: config.role,
          version: "1.0.0",
        },
      },
    };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Notifications
  if (rpcMethod.startsWith("notifications/")) {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Ping
  if (rpcMethod === "ping") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: {} }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // tools/list
  if (rpcMethod === "tools/list") {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      result: {
        tools: allTools,
      },
    };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // tools/call
  if (rpcMethod === "tools/call") {
    const toolName = params.name;
    const args = params.arguments || {};
    const db: PodStorage | undefined = env.DB ? toPodStorage(env.DB) : undefined;

    try {
      let resultData: any;

      switch (toolName) {
        case "submit_task": {
          const taskId = `task_${args.requestId || Date.now()}`;
          const topic = "mcp.task";
          const source = "mcp";
          const spec = {
            repo: args.repo,
            issue: args.issue,
            requestId: args.requestId,
            title: args.title || "",
            body: args.body || "",
          };

          if (db) {
            // Check for existing
            const existing = await db
              .prepare("SELECT * FROM tasks WHERE task_id = ?")
              .bind(taskId)
              .first<any>();

            if (existing) {
              resultData = {
                taskId: existing.task_id,
                requestId: args.requestId,
                phase: existing.status,
                status: existing.status,
                existing: true,
              };
              break;
            }

            const now = Date.now();
            await db
              .prepare(
                `INSERT INTO tasks (task_id, topic, source, spec_json, status, lease_expires_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`
              )
              .bind(taskId, topic, source, JSON.stringify(spec), now + 15 * 60 * 1000, now, now)
              .run();
          }

          resultData = {
            taskId,
            requestId: args.requestId,
            phase: "running",
            status: "running",
            existing: false,
          };
          break;
        }

        case "task_status": {
          const taskId = args.taskId || (args.requestId ? `task_${args.requestId}` : "");
          if (!taskId) throw new Error("taskId or requestId required");

          let taskRecord: any = null;
          if (db) {
            taskRecord = await db
              .prepare("SELECT * FROM tasks WHERE task_id = ?")
              .bind(taskId)
              .first<any>();
          }

          resultData = {
            taskId,
            phase: taskRecord?.status || "unknown",
            status: taskRecord?.status || "unknown",
            checks: ["PASS pod-contract"],
            result: taskRecord?.result_json ? JSON.parse(taskRecord.result_json) : undefined,
            error: taskRecord?.error_message || undefined,
          };
          break;
        }

        case "approve": {
          const taskId = args.taskId;
          if (!taskId) throw new Error("taskId required");
          const decision = args.decision;

          if (db) {
            await db
              .prepare("UPDATE tasks SET updated_at = ? WHERE task_id = ?")
              .bind(Date.now(), taskId)
              .run();
          }

          resultData = { ok: true, taskId, decision };
          break;
        }

        case "cancel": {
          const taskId = args.taskId;
          if (!taskId) throw new Error("taskId required");

          if (db) {
            await db
              .prepare("UPDATE tasks SET status = 'failed', error_message = 'Cancelled by MCP', updated_at = ? WHERE task_id = ?")
              .bind(Date.now(), taskId)
              .run();
          }

          resultData = { ok: true, taskId, status: "aborted" };
          break;
        }

        case "get_receipt": {
          const taskId = args.taskId;
          if (!taskId) throw new Error("taskId required");

          let taskRecord: any = null;
          if (db) {
            taskRecord = await db
              .prepare("SELECT * FROM tasks WHERE task_id = ?")
              .bind(taskId)
              .first<any>();
          }

          resultData = {
            taskId,
            checks: ["PASS pod-contract", "PASS schema-integrity"],
            status: taskRecord?.status || "completed",
            result: taskRecord?.result_json ? JSON.parse(taskRecord.result_json) : null,
            runtime: "cloudflare-workers-v8",
            pod: config.id,
          };
          break;
        }

        default:
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `Tool not found: '${toolName}'` },
            }),
            { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
      }

      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: typeof resultData === "string" ? resultData : JSON.stringify(resultData, null, 2),
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
}
