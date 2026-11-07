/**
 * Standard Universal Pod Connector
 *
 * Lightweight, zero-dependency client for communicating with any Factory Pod
 * over Cloudflare Workers MCP v2 or HTTP REST.
 *
 * Works in Node.js 18+, Bun, Cloudflare Workers, and modern browsers.
 */

export interface PodConnectorOptions {
  baseUrl: string;
  bearerToken?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface SubmitTaskArgs {
  repo: string;
  issue: number;
  requestId: string;
  remote?: string;
  title?: string;
  body?: string;
}

export interface TaskStatusArgs {
  taskId?: string | number;
  requestId?: string;
}

export interface ApproveArgs {
  taskId: string | number;
  decision: "approve" | "reject";
}

export interface CancelArgs {
  taskId: string | number;
}

export interface GetReceiptArgs {
  taskId: string | number;
}

export interface PodToolSummary {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface PodDiscoveryResult {
  mcpVersion: string;
  server: {
    name: string;
    role: string;
    version: string;
    [key: string]: any;
  };
  capabilities: Record<string, any>;
  tools: PodToolSummary[];
}

export class PodConnector {
  private baseUrl: string;
  private bearerToken?: string;
  private timeoutMs: number;
  private fetchFn: typeof fetch;

  constructor(options: PodConnectorOptions | string) {
    if (typeof options === "string") {
      this.baseUrl = options.replace(/\/+$/, "");
      this.timeoutMs = 30000;
      this.fetchFn = globalThis.fetch.bind(globalThis);
    } else {
      this.baseUrl = (options.baseUrl || "http://127.0.0.1:8787").replace(/\/+$/, "");
      this.bearerToken = options.bearerToken;
      this.timeoutMs = options.timeoutMs ?? 30000;
      this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    }

    if (this.baseUrl.endsWith("/mcp")) {
      this.baseUrl = this.baseUrl.replace(/\/mcp$/, "");
    }
  }

  public get mcpEndpoint(): string {
    return `${this.baseUrl}/mcp`;
  }

  public get rootUrl(): string {
    return this.baseUrl;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.bearerToken) {
      headers["Authorization"] = `Bearer ${this.bearerToken}`;
    }
    return headers;
  }

  async health(): Promise<{ status: string; podId?: string; name?: string; role?: string; version?: string }> {
    const res = await this.fetchFn(`${this.baseUrl}/health`, {
      method: "GET",
      headers: this.buildHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Health check failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as any;
  }

  async discover(): Promise<PodDiscoveryResult> {
    const res = await this.fetchFn(this.mcpEndpoint, {
      method: "GET",
      headers: this.buildHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Pod discovery failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as PodDiscoveryResult;
  }

  async listTools(): Promise<PodToolSummary[]> {
    const res = await this.rpcCall<{ tools: PodToolSummary[] }>("tools/list");
    return res.tools || [];
  }

  async callTool<T = any>(name: string, args: Record<string, any> = {}): Promise<T> {
    const res = await this.rpcCall<any>("tools/call", { name, arguments: args });
    const content = res?.content?.[0];
    if (!content) return res as T;

    if (content.type === "text" && typeof content.text === "string") {
      try {
        return JSON.parse(content.text) as T;
      } catch {
        return content.text as unknown as T;
      }
    }
    return content as T;
  }

  async submitTask(args: SubmitTaskArgs): Promise<any> {
    return this.callTool("submit_task", args);
  }

  async taskStatus(args: TaskStatusArgs): Promise<any> {
    return this.callTool("task_status", args);
  }

  async approve(args: ApproveArgs): Promise<any> {
    return this.callTool("approve", args);
  }

  async cancel(args: CancelArgs): Promise<any> {
    return this.callTool("cancel", args);
  }

  async getReceipt(args: GetReceiptArgs): Promise<any> {
    return this.callTool("get_receipt", args);
  }

  async rpcCall<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    const payload = {
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1000000),
      method,
      params,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchFn(this.mcpEndpoint, {
        method: "POST",
        headers: {
          ...this.buildHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`MCP HTTP ${res.status}: ${errText}`);
      }

      if (res.status === 204) {
        return null as unknown as T;
      }

      const json = (await res.json()) as any;
      if (json.error) {
        throw new Error(`MCP RPC Error ${json.error.code}: ${json.error.message}`);
      }

      return json.result as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export function createPodConnector(options: PodConnectorOptions | string): PodConnector {
  return new PodConnector(options);
}
