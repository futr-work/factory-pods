// Governor-mediated inference: the one place a provider key is used. A pod asks for a completion, the
// governor resolves a model it has measured, calls the provider with its own credential, records the usage
// (so the daily analyzer sees it), and returns the text. Pods therefore hold no provider keys at all.

import type { PodStorage } from "@futr-work/pod-kernel/storage";
import { mapModel, recordUsage, resolveOptimalModel, type ModelEntry } from "./governor.js";

export interface InferenceEnv {
  OPENROUTER_API_KEY?: string;
  ORCAROUTER_API_KEY?: string;
  ORCAROUTER_BASE_URL?: string;
}

export interface InferenceRequest {
  podId: string;
  taskId?: string;
  /** Category to route within when the caller names no model. */
  category?: string;
  /** A catalog id (e.g. `openrouter:acme/model`) or a model name. Omitted = route the best qualified model. */
  model?: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  maxTokens?: number;
  /** Families that must not serve this request, e.g. the producer's own family for a cross-family audit. */
  excludeFamily?: string;
}

export type InferenceResult =
  | { ok: true; model: string; provider: string; content: string; usage: { promptTokens: number; completionTokens: number }; latencyMs: number }
  | { ok: false; status: number; error: string; model?: string };

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Providers with an HTTP chat endpoint the governor can call. OAuth subscription models (tier OAUTH) are
 * driven by a local CLI on the operator's machine, not by an HTTP request, so they are never routed here.
 */
export const CALLABLE_PROVIDERS = new Set(["openrouter", "orcarouter"]);

function endpoint(provider: string, env: InferenceEnv): { url: string; key?: string } {
  if (provider === "orcarouter") {
    return { url: `${env.ORCAROUTER_BASE_URL || "https://api.orcarouter.ai/v1"}/chat/completions`, key: env.ORCAROUTER_API_KEY };
  }
  return { url: "https://openrouter.ai/api/v1/chat/completions", key: env.OPENROUTER_API_KEY };
}

type ModelLookup = { ok: true; model: ModelEntry } | { ok: false; status: number; error: string };

/** Routes to a callable, approved model: the providers that answer HTTP, best quality first. */
async function routeModel(db: PodStorage, request: InferenceRequest): Promise<ModelEntry | null> {
  const routed = await resolveOptimalModel(db, request.category ?? "general_reasoning", {
    excludeFamily: request.excludeFamily,
    allowedProviders: [...CALLABLE_PROVIDERS],
  });
  return routed ?? null;
}

async function findModel(db: PodStorage, request: InferenceRequest): Promise<ModelLookup> {
  if (!request.model) {
    const routed = await routeModel(db, request);
    return routed ? { ok: true, model: routed } : { ok: false, status: 404, error: "no qualified model for this request" };
  }
  const row = await db
    .prepare("SELECT * FROM model_catalog WHERE id = ? OR model_name = ? LIMIT 1")
    .bind(request.model, request.model)
    .first<Record<string, unknown>>();
  // An unknown name is a caller bug, not a routing problem: say so instead of guessing.
  if (!row) return { ok: false, status: 404, error: `unknown model ${request.model}` };
  if (String(row.lifecycle) === "retired") return { ok: false, status: 409, error: `model ${request.model} is retired` };
  // The named model is a preference: when it cannot serve this request, route instead of failing the caller.
  const callable = CALLABLE_PROVIDERS.has(String(row.provider));
  const approved = String(row.tier) !== "PAID" || Boolean(row.approved_by);
  if (callable && approved) return { ok: true, model: mapModel(row) };
  const routed = await routeModel(db, request);
  if (routed) return { ok: true, model: routed };
  const why = !callable
    ? `${String(row.provider)} models run on a local CLI subscription and have no HTTP endpoint`
    : `paid model ${request.model} is not approved`;
  return { ok: false, status: 409, error: `${why}, and no other model is qualified for this request` };
}

export async function runInference(
  db: PodStorage,
  env: InferenceEnv,
  request: InferenceRequest,
  fetcher: Fetcher = (i, init) => fetch(i, init),
): Promise<InferenceResult> {
  const lookup = await findModel(db, request);
  if (!lookup.ok) return lookup;
  const model = lookup.model;
  const { url, key } = endpoint(model.provider, env);
  if (!key) return { ok: false, status: 503, error: `model governor has no ${model.provider} key`, model: model.id };

  const started = Date.now();
  const body = JSON.stringify({
    model: model.modelName,
    messages: request.messages,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
  });
  let res: Response;
  try {
    res = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const latencyMs = Date.now() - started;
    await recordUsage(db, {
      podId: request.podId,
      taskId: request.taskId,
      provider: model.provider,
      modelId: model.id,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs,
      status: "error",
    });
    return { ok: false, status: 502, error: err instanceof Error ? err.message : String(err), model: model.id };
  }
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    await recordUsage(db, {
      podId: request.podId,
      taskId: request.taskId,
      provider: model.provider,
      modelId: model.id,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs,
      status: res.status === 429 ? "rate_limited" : "error",
    });
    if (res.status === 429) {
      await db
        .prepare("UPDATE model_catalog SET status = 'rate_limited', last_benchmarked_at = ? WHERE id = ?")
        .bind(Date.now(), model.id)
        .run()
        .catch(() => {});
    }
    return { ok: false, status: res.status, error: `provider returned HTTP ${res.status}`, model: model.id };
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const promptTokens = Number(data.usage?.prompt_tokens ?? 0);
  const completionTokens = Number(data.usage?.completion_tokens ?? 0);
  await recordUsage(db, {
    podId: request.podId,
    taskId: request.taskId,
    provider: model.provider,
    modelId: model.id,
    promptTokens,
    completionTokens,
    latencyMs,
    status: "success",
  });
  return {
    ok: true,
    model: model.id,
    provider: model.provider,
    content: String(data.choices?.[0]?.message?.content ?? ""),
    usage: { promptTokens, completionTokens },
    latencyMs,
  };
}
