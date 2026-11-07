// @futr-work/pod-kernel: Standard MCP v2 Pod Client

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PodReceipt } from "./types.js";

export interface PodClientOptions {
  baseUrl: string; // e.g. "http://127.0.0.1:8875/mcp"
  bearerToken?: string;
  timeoutMs?: number;
}

export interface SubmitTaskParams {
  repo: string;
  issue: number;
  requestId: string;
  remote?: string;
  title?: string;
  body?: string;
}

export interface TaskStatusParams {
  taskId?: string | number;
  requestId?: string;
}

export interface ApproveParams {
  taskId: string | number;
  decision: "approve" | "reject";
}

export interface CancelParams {
  taskId: string | number;
}

export interface GetReceiptParams {
  taskId: string | number;
}

export class PodClient {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private connected = false;
  private baseUrl: string;

  constructor(options: PodClientOptions) {
    this.baseUrl = options.baseUrl;
    const headers: Record<string, string> = {};
    if (options.bearerToken) {
      headers.Authorization = `Bearer ${options.bearerToken}`;
    }

    this.transport = new StreamableHTTPClientTransport(new URL(options.baseUrl), {
      requestInit: { headers },
    });

    this.client = new Client(
      { name: "pod-kernel-client", version: "1.0.0" },
      { capabilities: {} },
    );
  }

  private async ensureConnected() {
    if (!this.connected) {
      await this.client.connect(this.transport);
      this.connected = true;
    }
  }

  async health(): Promise<{ status: string; pod?: string }> {
    const healthUrl = this.baseUrl.replace(/\/mcp$/, "/health");
    const res = await fetch(healthUrl);
    return (await res.json()) as any;
  }

  async listTools() {
    await this.ensureConnected();
    return this.client.listTools();
  }

  async submitTask(params: SubmitTaskParams): Promise<{
    taskId: string;
    requestId: string;
    phase: string;
    status: string;
    existing: boolean;
  }> {
    await this.ensureConnected();
    const res = await this.client.callTool({
      name: "submit_task",
      arguments: {
        repo: params.repo,
        issue: params.issue,
        requestId: params.requestId,
        remote: params.remote,
        title: params.title,
        body: params.body,
      },
    });
    const text = (res.content as any)?.[0]?.text;
    return JSON.parse(text);
  }

  async taskStatus(params: TaskStatusParams): Promise<{
    taskId: string;
    phase: string;
    status: string;
    checks?: string[];
    diffHash?: string;
    error?: string;
  }> {
    await this.ensureConnected();
    const res = await this.client.callTool({
      name: "task_status",
      arguments: {
        taskId: params.taskId ? String(params.taskId) : undefined,
        requestId: params.requestId,
      },
    });
    const text = (res.content as any)?.[0]?.text;
    return JSON.parse(text);
  }

  async approve(params: ApproveParams): Promise<{ ok: boolean; decision: string }> {
    await this.ensureConnected();
    const res = await this.client.callTool({
      name: "approve",
      arguments: {
        taskId: String(params.taskId),
        decision: params.decision,
      },
    });
    const text = (res.content as any)?.[0]?.text;
    return JSON.parse(text);
  }

  async cancel(params: CancelParams): Promise<{ ok: boolean; status: string }> {
    await this.ensureConnected();
    const res = await this.client.callTool({
      name: "cancel",
      arguments: {
        taskId: String(params.taskId),
      },
    });
    const text = (res.content as any)?.[0]?.text;
    return JSON.parse(text);
  }

  async getReceipt(params: GetReceiptParams): Promise<PodReceipt> {
    await this.ensureConnected();
    const res = await this.client.callTool({
      name: "get_receipt",
      arguments: {
        taskId: String(params.taskId),
      },
    });
    const text = (res.content as any)?.[0]?.text;
    return JSON.parse(text);
  }

  async close() {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}

export function createPodClient(options: PodClientOptions): PodClient {
  return new PodClient(options);
}
