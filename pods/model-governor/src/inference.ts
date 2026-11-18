// Governor-mediated inference: the one place a provider key is used. A caller sends an OpenAI chat-completions
// body; the governor picks a measured model inside the caller's tier policy and budget, forwards the body
// unchanged except for `model` (tools, tool_choice, structured content, tool-role messages all pass through),
// falls back down the chain on 429/402/5xx, records the usage, and returns the provider's response as-is.
// Callers therefore hold no provider keys at all.
//
// API keys only. OAuth/consumer-subscription backends (Claude Pro/Max, ChatGPT, Gemini/Antigravity logins) are
// never called from here: CALLABLE_PROVIDERS is the allowlist and every entry is a pay-per-use API.

import type { PodStorage } from "@futr-work/pod-kernel/storage";
import { listRoutableModels, mapModel, recordUsage, type LlmUsageStatus, type ModelEntry } from "./governor.js";
import { budgetState, rankCandidates, tierOf, tierOrder, type BudgetState, type RoutingEnv, type Tier } from "./routing.js";

export interface InferenceEnv extends RoutingEnv {
  OPENROUTER_API_KEY?: string;
  ORCAROUTER_API_KEY?: string;
  ORCAROUTER_BASE_URL?: string;
  FIREWORKS_API_KEY?: string;
  FIREWORKS_BASE_URL?: string;
  CEREBRAS_API_KEY?: string;
  CEREBRAS_BASE_URL?: string;
  OPENSCALE_API_KEY?: string;
  OPENSCALE_BASE_URL?: string;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 30_000;
/** Streams can run long; the timeout covers time to response headers, then the body flows freely. */
const STREAM_TIMEOUT_MS = 120_000;
/** Most models one request may try before giving up. */
const MAX_ATTEMPTS = 6;

/**
 * Providers with a pay-per-use HTTP chat endpoint. OAuth subscription models (tier OAUTH) are driven by a local CLI
 * on the operator's machine, not by an HTTP request, so they are never routed here.
 */
export const CALLABLE_PROVIDERS = new Set(["openrouter", "orcarouter", "fireworks", "cerebras", "openscale"]);

function endpoint(provider: string, env: InferenceEnv): { url: string; key?: string } {
  if (provider === "orcarouter") {
    return { url: `${env.ORCAROUTER_BASE_URL || "https://api.orcarouter.ai/v1"}/chat/completions`, key: env.ORCAROUTER_API_KEY };
  }
  if (provider === "fireworks") {
    return { url: `${env.FIREWORKS_BASE_URL || "https://api.fireworks.ai/inference/v1"}/chat/completions`, key: env.FIREWORKS_API_KEY };
  }
  if (provider === "cerebras") {
    return { url: `${env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1"}/chat/completions`, key: env.CEREBRAS_API_KEY };
  }
  if (provider === "openscale") {
    return { url: `${env.OPENSCALE_BASE_URL || "https://api.openscale.so/v1"}/chat/completions`, key: env.OPENSCALE_API_KEY };
  }
  return { url: "https://openrouter.ai/api/v1/chat/completions", key: env.OPENROUTER_API_KEY };
}

export interface ChatRequest {
  /** Who pays: X-Governor-Caller (agent-<id>, team:<name>) or the pod id. Usage is recorded under it. */
  callerId: string;
  taskId?: string;
  /** Category to rank within; falls back to the caller policy's, then general_reasoning. */
  category?: string;
  /** A catalog id or model name to try first. Omitted = route by policy. */
  model?: string;
  /** Families that must not serve this request, e.g. the producer's own family for a cross-family audit. */
  excludeFamily?: string;
  /** The OpenAI chat-completions body, governor-only fields removed. Forwarded unchanged except `model`. */
  body: Record<string, unknown>;
}

export interface Attempt {
  model: string;
  tier: Tier;
  status: number | "skipped";
  reason: string;
}

interface Served {
  model: ModelEntry;
  tier: Tier;
  attempts: Attempt[];
  budget: BudgetState;
}

export type ChatOutcome =
  | (Served & { ok: true; kind: "json"; data: Record<string, any>; latencyMs: number; usage: { promptTokens: number; completionTokens: number } })
  | (Served & { ok: true; kind: "stream"; stream: ReadableStream<Uint8Array> })
  | { ok: false; status: number; error: string; code: string; model?: string; attempts: Attempt[]; budget?: BudgetState };

export function hasTools(body: Record<string, unknown>): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

type Candidate = { model: ModelEntry; tier: Tier };
type Plan = { list: Candidate[]; skipped: Attempt[] } | { error: { status: number; error: string; code: string } };

async function rankedRoutes(db: PodStorage, env: InferenceEnv, request: Pick<ChatRequest, "excludeFamily" | "category">, budget: BudgetState, needsTools: boolean) {
  const routable = await listRoutableModels(db, {
    excludeFamily: request.excludeFamily,
    allowedProviders: [...CALLABLE_PROVIDERS],
    requireTools: needsTools,
  });
  const order = tierOrder(budget.capped ? 0 : budget.policy.preferredTier, budget.effectiveMaxTier);
  const ranked = rankCandidates(routable, request.category ?? budget.policy.category ?? "general_reasoning", order, env);
  return ranked.filter(c => endpoint(c.model.provider, env).key);
}

export async function listInferenceModels(db: PodStorage, env: InferenceEnv, callerId: string) {
  const budget = await budgetState(db, callerId, env);
  const routes = await rankedRoutes(db, env, {}, budget, false);
  const seen = new Set(["auto"]);
  const models = [{ id: "auto", object: "model", created: 0, owned_by: "model-governor" }];
  for (const { model } of routes) {
    if (seen.has(model.modelName)) continue;
    seen.add(model.modelName);
    models.push({ id: model.modelName, object: "model", created: Math.floor((model.firstSeenAt ?? 0) / 1000), owned_by: model.provider });
  }
  return models;
}

/** Prefer an eligible exact ID or upstream model name, then use the ordinary fallback order. */
async function candidates(db: PodStorage, env: InferenceEnv, request: ChatRequest, budget: BudgetState, needsTools: boolean): Promise<Plan> {
  const list = await rankedRoutes(db, env, request, budget, needsTools);
  const skipped: Attempt[] = [];
  if (request.model) {
    const pinned = list.find(c => c.model.id === request.model) ?? list.find(c => c.model.modelName === request.model);
    if (pinned) {
      list.splice(list.indexOf(pinned), 1);
      list.unshift(pinned);
    } else {
      const row = await db.prepare(`SELECT * FROM model_catalog WHERE id = ? OR model_name = ?
        ORDER BY (id = ?) DESC, (lifecycle = 'retired'), id LIMIT 1`)
        .bind(request.model, request.model, request.model).first<Record<string, unknown>>();
      if (!row) return { error: { status: 404, error: `unknown model ${request.model}`, code: "model_not_found" } };
      if (row.lifecycle === "retired") return { error: { status: 409, error: `model ${request.model} is retired`, code: "model_retired" } };
      if (!list.length && CALLABLE_PROVIDERS.has(String(row.provider)) && !endpoint(String(row.provider), env).key && !budget.capped) {
        return { error: { status: 503, error: `model governor has no ${row.provider} key`, code: "upstream_error" } };
      }
      skipped.push({ model: String(row.id), tier: tierOf(mapModel(row), env), status: "skipped", reason: "model is unavailable under the current routing policy" });
    }
  }
  return { list: list.slice(0, MAX_ATTEMPTS), skipped };
}

/** Upstream said the model cannot take this request's tools, e.g. OpenRouter "No endpoints found that support tool use". */
function refusesTools(status: number, text: string): boolean {
  return (status === 400 || status === 404 || status === 422) && /support\w*\b.{0,40}\btool|tool\w*\b.{0,40}\b(not supported|unsupported)/i.test(text);
}

/** Whether a failed attempt moves on to the next model, or is the caller's own error to return. */
function retryable(status: number, text: string, needsTools: boolean): boolean {
  return status === 429 || status === 402 || status === 404 || status === 410 || status === 401 || status === 403 || status === 408 || status >= 500 || (needsTools && refusesTools(status, text));
}

async function noteFailure(db: PodStorage, model: ModelEntry, status: number, text: string, needsTools: boolean, now: number): Promise<void> {
  if (status === 429) {
    await db.prepare("UPDATE model_catalog SET status = 'rate_limited', last_benchmarked_at = ? WHERE id = ?").bind(now, model.id).run().catch(() => {});
  } else if (status === 402) {
    // Account-level: no credit on this provider. Park the provider (EXHAUSTED_COOLDOWN_MS) instead of trying model after model.
    await db
      .prepare(`INSERT INTO provider_quotas (provider, status, error, exhausted_at, updated_at) VALUES (?, 'exhausted', ?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET status = 'exhausted', error = excluded.error, exhausted_at = excluded.exhausted_at, updated_at = excluded.updated_at`)
      .bind(model.provider, "HTTP 402 insufficient credits", now, now)
      .run()
      .catch(() => {});
  } else if (needsTools && refusesTools(status, text)) {
    await db.prepare("UPDATE model_catalog SET supports_tools = 0 WHERE id = ?").bind(model.id).run().catch(() => {});
  } else if (status === 404 || status === 410) {
    // The provider does not serve this model right now (unknown id, no capacity). Park it until the next probe re-checks it.
    await db.prepare("UPDATE model_catalog SET status = 'degraded', last_benchmarked_at = ? WHERE id = ?").bind(now, model.id).run().catch(() => {});
  }
}

function errorMessage(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text);
    const msg = parsed?.error?.message ?? parsed?.error ?? parsed?.message;
    if (typeof msg === "string" && msg) return `provider returned HTTP ${status}: ${msg.slice(0, 300)}`;
  } catch {}
  return `provider returned HTTP ${status}`;
}

