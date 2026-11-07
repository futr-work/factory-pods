// @futr-work/pod-kernel: Stateless MCP 2026-07-28 server implementation

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { PodReceipt } from "./types.js";

export interface PodTaskHandlers {
  onSubmitTask: (params: {
    repo: string;
    issue: number;
    requestId: string;
    remote?: string;
    title?: string;
    body?: string;
  }) => Promise<{ taskId: string; requestId: string; phase: string; status: string; existing: boolean }>;

  onTaskStatus: (params: {
    taskId?: string;
    requestId?: string;
  }) => Promise<{ taskId: string; phase: string; status: string; checks?: string[]; diffHash?: string; error?: string }>;

  onApprove: (params: {
    taskId: string;
    decision: "approve" | "reject";
  }) => Promise<{ ok: boolean; decision: string }>;

  onCancel: (params: {
    taskId: string;
  }) => Promise<{ ok: boolean; status: string }>;

  onGetReceipt: (params: {
    taskId: string;
  }) => Promise<PodReceipt>;
}

export interface PodServerOptions {
  podName: string;
  port: number;
  host?: string;
  bearerToken?: string;
  handlers: PodTaskHandlers;
}

export function buildMcpServer(podName: string, handlers: PodTaskHandlers): McpServer {
  const server = new McpServer({
    name: podName,
    version: "1.0.0",
  });

  server.tool(
    "submit_task",
    "Submit an issue to be worked by the pod. Idempotent on requestId.",
    {
      repo: z.string().describe("Target repository owner/name"),
      issue: z.number().describe("GitHub issue number"),
      requestId: z.string().describe("Unique idempotency key"),
      remote: z.string().optional().describe("Git remote clone URL"),
      title: z.string().optional().describe("Issue title"),
      body: z.string().optional().describe("Issue description"),
    },
    async (args) => {
      const res = await handlers.onSubmitTask(args);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    },
  );

  server.tool(
    "task_status",
    "Get the current phase, status, and outcome of a task by taskId or requestId.",
    {
      taskId: z.string().optional().describe("Task ID"),
      requestId: z.string().optional().describe("Request ID"),
    },
    async (args) => {
      const res = await handlers.onTaskStatus(args);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    },
  );

  server.tool(
    "approve",
    "Submit human or external decision ('approve' | 'reject') for a task in await_approval.",
    {
      taskId: z.string().describe("Task ID to approve or reject"),
      decision: z.enum(["approve", "reject"]).describe("Approval decision"),
    },
    async (args) => {
      const res = await handlers.onApprove(args);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    },
  );

  server.tool(
    "cancel",
    "Durably abort a running or pending task.",
    {
      taskId: z.string().describe("Task ID to cancel"),
    },
    async (args) => {
      const res = await handlers.onCancel(args);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    },
  );

  server.tool(
    "get_receipt",
    "Fetch cryptographic receipt for a completed task (diff hash, verify results, commit, PR).",
    {
      taskId: z.string().describe("Task ID"),
    },
    async (args) => {
      const res = await handlers.onGetReceipt(args);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    },
  );

  return server;
}

export async function startPodMcpServer(options: PodServerOptions) {
  const { podName, port, host = "0.0.0.0", bearerToken, handlers } = options;

  const checkAuth = (req: IncomingMessage): boolean => {
    if (!bearerToken) return true;
    const auth = req.headers.authorization;
    return auth === `Bearer ${bearerToken}`;
  };

  const toWebRequest = async (req: IncomingMessage): Promise<Request> => {
    const protocol = "http";
    const hostHeader = req.headers.host ?? `${host}:${port}`;
    const url = new URL(req.url ?? "/", `${protocol}://${hostHeader}`);

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) headers.append(k, item);
      } else {
        headers.set(k, v);
      }
    }

    return new Request(url, {
      method: req.method,
      headers,
      body,
      // @ts-ignore
      duplex: "half",
    });
  };

  const sendWebResponse = async (webRes: Response, res: ServerResponse) => {
    res.statusCode = webRes.status;
    webRes.headers.forEach((v, k) => res.setHeader(k, v));
    if (webRes.body) {
      const reader = webRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  };

  const httpServer = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/health" && req.method === "GET") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok", pod: podName, version: "1.0.0" }));
      return;
    }

    if (path === "/mcp") {
      if (!checkAuth(req)) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      try {
        const webReq = await toWebRequest(req);
        const serverInstance = buildMcpServer(podName, handlers);
        const transport = new WebStandardStreamableHTTPServerTransport();

        await serverInstance.connect(transport);
        const webRes = await transport.handleRequest(webReq);
        await sendWebResponse(webRes, res);
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "not_found" }));
  });

  return new Promise<{ server: typeof httpServer; port: number; close: () => Promise<void> }>((resolve, reject) => {
    httpServer.listen(port, host, () => {
      const addr = httpServer.address() as any;
      const actualPort = addr.port;
      resolve({
        server: httpServer,
        port: actualPort,
        close: async () => {
          return new Promise<void>((r) => httpServer.close(() => r()));
        },
      });
    });
    httpServer.on("error", reject);
  });
}
