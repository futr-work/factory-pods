// Shared Tincan mesh clients for factory pods. Single source for every pod; edge-safe (no Node APIs).

/** Structural subset of a pod's config that the Tincan client needs. */
export interface TincanClientConfig {
  id: string;
  name: string;
  role: string;
  lob: string;
  capabilities: string[];
  hubUrl: string;
  /** Bearer credential for the Factory Hub gate (FACTORY_HUB_TOKEN). */
  hubToken?: string;
}

export interface TincanEnvelope<T = any> {
  id: string;
  topic: string;
  fromPod: string;
  toPod: string;
  payload: T;
  status: "pending" | "delivered" | "acknowledged";
  createdAt: number;
  deliveredAt?: number;
}

export type CustomFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Adds the Factory Hub bearer credential to a request init, preserving existing headers. */
export function withHubAuth(init: RequestInit | undefined, token: string | undefined): RequestInit | undefined {
  if (!token) return init;
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

export class TincanClient {
  private config: TincanClientConfig;
  private fetcher: CustomFetcher;

  constructor(config: TincanClientConfig, serviceBindingOrFetcher?: { fetch: CustomFetcher } | CustomFetcher) {
    this.config = config;
    if (serviceBindingOrFetcher) {
      if (typeof serviceBindingOrFetcher === "function") {
        this.fetcher = serviceBindingOrFetcher;
      } else if (typeof serviceBindingOrFetcher.fetch === "function") {
        this.fetcher = serviceBindingOrFetcher.fetch.bind(serviceBindingOrFetcher);
      } else {
        this.fetcher = (input, init) => fetch(input, init);
      }
    } else {
      this.fetcher = (input, init) => fetch(input, init);
    }
    const base = this.fetcher;
    this.fetcher = (input, init) => base(input, withHubAuth(init, config.hubToken));
  }

  public async sendHeartbeat(): Promise<boolean> {
    try {
      const res = await this.fetcher(`${this.config.hubUrl}/api/tincan/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: "pod.heartbeat",
          fromPod: this.config.id,
          toPod: "pod:pm",
          payload: {
            id: this.config.id,
            name: this.config.name,
            role: this.config.role,
            lob: this.config.lob,
            capabilities: this.config.capabilities,
            timestamp: Date.now(),
          },
        }),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch (err) {
      console.warn(`[tincan-client] Heartbeat to ${this.config.hubUrl} failed:`, err);
      return false;
    }
  }

  public async pollInbox(limit = 10): Promise<TincanEnvelope[]> {
    try {
      const url = `${this.config.hubUrl}/api/tincan/messages?pod=${encodeURIComponent(this.config.id)}&limit=${limit}`;
      const res = await this.fetcher(url, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) return [];
      const data = (await res.json()) as any;
      return Array.isArray(data.messages) ? data.messages : [];
    } catch (err) {
      console.warn(`[tincan-client] Polling ${this.config.hubUrl} failed:`, err);
      return [];
    }
  }

  public async acknowledge(messageId: string): Promise<boolean> {
    try {
      const res = await this.fetcher(`${this.config.hubUrl}/api/tincan/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId }),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch (err) {
      console.warn(`[tincan-client] Ack failed for ${messageId}:`, err);
      return false;
    }
  }

  public async publish<T = any>(topic: string, toPod: string, payload: T): Promise<boolean> {
    try {
      const res = await this.fetcher(`${this.config.hubUrl}/api/tincan/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          fromPod: this.config.id,
          toPod,
          payload,
        }),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch (err) {
      console.warn(`[tincan-client] Publish ${topic} failed:`, err);
      return false;
    }
  }
}

export interface HeartbeatPayload {
  podId: string;
  name: string;
  role: string;
  lob: string;
  endpoint: string;
  status: "healthy" | "degraded" | "failing";
  timestamp: number;
}

/** Heartbeat-only client for pods that push to the hub's `/api/heartbeat` (service binding or HTTP). */
export class TincanMeshClient {
  constructor(
    private hubBinding?: { fetch: typeof fetch },
    private hubUrl?: string,
    private token?: string
  ) {}

  public async sendHeartbeat(payload: HeartbeatPayload): Promise<boolean> {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.token) headers["Authorization"] = `Bearer ${this.token}`;

      if (this.hubBinding) {
        const res = await this.hubBinding.fetch("https://factory-hub/api/heartbeat", {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
        return res.ok;
      }

      if (!this.hubUrl) {
        throw new Error("Factory Hub URL is required when no FACTORY_HUB service binding is configured");
      }

      const res = await fetch(`${this.hubUrl}/api/heartbeat`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