export async function runChatCompletion(
  db: PodStorage,
  env: InferenceEnv,
  request: ChatRequest,
  fetcher: Fetcher = (i, init) => fetch(i, init),
  now = Date.now(),
): Promise<ChatOutcome> {
  const needsTools = hasTools(request.body);
  const stream = request.body.stream === true;
  const budget = await budgetState(db, request.callerId, env, now);
  const plan = await candidates(db, env, request, budget, needsTools);
  if ("error" in plan) return { ok: false, ...plan.error, model: request.model, attempts: [], budget };
  const attempts: Attempt[] = [...plan.skipped];

  if (plan.list.length === 0) {
    const toolsNote = needsTools ? " that supports tools" : "";
    if (budget.capped) {
      return {
        ok: false,
        status: 429,
        code: "budget_exceeded",
        error: budget.cappedBy === "fleet"
          ? `the fleet-wide daily budget (GOVERNOR_DAILY_BUDGET_USD) is spent; paid tiers are off until 00:00 UTC and no free model${toolsNote} qualifies`
          : `caller ${request.callerId} spent \$${budget.spentTodayUsd.toFixed(4)} of its \$${budget.policy.dailyBudgetUsd} daily budget; paid tiers are off until 00:00 UTC and no free model${toolsNote} qualifies`,
        attempts,
        budget,
      };
    }
    return { ok: false, status: 404, code: "no_qualified_model", error: `no qualified model${toolsNote} for this request`, model: request.model, attempts, budget };
  }

  let last: { status: number; error: string; model: string } | null = null;
  for (const { model, tier } of plan.list) {
    const { url, key } = endpoint(model.provider, env);
    if (!key) {
      attempts.push({ model: model.id, tier, status: "skipped", reason: `model governor has no ${model.provider} key` });
      last ??= { status: 503, error: `model governor has no ${model.provider} key`, model: model.id };
      continue;
    }
    const upstreamBody: Record<string, unknown> = { ...request.body, model: model.modelName };
    if (stream) upstreamBody.stream_options = { ...(request.body.stream_options as object | undefined), include_usage: true };

    const started = Date.now();
    const record = (status: LlmUsageStatus, promptTokens = 0, completionTokens = 0) =>
      recordUsage(db, {
        podId: request.callerId,
        taskId: request.taskId,
        provider: model.provider,
        modelId: model.id,
        promptTokens,
        completionTokens,
        latencyMs: Date.now() - started,
        status,
      });

    let res: Response;
    try {
      res = await fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...(stream ? { Accept: "text/event-stream" } : {}) },
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(stream ? STREAM_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      await record("error");
      const error = err instanceof Error ? err.message : String(err);
      attempts.push({ model: model.id, tier, status: 502, reason: error });
      last = { status: 502, error, model: model.id };
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      await record(res.status === 429 ? "rate_limited" : "error");
      await noteFailure(db, model, res.status, text, needsTools, Date.now());
      const error = errorMessage(text, res.status);
      attempts.push({ model: model.id, tier, status: res.status, reason: error });
      last = { status: res.status, error, model: model.id };
      if (retryable(res.status, text, needsTools)) continue;
      return { ok: false, status: res.status, code: "upstream_error", error, model: model.id, attempts, budget };
    }

    if (stream && res.body) {
      const metered = meterStream(res.body, async (usage, status) => {
        await record(status, usage.promptTokens, usage.completionTokens);
      });
      return { ok: true, kind: "stream", model, tier, attempts, budget, stream: metered };
    }

    const data = (await res.json()) as Record<string, any>;
    const promptTokens = Number(data.usage?.prompt_tokens ?? 0);
    const completionTokens = Number(data.usage?.completion_tokens ?? 0);
    await record("success", promptTokens, completionTokens);
    return { ok: true, kind: "json", model, tier, attempts, budget, data, latencyMs: Date.now() - started, usage: { promptTokens, completionTokens } };
  }
  return { ok: false, status: last?.status ?? 502, code: "all_models_failed", error: last?.error ?? "every candidate model failed", model: last?.model, attempts, budget };
}

