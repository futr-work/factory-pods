import { PodStorage } from "@futr-work/pod-kernel/storage";

export interface PodConfig {
  id: string;
  name: string;
  role: string;
  lob: string;
  capabilities: string[];
  hubUrl: string;
  /** Bearer credential for the Factory Hub gate (FACTORY_HUB_TOKEN). */
  hubToken?: string;
  apiKey?: string;
  port?: number;
}

export type TaskStatus = "pending" | "running" | "completed" | "failed";

export interface TaskRecord<TSpec = any, TResult = any> {
  id: number;
  taskId: string;
  topic: string;
  source: string;
  spec: TSpec;
  status: TaskStatus;
  result?: TResult;
  errorMessage?: string;
  leaseExpiresAt?: number;
  retryCount?: number;
  maxRetries?: number;
  createdAt: number;
  updatedAt: number;
}

export interface EpisodeRecord {
  id: number;
  taskId: string;
  topic: string;
  specSummary: string;
  actionTaken: string;
  outcome: string;
  confidence: number;
  latencyMs: number;
  createdAt: number;
}

export interface BeliefRecord {
  id: string;
  domain: string;
  claim: string;
  confidence: number;
  evidenceCount: number;
  sourceEpisodesJson?: string;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConsolidationSummary {
  episodesAnalyzed: number;
  beliefsSynthesized: number;
  beliefsDecayed: number;
  habitsCompiled: number;
  timestamp: number;
}

export interface HandlerContext {
  podConfig: PodConfig;
  now: number;
  publishEvent: (topic: string, toPod: string, payload: any) => Promise<void>;
  storage?: PodStorage;
  db?: PodStorage;
  ai?: {
    run: (model: string, input: Record<string, any>) => Promise<any>;
  };
  modelGovernorUrl?: string;
  recallEpisodes?: (topic: string, limit?: number) => Promise<EpisodeRecord[]>;
  recordEpisode?: (episode: Omit<EpisodeRecord, "id" | "createdAt">) => Promise<void>;
  recallBeliefs?: (domain: string, limit?: number) => Promise<BeliefRecord[]>;
  recordBelief?: (belief: Omit<BeliefRecord, "createdAt" | "updatedAt">) => Promise<void>;
}

export interface TaskHandler<TSpec = any, TResult = any> {
  name: string;
  canHandle(topic: string, spec: TSpec): boolean;
  handle(task: TaskRecord<TSpec>, context: HandlerContext): Promise<TResult>;
}

export type { TincanEnvelope } from "@futr-work/pod-kernel/tincan";

/**
 * Byte-accurate payload guardrail.
 * Enforces UTF-8 byte limits to avoid D1 row overflow (>1MB limit) and runaway prompt context.
 */
export function boundPayload<T>(payload: T, maxBytes = 64_000): T {
  if (payload === undefined || payload === null) return payload;
  try {
    const json = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(json);
    if (bytes.length <= maxBytes) {
      return payload;
    }
    return {
      ...(typeof payload === "object" ? payload : {}),
      _truncated: true,
      _originalByteSize: bytes.length,
      _maxBytes: maxBytes,
      _preview: json.substring(0, 1000) + "... [TRUNCATED DUE TO BYTE LIMIT]",
    } as unknown as T;
  } catch {
    return payload;
  }
}
