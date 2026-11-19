// Governor-mediated inference: the one place a provider key is used. A caller sends an OpenAI chat-completions
// body; the governor picks a measured model inside the caller's tier policy and budget, forwards the body
// unchanged except for `model` (tools, tool_choice, structured content, tool-role messages all pass through),
// falls back down the chain on 429/402/5xx, records the usage, and returns the provider's response as-is.
// Callers therefore hold no provider keys at all.
//
// API keys only. OAuth/consumer-subscription backends (Claude Pro/Max, ChatGPT, Gemini/Antigravity logins) are
// never called from here: CALLABLE_PROVIDERS is the allowlist and every entry is a pay-per-use API.

import { UpstreamDeadline } from "./upstream-deadline.js";
import { RequiredText, requireTextFor, timeoutError, type TimeoutMetadata } from "./required-text.js";
import { openMeteredStream, type StreamLifetime } from "./inference-stream.js";
import type { PodStorage } from "@futr-work/pod-kernel/storage";
import { listRoutableModels, mapModel, recordUsage, type LlmUsageStatus, type ModelEntry, type RouteOptions } from "./governor.js";
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
  /** An exact catalog id or upstream model name. Omitted = route by policy. */
  model?: string;
  /** Original selector when a chat client explicitly requires visible text. */
  requireTextForModel?: string;
  recoveryTimeoutMs?: number;
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
  | { ok: false; status: number; error: string; code: string; model?: string; attempts: Attempt[]; budget?: BudgetState; emptyOutput?: ReturnType<RequiredText["error"]>; upstreamTimeout?: ReturnType<typeof timeoutError> };

export function hasTools(body: Record<string, unknown>): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

type Candidate = { model: ModelEntry; tier: Tier };
type Plan = { list: Candidate[] } | { error: { status: number; error: string; code: string } };