/**
 * Passes an upstream SSE body through byte-for-byte while reading `usage` from the chunks (sent last when
 * stream_options.include_usage is set). Usage is recorded before the stream closes, so the Worker is still alive.
 */
export function meterStream(
  upstream: ReadableStream<Uint8Array>,
  onDone: (usage: { promptTokens: number; completionTokens: number }, status: LlmUsageStatus) => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const usage = { promptTokens: 0, completionTokens: 0 };
  let buffer = "";
  let finished = false;
  const scan = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]" || !payload.includes('"usage"')) return;
    try {
      const u = JSON.parse(payload)?.usage;
      if (u) {
        usage.promptTokens = Number(u.prompt_tokens ?? usage.promptTokens);
        usage.completionTokens = Number(u.completion_tokens ?? usage.completionTokens);
      }
    } catch {}
  };
  const finish = async (status: LlmUsageStatus) => {
    if (finished) return;
    finished = true;
    if (buffer) scan(buffer);
    await onDone(usage, status).catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await finish("success");
          controller.close();
          return;
        }
        controller.enqueue(value);
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) scan(line);
      } catch (err) {
        await finish("error");
        controller.error(err);
      }
    },
    async cancel(reason) {
      await finish("error");
      await reader.cancel(reason).catch(() => {});
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Legacy pod contract (POST /api/inference): string messages in, text out. Same routing, budget and fallback.

export interface InferenceRequest {
  podId: string;
  taskId?: string;
  category?: string;
  model?: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  maxTokens?: number;
  excludeFamily?: string;
}

export type InferenceResult =
  | { ok: true; model: string; provider: string; content: string; usage: { promptTokens: number; completionTokens: number }; latencyMs: number }
  | { ok: false; status: number; error: string; model?: string };

export async function runInference(
  db: PodStorage,
  env: InferenceEnv,
  request: InferenceRequest,
  fetcher: Fetcher = (i, init) => fetch(i, init),
): Promise<InferenceResult> {
  const out = await runChatCompletion(
    db,
    env,
    {
      callerId: request.podId,
      taskId: request.taskId,
      category: request.category,
      model: request.model,
      excludeFamily: request.excludeFamily,
      body: {
        messages: request.messages,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      },
    },
    fetcher,
  );
  if (!out.ok) return { ok: false, status: out.status, error: out.error, model: out.model };
  if (out.kind !== "json") return { ok: false, status: 500, error: "unexpected stream", model: out.model.id };
  return {
    ok: true,
    model: out.model.id,
    provider: out.model.provider,
    content: String(out.data.choices?.[0]?.message?.content ?? ""),
    usage: out.usage,
    latencyMs: out.latencyMs,
  };
}