async function rankedRoutes(db: PodStorage, env: InferenceEnv, request: Pick<ChatRequest, "excludeFamily" | "category">, budget: BudgetState, needsTools: boolean, identity?: RouteOptions["identity"]) {
  const routable = await listRoutableModels(db, {
    identity,
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

/** A catalog ID selects one provider. A bare upstream name permits only copies of that exact model. */
async function candidates(db: PodStorage, env: InferenceEnv, request: ChatRequest, budget: BudgetState, needsTools: boolean): Promise<Plan> {
  if (request.model === undefined || request.model === "auto") {
    const ranked = await rankedRoutes(db, env, request, budget, needsTools);
    return { list: ranked.slice(0, MAX_ATTEMPTS) };
  }

  const requested = request.model;
  const row = await db.prepare(`SELECT * FROM model_catalog WHERE id = ? OR model_name = ?
    ORDER BY (id = ?) DESC, (lifecycle = 'retired'), (lifecycle = 'qualified') DESC, id LIMIT 1`)
    .bind(requested, requested, requested).first<Record<string, unknown>>();
  const fail = (status: number, code: string, reason: string) => ({ error: { status, code, error: `model ${requested}: ${reason}` } });
  if (!row) return fail(404, "model_not_found", "unknown model");
  const model = mapModel(row);
  const identity = model.id === requested ? { id: requested } : { name: requested };
  const matches = await rankedRoutes(db, env, request, budget, needsTools, identity);
  if (matches.length) return { list: matches.slice(0, MAX_ATTEMPTS) };

  // Describe the exact row (or a representative provider copy for a bare name).
  const reason = (detail: string) => fail(409, "model_unavailable", `${model.id} ${detail}`);
  if (model.lifecycle === "retired") return fail(409, "model_retired", "retired");
  if (!CALLABLE_PROVIDERS.has(model.provider)) return reason("has no HTTP chat endpoint");
  if (model.tier === "PAID" && !model.approvedBy) return reason("needs paid-model approval");
  if (model.lifecycle !== "qualified") return reason("is awaiting qualification");
  if (model.status !== "active") return reason(`is ${model.status}`);
  if (needsTools && model.supportsTools !== true) return reason("has no qualified tool support");
  if (!endpoint(model.provider, env).key) return fail(503, "provider_unconfigured", `model governor has no ${model.provider} key`);
  if (tierOf(model, env) > budget.effectiveMaxTier) {
    if (budget.capped) return fail(429, "budget_exceeded", `${budget.cappedBy} daily budget is spent and the requested model requires a paid tier`);
    return reason(`exceeds the caller's maximum tier ${budget.effectiveMaxTier}`);
  }
  if (model.family && request.excludeFamily?.toLowerCase().split(",").some(family => family.trim() === model.family?.toLowerCase())) {
    return reason("belongs to an excluded family");
  }
  return reason("is unavailable during provider quota cooldown");
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

function verifyProviderModel(reported: unknown, expected: string): void {
  if (reported !== expected) {
    const actual = typeof reported === "string" ? JSON.stringify(reported.slice(0, 200)) : "no model identity";
    throw new Error(`provider reported ${actual}; expected ${JSON.stringify(expected)}`);
  }
}

export async function runChatCompletion(
  db: PodStorage,
  env: InferenceEnv,
  request: ChatRequest,
  fetcher: Fetcher = (i, init) => fetch(i, init),
  now = Date.now(),
  lifetime?: StreamLifetime,
): Promise<ChatOutcome> {
  const needsTools = hasTools(request.body);
  const stream = request.body.stream === true;
  const budget = await budgetState(db, request.callerId, env, now);
  const plan = await candidates(db, env, request, budget, needsTools);
  if ("error" in plan) return { ok: false, ...plan.error, model: request.model, attempts: [], budget };
  const attempts: Attempt[] = [];
  const named = request.model !== undefined && request.model !== "auto";

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

  const disconnected = () => ({ ok: false as const, status: 499, code: "client_disconnected", error: "client disconnected", model: request.model, attempts, budget });
  let last: { status: number; error: string; model: string } | null = null;
  for (const { model, tier } of plan.list) {
    if (lifetime?.signal.aborted) return disconnected();
    const { url, key } = endpoint(model.provider, env);
    if (!key) {
      attempts.push({ model: model.id, tier, status: "skipped", reason: `model governor has no ${model.provider} key` });
      last ??= { status: 503, error: `model governor has no ${model.provider} key`, model: model.id };
      continue;
    }
    const upstreamBody: Record<string, unknown> = { ...request.body, model: model.modelName };
    if (stream) upstreamBody.stream_options = { ...(request.body.stream_options as object | undefined), include_usage: true };

    const requiredText = request.requireTextForModel && requireTextFor(request.body)
      ? new RequiredText(request.requireTextForModel, model.id, typeof request.body.n === "number" ? request.body.n : 1) : undefined;
    const timeoutMs = request.recoveryTimeoutMs;
    if (timeoutMs !== undefined && (!requiredText || !stream || tier !== 0 || request.model !== model.id ||
        !model.id.startsWith(model.provider + ":") || (request.body.n !== undefined && request.body.n !== 1) ||
        (request.body.tool_choice != null && request.body.tool_choice !== "none") ||
        (request.body.function_call != null && request.body.function_call !== "none"))) {
      return { ok: false, status: 400, error: "timeout recovery requires a single exact free catalog route on a text-only stream",
        code: "invalid_request", attempts, budget };
    }
    const deadline = timeoutMs !== undefined ? new UpstreamDeadline(timeoutMs, lifetime?.deadlineClock) : undefined;
    const started = Date.now();
    const record = (status: LlmUsageStatus, promptTokens = 0, completionTokens = 0, actualCost?: number, modelId = model.id, recoveryMetadata?: TimeoutMetadata) =>
      recordUsage(db, {
        podId: request.callerId,
        taskId: request.taskId,
        provider: model.provider,
        modelId,
        actualCost,
        recoveryMetadata,
        promptTokens,
        completionTokens,
        latencyMs: Date.now() - started,
        status,
      });

    const timedOut = async () => {
      const meta = requiredText!.timeoutMetadata(deadline!.milliseconds);
      const event = await record("upstream_timeout", meta.usage.prompt_tokens, meta.usage.completion_tokens,
        meta.usage.cost, model.id, meta);
      const error = timeoutError(meta, event.id);
      attempts.push({model: model.id, tier, status: error.status, reason: error.message});
      return { ok: false as const, status: error.status, error: error.message, code: error.code, model: model.id,
        attempts, budget, upstreamTimeout: error };
    };
    let res: Response;
    const headersAbort = new AbortController();
    const abortHeaders = () => headersAbort.abort();
    lifetime?.signal.addEventListener("abort", abortHeaders, { once: true });
    try {
      const dispatch = () => fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...(stream ? { Accept: "text/event-stream" } : {}) },
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.any([headersAbort.signal, deadline?.signal ?? AbortSignal.timeout(stream ? STREAM_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)]),
      });
      res = await (deadline ? deadline.wait(dispatch) : dispatch());
    } catch (err) {
      if (lifetime?.signal.aborted) {
        const cancelled = record("cancelled").then(() => {});
        lifetime.waitUntil?.(cancelled);
        await cancelled;
        return disconnected();
      }
      if (deadline?.caused(err) && requiredText?.unresolved) return timedOut();
      await record("error");
      const error = err instanceof Error ? err.message : String(err);
      attempts.push({ model: model.id, tier, status: 502, reason: error });
      last = { status: 502, error, model: model.id };
      continue;
    } finally {
      lifetime?.signal.removeEventListener("abort", abortHeaders);
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

    let data: Record<string, any>;
    let promptTokens = 0;
    let completionTokens = 0;
    try {
      if (stream) {
        if (!res.body) throw new Error("provider returned an empty stream");
        if (deadline && res.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "text/event-stream") {
          void res.body.cancel().catch(() => {});
          throw new Error("provider did not return an SSE response");
        }
        const metered = await openMeteredStream(res.body, {
          validateModel: named ? reported => verifyProviderModel(reported, model.modelName) : undefined,
          choices: typeof request.body.n === "number" ? request.body.n : 1,
          lifetime, requiredText, deadline,
          async record(usage, status, timeout) {
            const modelId = usage.model && usage.model !== model.modelName && usage.model !== model.id
              ? `${model.provider}:${usage.model}` : model.id;
            return (await record(status, usage.promptTokens, usage.completionTokens, usage.cost, modelId, timeout)).id;
          },
        });
        return { ok: true, kind: "stream", model, tier, attempts, budget, stream: metered };
      }
      const parsed = await res.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("provider returned an invalid chat response");
      data = parsed as Record<string, any>;
      promptTokens = Number(data.usage?.prompt_tokens ?? 0);
      completionTokens = Number(data.usage?.completion_tokens ?? 0);
      if (named) verifyProviderModel(data.model, model.modelName);
    } catch (err) {
      if (lifetime?.signal.aborted) {
        const cancelled = record("cancelled", promptTokens, completionTokens).then(() => {});
        lifetime.waitUntil?.(cancelled);
        await cancelled;
        return disconnected();
      }
      if (deadline?.caused(err) && requiredText?.unresolved) return timedOut();
      await record("error", promptTokens, completionTokens);
      const error = err instanceof SyntaxError ? "provider returned malformed JSON" : err instanceof Error ? err.message : String(err);
      attempts.push({ model: model.id, tier, status: 502, reason: error });
      last = { status: 502, error, model: model.id };
      continue;
    }
    if (requiredText) {
      requiredText.observe(data);
      if (data.error?.code === "empty_output" || data.error?.code === "upstream_timeout" || data.error?.type === "governor_error") {
        const error = "Provider returned an error using a reserved governor identifier.";
        await record("error", requiredText.usage.prompt_tokens, requiredText.usage.completion_tokens, requiredText.usage.cost);
        attempts.push({ model: model.id, tier, status: 502, reason: error });
        return { ok: false, status: 502, error, code: "upstream_error", model: model.id, attempts, budget };
      }
      if (requiredText.emptyCompletion && !data.error) {
        const usage = requiredText.usage;
        const actual = requiredText.servedModel;
        const modelId = actual && actual !== model.modelName && actual !== model.id ? `${model.provider}:${actual}` : model.id;
        const event = await record("empty_output", usage.prompt_tokens, usage.completion_tokens, usage.cost, modelId);
        const error = requiredText.error(event.id);
        attempts.push({ model: model.id, tier, status: error.status, reason: error.message });
        return { ok: false, status: error.status, error: error.message, code: error.code, model: model.id,
          attempts, budget, emptyOutput: error };
      }
    }
    await record("success", promptTokens, completionTokens);
    return { ok: true, kind: "json", model, tier, attempts, budget, data, latencyMs: Date.now() - started, usage: { promptTokens, completionTokens } };
  }
  return { ok: false, status: last?.status ?? 502, code: named ? "named_model_failed" : "all_models_failed", error: last?.error ?? "every candidate model failed", model: last?.model, attempts, budget };
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
