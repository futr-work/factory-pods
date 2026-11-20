// OpenAI-compatible backend for agents: tool calling passthrough, streaming, tool-preserving fallback, caller budgets.
// Real SQLite behind the D1-shaped adapter; every provider is a stub fetcher, so nothing here spends money.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SqliteFileStorage } from "@futr-work/pod-kernel/storage/sqlite";
import worker from "../src/worker.js";
import { runChatCompletion } from "../src/inference.js";
import { authGate } from "../src/auth.js";
import { fromOpenRouter } from "../src/discovery.js";
import { setCallerPolicy, tierOf, tierOrder, budgetState } from "../src/routing.js";
import { mapModel } from "../src/governor.js";
import { ensureSchema, resetSchemaCache } from "../src/schema.js";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(decodeURIComponent(new URL("../schema.sql", import.meta.url).pathname), "utf8"));
  return { sqlite, db: new SqliteFileStorage(sqlite) };
}

type Db = ReturnType<typeof freshDb>["db"];

async function addModel(db: Db, m: { id: string; tier?: string; out?: number | null; quality?: number; tools?: 0 | 1 | null; provider?: string }) {
  const tier = m.tier ?? "FREE_TIER";
  await db
    .prepare(`INSERT INTO model_catalog (id, provider, model_name, category, tier, input_cost_per_1m, output_cost_per_1m, quality_score,
      status, lifecycle, probe_runs, approved_by, supports_tools) VALUES (?, ?, ?, 'general_reasoning', ?, ?, ?, ?, 'active', 'qualified', 3, ?, ?)`)
    .bind(m.id, m.provider ?? "openrouter", m.id.slice(m.id.indexOf(":") + 1), tier, m.out === undefined ? 0 : m.out === null ? null : m.out / 4, m.out === undefined ? 0 : m.out, m.quality ?? 90, tier === "PAID" ? "hd" : null, m.tools === undefined ? 1 : m.tools)
    .run();
}

const TOOLS = [{ type: "function", function: { name: "lookup_parcel", description: "Find a parcel", parameters: { type: "object", properties: { apn: { type: "string" } }, required: ["apn"] } } }];
const TOOL_MESSAGES = [
  { role: "system", content: "You underwrite residential deals." },
  { role: "user", content: [{ type: "text", text: "Underwrite APN 123-45" }] },
  { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup_parcel", arguments: '{"apn":"123-45"}' } }] },
  { role: "tool", tool_call_id: "call_1", content: '{"sqft":1400,"zip":"85001"}' },
];
const TOOL_ANSWER = {
  id: "gen-1",
  object: "chat.completion",
  model: "acme/tooly",
  choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "lookup_parcel", arguments: '{"apn":"999"}' } }] } }],
  usage: { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138 },
};

/** A stub provider keyed by upstream model name. Records every call. */
function providers(byModel: Record<string, (body: any) => Response>) {
  const calls: { url: string; body: any; auth: string | null }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url, body, auth: new Headers(init?.headers).get("Authorization") });
    const answer = byModel[body.model];
    if (!answer) throw new Error(`unexpected upstream model ${body.model}`);
    return answer(body);
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const ok = (data: unknown) => () => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
const status = (code: number, text = "") => () => new Response(text, { status: code });

/** Runs worker.fetch with globalThis.fetch swapped for the stub (the worker uses the global fetch). */
async function withFetch<T>(fetcher: typeof fetch, run: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    return await run();
  } finally {
    globalThis.fetch = saved;
  }
}

const ENV = { FACTORY_HUB_TOKEN: "hub-secret", GOVERNOR_ADMIN_TOKEN: "admin-secret", GOVERNOR_CLIENT_TOKEN: "client-secret", OPENROUTER_API_KEY: "sk-or-test" };

function chat(db: Db, body: unknown, headers: Record<string, string> = {}, path = "/api/inference/chat/completions", env: Record<string, unknown> = ENV) {
  return worker.fetch(
    new Request(`https://gov.test${path}`, {
      method: "POST",
      headers: { Authorization: "Bearer client-secret", "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { DB: db, ...env } as any,
  );
}

describe("tool calling passthrough", () => {
  test("tools, tool_choice and structured messages go upstream unchanged; tool_calls come back intact", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:acme/tooly", quality: 95 });
    const { calls, fetcher } = providers({ "acme/tooly": ok(TOOL_ANSWER) });
    const request = { model: "auto", messages: TOOL_MESSAGES, tools: TOOLS, tool_choice: "auto", parallel_tool_calls: false, temperature: 0.1, response_format: { type: "text" } };
    const res = await withFetch(fetcher, () => chat(db, request, { "X-Governor-Caller": "agent-underwriter" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), TOOL_ANSWER, "the provider's response is returned verbatim");
    assert.equal(res.headers.get("X-Governor-Model"), "openrouter:acme/tooly");
    assert.equal(res.headers.get("X-Governor-Tier"), "0");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(calls[0].auth, "Bearer sk-or-test", "the governor's provider key, never the client's token");
    assert.deepEqual(calls[0].body, { ...request, model: "acme/tooly" }, "only `model` is rewritten");

    const usage = (await db.prepare("SELECT pod_id, prompt_tokens, completion_tokens, status FROM llm_usage_events").first()) as any;
    assert.deepEqual({ ...usage }, { pod_id: "agent-underwriter", prompt_tokens: 120, completion_tokens: 18, status: "success" });
  });

  test("a caller error (plain 400) is returned to the caller, not retried on another model", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:acme/a", quality: 95 });
    await addModel(db, { id: "openrouter:acme/b", quality: 80 });
    const { calls, fetcher } = providers({ "acme/a": status(400, JSON.stringify({ error: { message: "messages[3].tool_call_id is invalid" } })), "acme/b": ok(TOOL_ANSWER) });
    const res = await withFetch(fetcher, () => chat(db, { model: "auto", messages: TOOL_MESSAGES, tools: TOOLS }));
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.match(body.error.message, /tool_call_id is invalid/);
    assert.equal(calls.length, 1);
  });

  test("legacy /api/inference still answers text and still rejects non-string content", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:acme/a" });
    const { fetcher } = providers({ "acme/a": ok({ choices: [{ message: { content: "PONG" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) });
    const res = await withFetch(fetcher, () => chat(db, { podId: "pod-x", messages: [{ role: "user", content: "ping" }] }, { Authorization: "Bearer hub-secret" }, "/api/inference"));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).content, "PONG");
    const bad = await chat(db, { podId: "pod-x", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }, { Authorization: "Bearer hub-secret" }, "/api/inference");
    assert.equal(bad.status, 400);
  });
});

describe("streaming", () => {
  test("SSE passes through byte-for-byte and the usage chunk is recorded", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:acme/streamy" });
    const sse = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const { calls, fetcher } = providers({
      "acme/streamy": () => {
        const enc = new TextEncoder();
        // Split mid-line to prove the meter buffers across chunk boundaries.
        const joined = sse.join("");
        const parts = [joined.slice(0, 37), joined.slice(37, 140), joined.slice(140)];
        return new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const res = await withFetch(fetcher, () => chat(db, { model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }, { "X-Governor-Caller": "team:wholesale" }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /text\/event-stream/);
    assert.equal(await res.text(), sse.join(""));
    assert.equal(calls[0].body.stream, true);
    assert.deepEqual(calls[0].body.stream_options, { include_usage: true }, "usage is requested from the upstream");
    const usage = (await db.prepare("SELECT pod_id, prompt_tokens, completion_tokens, status FROM llm_usage_events").first()) as any;
    assert.deepEqual({ ...usage }, { pod_id: "team:wholesale", prompt_tokens: 42, completion_tokens: 7, status: "success" });
  });

  test("a stream that fails before its first byte falls back to the next model", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:acme/down", quality: 99 });
    await addModel(db, { id: "openrouter:acme/up", quality: 50 });
    const { calls, fetcher } = providers({
      "acme/down": status(503),
      "acme/up": () => new Response("data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    });
    const res = await withFetch(fetcher, () => chat(db, { model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "data: [DONE]\n\n");
    assert.deepEqual(calls.map((c) => c.body.model), ["acme/down", "acme/up"]);
  });
});

describe("tiered fallback", () => {
  test("tiers come from catalog price; unknown paid prices are premium", () => {
    const m = (tier: string, out: number | null) => mapModel({ id: "x", provider: "openrouter", model_name: "x", tier, input_cost_per_1m: out, output_cost_per_1m: out, status: "active" });
    assert.equal(tierOf(m("FREE_TIER", 0)), 0);
    assert.equal(tierOf(m("PAID", 1.1)), 1);
    assert.equal(tierOf(m("PAID", 15)), 2);
    assert.equal(tierOf(m("PAID", null)), 2);
    assert.equal(tierOf(m("PAID", 15), { TIER1_MAX_OUTPUT_COST_PER_1M: "20" }), 1);
    assert.deepEqual(tierOrder(1, 2), [1, 0, 2], "degrade to cheaper before spending more");
    assert.deepEqual(tierOrder(0, 1), [0, 1]);
  });

  test("a tools request falls back on 429 only to models that support tools", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:acme/free-tools", quality: 90, tools: 1 });
    await addModel(db, { id: "openrouter:acme/free-notools", quality: 99, tools: 0 });
    await addModel(db, { id: "openrouter:acme/free-unknown", quality: 98, tools: null });
    await addModel(db, { id: "openrouter:deepseek/v4", tier: "PAID", out: 1.1, quality: 85, tools: 1 });
    const { calls, fetcher } = providers({ "acme/free-tools": status(429), "deepseek/v4": ok(TOOL_ANSWER) });
    const out = await runChatCompletion(db, ENV, { callerId: "agent-1", body: { messages: TOOL_MESSAGES, tools: TOOLS } }, fetcher);
    assert.equal(out.ok, true);
    assert.equal(out.ok && out.model.id, "openrouter:deepseek/v4");
    assert.equal(out.ok && out.tier, 1);
    assert.deepEqual(calls.map((c) => c.body.model), ["acme/free-tools", "deepseek/v4"], "never a model without known tool support");
    assert.deepEqual(calls[1].body.tools, TOOLS);
    const marked = (await db.prepare("SELECT status FROM model_catalog WHERE id = 'openrouter:acme/free-tools'").first()) as any;
    assert.equal(marked.status, "rate_limited");

    // The same request without tools may use the strongest free model, tool support or not.
    const plain = providers({ "acme/free-notools": ok({ choices: [{ message: { content: "ok" } }], usage: {} }) });
    const text = await runChatCompletion(db, ENV, { callerId: "agent-1", body: { messages: [{ role: "user", content: "hi" }] } }, plain.fetcher);
    assert.equal(text.ok && text.model.id, "openrouter:acme/free-notools");
  });

  test("a provider refusing tools is learned and skipped next time", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:acme/claims-tools", quality: 99, tools: 1 });
    await addModel(db, { id: "openrouter:acme/real-tools", quality: 70, tools: 1 });
    const refusal = status(404, JSON.stringify({ error: { message: "No endpoints found that support tool use." } }));
    const first = providers({ "acme/claims-tools": refusal, "acme/real-tools": ok(TOOL_ANSWER) });
    const out = await runChatCompletion(db, ENV, { callerId: "a", body: { messages: TOOL_MESSAGES, tools: TOOLS } }, first.fetcher);
    assert.equal(out.ok && out.model.id, "openrouter:acme/real-tools");
    const row = (await db.prepare("SELECT supports_tools FROM model_catalog WHERE id = 'openrouter:acme/claims-tools'").first()) as any;
    assert.equal(row.supports_tools, 0);
    const second = providers({ "acme/real-tools": ok(TOOL_ANSWER) });
    await runChatCompletion(db, ENV, { callerId: "a", body: { messages: TOOL_MESSAGES, tools: TOOLS } }, second.fetcher);
    assert.deepEqual(second.calls.map((c) => c.body.model), ["acme/real-tools"]);
  });

  test("402 parks the provider; premium needs the caller's ceiling", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "orcarouter:acme/cheap", tier: "PAID", out: 0.5, quality: 99, provider: "orcarouter" });
    await addModel(db, { id: "openrouter:anthropic/claude-x", tier: "PAID", out: 15, quality: 99 });
    const env = { ...ENV, ORCAROUTER_API_KEY: "sk-orca" };
    const { calls, fetcher } = providers({ "acme/cheap": status(402), "anthropic/claude-x": ok(TOOL_ANSWER) });
    const capped = await runChatCompletion(db, env, { callerId: "agent-x", body: { messages: TOOL_MESSAGES, tools: TOOLS } }, fetcher);
    assert.equal(capped.ok, false, "default ceiling is tier 1, so premium is not reached");
    assert.equal(!capped.ok && capped.status, 402);
    const quota = (await db.prepare("SELECT status FROM provider_quotas WHERE provider = 'orcarouter'").first()) as any;
    assert.equal(quota.status, "exhausted");

    await setCallerPolicy(db, "grandmaster", { preferredTier: 2, maxTier: 2, dailyBudgetUsd: 20 });
    const premium = await runChatCompletion(db, env, { callerId: "grandmaster", body: { messages: TOOL_MESSAGES, tools: TOOLS } }, fetcher);
    assert.equal(premium.ok && premium.model.id, "openrouter:anthropic/claude-x");
    assert.deepEqual(calls.map((c) => c.body.model), ["acme/cheap", "anthropic/claude-x"], "the parked provider is not tried again");
  });
});

describe("per-caller budgets", () => {
  async function spend(db: Db, caller: string, usd: number, at = Date.now()) {
    await db
      .prepare(`INSERT INTO llm_usage_events (id, pod_id, provider, model_id, tier, prompt_tokens, completion_tokens, total_tokens, cost_usd, saved_usd, latency_ms, status, created_at)
        VALUES (?, ?, 'openrouter', 'm', 'PAID', 0, 0, 0, ?, 0, 1, 'success', ?)`)
      .bind(`use_${Math.random()}`, caller, usd, at)
      .run();
  }

  test("over the daily cap the caller drops to tier 0; with no free tools model it gets a clear 429", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:deepseek/v4", tier: "PAID", out: 1.1, quality: 95, tools: 1 });
    await addModel(db, { id: "openrouter:acme/free-tools", quality: 60, tools: 1 });
    await setCallerPolicy(db, "agent-scout", { preferredTier: 1, maxTier: 1, dailyBudgetUsd: 0.5 });
    const { calls, fetcher } = providers({ "deepseek/v4": ok(TOOL_ANSWER), "acme/free-tools": ok(TOOL_ANSWER) });

    const under = await runChatCompletion(db, ENV, { callerId: "agent-scout", body: { messages: TOOL_MESSAGES, tools: TOOLS } }, fetcher);
    assert.equal(under.ok && under.tier, 1, "under budget: preferred tier 1");

    await spend(db, "agent-scout", 0.4, Date.now() - 86_400_000 * 2); // a previous day does not count
    await spend(db, "agent-scout", 0.6);
    const state = await budgetState(db, "agent-scout");
    assert.equal(state.capped, true);
    const over = await runChatCompletion(db, ENV, { callerId: "agent-scout", body: { messages: TOOL_MESSAGES, tools: TOOLS } }, fetcher);
    assert.equal(over.ok && over.model.id, "openrouter:acme/free-tools", "capped: downgraded to tier 0");
    // A pinned paid model is not an escape hatch from the cap.
    const pinned = await runChatCompletion(db, ENV, { callerId: "agent-scout", model: "openrouter:deepseek/v4", body: { messages: TOOL_MESSAGES, tools: TOOLS } }, fetcher);
    assert.equal(!pinned.ok && pinned.code, "budget_exceeded");

    await db.prepare("UPDATE model_catalog SET supports_tools = 0 WHERE id = 'openrouter:acme/free-tools'").run();
    const res = await withFetch(fetcher, () => chat(db, { model: "auto", messages: TOOL_MESSAGES, tools: TOOLS }, { "X-Governor-Caller": "agent-scout" }));
    assert.equal(res.status, 429);
    const body = (await res.json()) as any;
    assert.equal(body.error.code, "budget_exceeded");
    assert.equal(body.error.type, "insufficient_quota");
    assert.match(body.error.message, /agent-scout spent \$0\.60\d\d of its \$0\.5 daily budget/);
    assert.equal(calls.length, 2, "the blocked request made no upstream call");
    // Other callers are unaffected.
    const other = await runChatCompletion(db, ENV, { callerId: "agent-offer", body: { messages: TOOL_MESSAGES, tools: TOOLS } }, fetcher);
    assert.equal(other.ok, true);
  });

  test("the fleet-wide cap holds even when a client rotates caller ids", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:deepseek/v4", tier: "PAID", out: 1.1, quality: 95 });
    await addModel(db, { id: "openrouter:acme/free", quality: 60 });
    await spend(db, "agent-a", 0.9);
    await spend(db, "agent-b", 0.9);
    const env = { ...ENV, GOVERNOR_DAILY_BUDGET_USD: "1.5" };
    const { fetcher } = providers({ "deepseek/v4": ok(TOOL_ANSWER), "acme/free": ok(TOOL_ANSWER) });
    const fresh = await runChatCompletion(db, env, { callerId: "agent-brand-new", body: { messages: [{ role: "user", content: "x" }] } }, fetcher);
    assert.equal(fresh.ok && fresh.model.id, "openrouter:acme/free");
    assert.equal(fresh.ok && fresh.budget.cappedBy, "fleet");
  });

  test("policies are admin-only; per-caller spend is readable with the hub token", async () => {
    const { db } = freshDb();
    await spend(db, "agent-buyers", 0.25);
    const set = (auth: string) =>
      worker.fetch(
        new Request("https://gov.test/api/governor/callers/agent-buyers", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify({ dailyBudgetUsd: 3, maxTier: 2 }) }),
        { DB: db, ...ENV } as any,
      );
    assert.equal((await set("Bearer hub-secret")).status, 403);
    assert.equal((await set("Bearer client-secret")).status, 403);
    const okRes = await set("Bearer admin-secret");
    assert.equal(okRes.status, 200);
    assert.equal(((await okRes.json()) as any).policy.dailyBudgetUsd, 3);

    const list = await worker.fetch(new Request("https://gov.test/api/governor/callers", { headers: { Authorization: "Bearer hub-secret" } }), { DB: db, ...ENV } as any);
    const callers = ((await list.json()) as any).callers;
    assert.deepEqual(
      callers.map((c: any) => [c.callerId, c.spentTodayUsd, c.dailyBudgetUsd, c.maxTier, c.source]),
      [["agent-buyers", 0.25, 3, 2, "caller"]],
    );

    const get = (path: string, auth: string) => worker.fetch(new Request(`https://gov.test${path}`, { headers: { Authorization: auth } }), { DB: db, ...ENV } as any);
    assert.equal((await get("/api/governor/callers", "Bearer admin-secret")).status, 200, "admin reads spend");
    assert.equal((await get("/api/governor/callers", "Bearer client-secret")).status, 401, "client token cannot read spend");
    assert.notEqual((await get("/api/governor/usage-report", "Bearer admin-secret")).status, 401, "admin reads the usage report");
    assert.equal((await get("/api/telemetry/stats", "Bearer admin-secret")).status, 401, "admin token opens only the spend reads");
  });
});

describe("client token scope", () => {
  const req = (method: string, path: string, token: string) => new Request(`https://gov.test${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  test("GOVERNOR_CLIENT_TOKEN opens only the OpenAI surface", () => {
    for (const [m, p] of [["POST", "/v1/chat/completions"], ["POST", "/api/inference/chat/completions"], ["GET", "/v1/models"], ["GET", "/api/inference/models"]]) {
      assert.equal(authGate(req(m, p, "client-secret"), ENV), null, `${m} ${p}`);
    }
    assert.equal(authGate(req("GET", "/api/telemetry/stats", "client-secret"), ENV)!.status, 401);
    assert.equal(authGate(req("POST", "/api/inference", "client-secret"), ENV)!.status, 401, "legacy pod route stays hub-only");
    assert.equal(authGate(req("GET", "/api/governor/callers", "client-secret"), ENV)!.status, 401);
    assert.equal(authGate(req("POST", "/api/governor/callers/x", "client-secret"), ENV)!.status, 403);
    assert.equal(authGate(req("POST", "/v1/chat/completions", "client-secret"), { FACTORY_HUB_TOKEN: "hub-secret" })!.status, 401, "unset client token opens nothing");
    assert.equal(authGate(req("POST", "/v1/chat/completions", "hub-secret"), ENV), null, "the hub token still works");
  });
});

describe("discovery records tool support", () => {
  test("from OpenRouter supported_parameters", () => {
    const base = { id: "acme/m", pricing: { prompt: "0", completion: "0" } };
    assert.equal(fromOpenRouter({ ...base, supported_parameters: ["tools", "tool_choice"] })!.supportsTools, true);
    assert.equal(fromOpenRouter({ ...base, supported_parameters: ["temperature"] })!.supportsTools, false);
    assert.equal(fromOpenRouter(base)!.supportsTools, null);
  });
});

describe("self-upgrading schema", () => {
  test("a pre-0007 database is upgraded by the Worker itself, idempotently", async () => {
    const { db, sqlite } = freshDb();
    // Recreate the deployed shape: no supports_tools column, no caller_policies table.
    sqlite.exec("DROP INDEX idx_usage_pod_created; DROP TABLE caller_policies; ALTER TABLE model_catalog DROP COLUMN supports_tools;");
    sqlite.exec(`INSERT INTO model_catalog (id, provider, model_name, category, tier, input_cost_per_1m, output_cost_per_1m, quality_score, status, lifecycle, probe_runs)
      VALUES ('openrouter:acme/old', 'openrouter', 'acme/old', 'general_reasoning', 'FREE_TIER', 0, 0, 90, 'active', 'qualified', 3)`);
    resetSchemaCache();
    const { fetcher } = providers({ "acme/old": ok({ choices: [{ message: { content: "PONG" } }], usage: {} }) });
    const res = await withFetch(fetcher, () => chat(db, { model: "auto", messages: [{ role: "user", content: "ping" }] }));
    assert.equal(res.status, 200, "the first request after deploy is served");
    const cols = (sqlite.prepare("PRAGMA table_info(model_catalog)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes("supports_tools"));
    assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'caller_policies'").get());
    // Existing rows keep unknown tool support, so tools requests still refuse them until discovery says otherwise.
    assert.equal((sqlite.prepare("SELECT supports_tools FROM model_catalog").get() as any).supports_tools, null);
    resetSchemaCache();
    await ensureSchema(db); // second run on an upgraded database is a no-op
  });
});

describe("live regression 2026-11-18", () => {
  test("a zero-priced paid row is premium, and a provider 404 (no capacity) falls through to the next model", async () => {
    const { db } = freshDb();
    // The live row: PAID, approved, prices recorded as 0. It must not be routed as free.
    await db
      .prepare(`INSERT INTO model_catalog (id, provider, model_name, category, tier, input_cost_per_1m, output_cost_per_1m, quality_score,
        status, lifecycle, probe_runs, approved_by, supports_tools) VALUES ('orcarouter:anthropic/claude-3.5-sonnet', 'orcarouter', 'anthropic/claude-3.5-sonnet',
        'general_reasoning', 'PAID', 0, 0, 99, 'active', 'qualified', 3, 'hd', 1)`)
      .run();
    await addModel(db, { id: "openrouter:acme/free", quality: 50 });
    const zeroPaid = mapModel({ id: "z", provider: "orcarouter", model_name: "z", tier: "PAID", input_cost_per_1m: 0, output_cost_per_1m: 0, status: "active" });
    assert.equal(tierOf(zeroPaid), 2);

    const env = { ...ENV, ORCAROUTER_API_KEY: "sk-orca" };
    const noCapacity = status(404, JSON.stringify({ error: { message: "No available capacity for model anthropic/claude-3.5-sonnet right now." } }));
    const { calls, fetcher } = providers({ "anthropic/claude-3.5-sonnet": noCapacity, "acme/free": ok({ choices: [{ message: { content: "PONG" } }], usage: {} }) });

    // Default policy (tier 0..1): the zero-priced premium row is out of reach entirely.
    const auto = await runChatCompletion(db, env, { callerId: "agent-smoke", body: { messages: [{ role: "user", content: "Say PONG" }] } }, fetcher);
    assert.equal(auto.ok && auto.model.id, "openrouter:acme/free");
    assert.deepEqual(calls.map((c) => c.body.model), ["acme/free"]);

    // A caller allowed premium tries it, gets the 404, parks it, and is still served.
    await setCallerPolicy(db, "grandmaster", { preferredTier: 2, maxTier: 2, dailyBudgetUsd: 5 });
    const premium = await runChatCompletion(db, env, { callerId: "grandmaster", body: { messages: [{ role: "user", content: "Say PONG" }] } }, fetcher);
    assert.equal(premium.ok && premium.model.id, "openrouter:acme/free");
    assert.deepEqual(calls.slice(1).map((c) => c.body.model), ["anthropic/claude-3.5-sonnet", "acme/free"]);
    const parked = (await db.prepare("SELECT status FROM model_catalog WHERE id = 'orcarouter:anthropic/claude-3.5-sonnet'").first()) as any;
    assert.equal(parked.status, "degraded");
  });
});

test("OpenAI model lists advertise unique callable names for the caller, and those names resolve", async () => {
  const { db } = freshDb();
  await addModel(db, { id: "orcarouter:acme/shared", provider: "orcarouter" });
  await db.prepare("UPDATE model_catalog SET lifecycle = 'retired' WHERE provider = 'orcarouter'").run();
  await addModel(db, { id: "openrouter:acme/shared" });
  await addModel(db, { id: "cerebras:acme/shared", provider: "cerebras" });
  await addModel(db, { id: "fireworks:no-key", provider: "fireworks" });
  await addModel(db, { id: "codex:subscription", provider: "codex" });
  await addModel(db, { id: "openrouter:expensive", tier: "PAID", out: 10 });
  const env = { ...ENV, CEREBRAS_API_KEY: "test" };
  for (const path of ["/models", "/api/inference/models", "/v1/models"]) {
    const response = await worker.fetch(new Request("https://gov.test" + path, {
      headers: { Authorization: "Bearer client-secret" },
    }), { ...env, DB: db });
    assert.equal(response.status, 200);
    assert.deepEqual(((await response.json()) as any).data.map((m: any) => m.id), ["auto", "acme/shared"]);
  }
  const { fetcher } = providers({ "acme/shared": ok({ ...TOOL_ANSWER, model: "acme/shared" }) });
  const response = await withFetch(fetcher, () => chat(db, { model: "acme/shared", messages: TOOL_MESSAGES }, {}, "/v1/chat/completions", env));
  assert.equal(response.status, 200);
});

describe("exact named routing", () => {
  const messages = [{ role: "user", content: "review" }];
  test("a named request returns the provider restriction while auto and omitted can switch models", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:review-1017", quality: 99 });
    await addModel(db, { id: "openrouter:general", quality: 50 });
    const { calls, fetcher } = providers({
      "review-1017": status(403, JSON.stringify({ error: { message: "provider_project_access_denied" } })),
      "general": ok({ model: "general", choices: [] }),
    });
    await withFetch(fetcher, async () => {
      const named = await chat(db, { model: "review-1017", messages });
      assert.equal(named.status, 403);
      const { error } = await named.json() as any;
      assert.equal(error.requested_model, "review-1017");
      assert.match(error.message, /provider_project_access_denied/);
      assert.equal(error.model, "openrouter:review-1017");
      assert.deepEqual(calls.map(c => c.body.model), ["review-1017"]);
      for (const model of ["auto", undefined]) {
        const auto = await chat(db, { model, messages });
        assert.equal(auto.headers.get("X-Governor-Model"), "openrouter:general");
      }
      for (const model of ["", " ", null, false, "auto:"]) assert.equal((await chat(db, { model, messages })).status, 400);
    });
  });

  test("only bare names can move to another provider of the same model", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:review-1017", quality: 99 });
    await addModel(db, { id: "cerebras:review-1017", provider: "cerebras" });
    await addModel(db, { id: "openrouter:review-latest", quality: 100 });
    const env = { ...ENV, CEREBRAS_API_KEY: "test" };
    const seen: string[] = [];
    const fetcher = (async (url, init) => {
      seen.push(JSON.parse(String(init?.body)).model);
      return String(url).includes("openrouter") ? new Response("down", { status: 503 }) : ok({ model: "review-1017" })();
    }) as typeof fetch;
    await withFetch(fetcher, async () => {
      const post = (model: string) => chat(db, { model, messages }, {}, "/v1/chat/completions", env);
      assert.equal((await post("openrouter:review-1017")).status, 503);
      assert.equal(seen.length, 1);
      assert.equal((await post("review-1017")).headers.get("X-Governor-Model"), "cerebras:review-1017");
      assert.deepEqual(seen, ["review-1017", "review-1017", "review-1017"]);
    });
  });

  test("named JSON and streams verify the provider's model before returning content", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:review-1017" });
    for (const stream of [false, true]) {
      for (const model of ["review-latest", undefined, "review-1017"]) {
        const chunk = { model, choices: [{ delta: { content: "receipt" } }] };
        const wire = ": heartbeat\r\n\r\ndata: " + JSON.stringify(chunk) + "\r\n\r\ndata: [DONE]\r\n\r\n";
        const { fetcher } = providers({ "review-1017": stream ? () => new Response(wire) : ok(chunk) });
        const response = await withFetch(fetcher, () => chat(db, { model: "review-1017", messages, stream }));
        if (model === "review-1017") {
          assert.equal(response.status, 200);
          assert.match(await response.text(), /receipt/);
        } else {
          assert.equal(response.status, 502);
          assert.match((await response.json() as any).error.message, /expected "review-1017"/);
        }
      }
    }
  });

  test("invalid HTTP 200 responses produce a structured failure and no substitution", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:exact" });
    await addModel(db, { id: "openrouter:other" });
    for (const invalid of ["null", "[]", "{"]) {
      const { fetcher, calls } = providers({ exact: () => new Response(invalid) });
      const res = await withFetch(fetcher, () => chat(db, { model: "exact", messages }));
      assert.equal(res.status, 502);
      const { error } = await res.json() as any;
      assert.equal(error.code, "named_model_failed");
      assert.match(error.message, /invalid chat response|malformed JSON/);
      assert.deepEqual(calls.map(c => c.body.model), ["exact"]);
    }
  });

  test("a stream changing identity after the first event terminates with an error receipt", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:exact" });
    const { fetcher } = providers({ exact: () => new Response('data: {"model":"exact"}\n\ndata: {"model":"other","choices":[{"delta":{"content":"wrong"}}]}\n\n') });
    const res = await withFetch(fetcher, () => chat(db, { model: "exact", messages, stream: true }));
    const reader = res.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /"exact"/);
    await assert.rejects(reader.read(), /provider reported "other"/);
    assert.equal((await db.prepare("SELECT status FROM llm_usage_events").first() as any).status, "error");
  });
});

describe("SSE receipt lifetime", () => {
  const encode = (data: unknown) => new TextEncoder().encode("data: " + JSON.stringify(data) + "\n\n");
  const content = encode({ model: "acme/pilot", choices: [{ delta: { content: "HERE" } }] });
  const finish = encode({ model: "acme/pilot", choices: [{ index: 0, finish_reason: "stop" }] });
  const totals = encode({ model: "acme/pilot", choices: [], usage: { prompt_tokens: 230, completion_tokens: 31, cost: 0.00000014 } });
  const done = new TextEncoder().encode("data: [DONE]\n\n");

  async function setup() {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:acme/pilot" });
    let origin!: ReadableStreamDefaultController<Uint8Array>;
    let stopped = false;
    const source = new ReadableStream<Uint8Array>({ start(c) { origin = c; }, cancel() { stopped = true; } });
    const { fetcher } = providers({ "acme/pilot": () => new Response(source) });
    const client = new AbortController();
    const req = new Request("https://gov.test/v1/chat/completions", {
      method: "POST", signal: client.signal, headers: { Authorization: "Bearer client-secret", "X-Governor-Caller": "pilot" },
      body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
    const tasks: Promise<unknown>[] = [];
    const res = await withFetch(fetcher, () => worker.fetch(req, { DB: db, ...ENV }, { waitUntil(task) { tasks.push(task); } }));
    assert.equal(res.status, 200);
    assert.equal(tasks.length, 1);
    const rows = async () => (await db.prepare("SELECT pod_id, model_id, prompt_tokens, completion_tokens, cost_usd, status FROM llm_usage_events").all()).results;
    return { body: res.body!, origin, client, tasks, rows, stopped: () => stopped };
  }

  test("an abandoned response needs no downstream pulls to persist exactly one provider receipt", async () => {
    const s = await setup();
    for (const frame of [content, finish, totals, done]) s.origin.enqueue(frame);
    await Promise.all(s.tasks);
    const rows = await s.rows();
    assert.deepEqual(rows.map(row => ({ ...row })), [{
      pod_id: "pilot", model_id: "openrouter:acme/pilot", prompt_tokens: 230, completion_tokens: 31, cost_usd: 0.00000014, status: "success",
    }]);
    await s.body.cancel();
    assert.equal((await s.rows()).length, 1);
  });

  test("terminal events reach the client only after the authoritative D1 write", async () => {
    const s = await setup();
    const reader = s.body.getReader();
    s.origin.enqueue(content);
    assert.match(new TextDecoder().decode((await reader.read()).value), /HERE/);
    s.origin.enqueue(finish);
    const pending = reader.read();
    let delivered = false;
    void pending.then(() => { delivered = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(delivered, false);
    assert.equal((await s.rows()).length, 0);
    s.origin.enqueue(totals);
    assert.match(new TextDecoder().decode((await pending).value), /finish_reason/);
    assert.equal((await s.rows())[0].status, "success");
    await reader.cancel();
    s.origin.enqueue(done);
    await Promise.all(s.tasks);
    assert.equal((await s.rows()).length, 1);
  });

  test("disconnect after provider finish drains the trailer, early cancellation stops generation", async () => {
    for (const terminal of [false, true]) {
      const s = await setup();
      const reader = s.body.getReader();
      s.origin.enqueue(content);
      await reader.read();
      if (terminal) {
        s.origin.enqueue(finish);
        await new Promise(resolve => setImmediate(resolve));
      }
      s.client.abort();
      if (terminal) {
        s.origin.enqueue(totals);
        s.origin.enqueue(done);
      }
      await Promise.all(s.tasks);
      assert.equal(s.stopped(), true);
      const rows = await s.rows();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, terminal ? "success" : "cancelled");
      assert.equal(rows[0].completion_tokens, terminal ? 31 : 0);
    }
  });

  test("cancel before response headers aborts one provider and prevents fallback", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:a" });
    await addModel(db, { id: "openrouter:b" });
    const client = new AbortController();
    const attempts: string[] = [];
    const tasks: Promise<void>[] = [];
    const neverAnswers = async (_url: string, init?: RequestInit) => {
      attempts.push(JSON.parse(String(init?.body)).model);
      const aborted = new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("disconnected")), { once: true }));
      client.abort();
      return aborted;
    };
    const out = await runChatCompletion(db, ENV, { callerId: "pilot", body: { stream: true, messages: TOOL_MESSAGES } }, neverAnswers,
      Date.now(), { signal: client.signal, waitUntil: task => tasks.push(task) });
    assert.equal(!out.ok && out.code, "client_disconnected");
    assert.equal(attempts.length, 1);
    await Promise.all(tasks);
    assert.equal((await db.prepare("SELECT status FROM llm_usage_events").first() as any).status, "cancelled");
  });

  test("a stalled usage trailer has a time limit after an explicit cancellation", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = await setup();
    s.origin.enqueue(content);
    s.origin.enqueue(finish);
    await new Promise(resolve => setImmediate(resolve));
    await s.body.cancel();
    t.mock.timers.tick(3100);
    await Promise.all(s.tasks);
    assert.equal(s.stopped(), true);
    assert.equal((await s.rows())[0].status, "usage_unavailable");
  });

  test("provisional counts survive without being mistaken for final usage", async () => {
    for (const terminal of [false, true]) {
      const s = await setup();
      s.origin.enqueue(encode({ choices: [{ delta: { content: "partial" } }], usage: { prompt_tokens: 15, completion_tokens: 1 } }));
      if (terminal) {
        s.origin.enqueue(finish);
        s.origin.enqueue(encode({ choices: [], usage: {} }));
      }
      s.origin.close();
      await Promise.all(s.tasks);
      const [row] = await s.rows();
      assert.equal(row.status, terminal ? "usage_unavailable" : "error");
      assert.equal(row.prompt_tokens, 15);
      assert.equal(row.completion_tokens, 1);
    }
  });

  test("completion without a usage frame is reported as unavailable", async () => {
    const s = await setup();
    for (const frame of [content, finish, done]) s.origin.enqueue(frame);
    await Promise.all(s.tasks);
    assert.equal((await s.rows())[0].status, "usage_unavailable");
  });
});

describe("opt-in required text", () => {
  const header = { "X-Governor-Require-Output": "text" };
  const body = { model: "auto", taskId: "csv-1", messages: [{ role: "user", content: "Return the CSV." }] };
  const usage = { prompt_tokens: 31, completion_tokens: 45, total_tokens: 76, cost: 0.00000123, completion_tokens_details: { reasoning_tokens: 45 } };
  const blank = { id: "gen-csv", model: "acme/first", choices: [{ finish_reason: "length", message: { role: "assistant", content: " \n", reasoning: "private trace" } }], usage };
  test("reasoning-only response returns an allowlisted receipt, spends once and never retries a different model", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:acme/first", quality: 99 });
    await addModel(db, { id: "openrouter:acme/next", quality: 10 });
    const { fetcher, calls } = providers({ "acme/first": ok({ ...blank, usage: { ...usage, metadata: "private trace" } }) });
    const res = await withFetch(fetcher, () => chat(db, body, header));
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.ok(!text.includes("private trace"));
    const { error } = JSON.parse(text);
    assert.equal(error.code, "empty_output");
    assert.equal(error.requested_model, "auto");
    assert.equal(error.model, "openrouter:acme/first");
    assert.equal(error.served_model, "acme/first");
    assert.equal(error.finish_reason, "length");
    assert.equal(error.completion_id, "gen-csv");
    assert.deepEqual(error.usage, usage);
    assert.equal(calls.length, 1);
    const { results } = await db.prepare("SELECT id,task_id,status,prompt_tokens,completion_tokens,cost_usd FROM llm_usage_events").all();
    assert.match(error.usage_event_id, /^use_/);
    assert.deepEqual(results.map(r => ({...r})), [{ id: error.usage_event_id, task_id: "csv-1", status: "empty_output", prompt_tokens: 31, completion_tokens: 45, cost_usd: 0.00000123 }]);
  });

  test("bad usage types are withheld and zero is preserved", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:acme/first" });
    const { fetcher } = providers({ "acme/first": ok({ ...blank, usage: { completion_tokens: 0, prompt_tokens: "88", total_tokens: -7, cost: -1, completion_tokens_details: { reasoning_tokens: 90 } } }) });
    const res = await withFetch(fetcher, () => chat(db, body, header));
    assert.equal(res.status, 502);
    assert.deepEqual((await res.json() as any).error.usage, { completion_tokens: 0 });
  });

  test("the default contract, nonempty choices, calls, filters and refusals remain successful", async () => {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:acme/first" });
    const results = [
      { headers: {}, request: body, reply: blank },
      { headers: header, request: { ...body, tools: TOOLS }, reply: TOOL_ANSWER },
      { headers: header, request: body, reply: TOOL_ANSWER },
      ...[
        { choices: [] },
        ...[{content:42}, {content:{}}, {content:[{type:"unknown"}]}, {content:null,refusal:{}},
          {content:null,tool_calls:{}}, {content:null,tool_calls:[{}]}]
          .map(message => ({choices:[{finish_reason:"stop",message:{role:"assistant",...message}}]})),
        { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [] } }] },
        { choices: [{ finish_reason: "unrecognized", message: { role: "assistant", content: "" } }] },
        { choices: [{ message: { role: "assistant", content: null } }] },
        { choices: [{ finish_reason: "length", message: { content: null } }] },
        { model: blank.model, choices: blank.choices, usage: blank.usage },
        { ...blank, choices: [{ finish_reason: "length", delta: { role: "assistant", content: "" } }] },
      ].map(reply => ({ headers: header, request: body, reply })),
      { headers: header, request: body, reply: { choices: [{ message: { content: null, refusal: "Declined" } }] } },
      { headers: header, request: body, reply: { choices: [{ finish_reason: "content_filter", message: { content: null } }] } },
      { headers: header, request: body, reply: { choices: [{ message: { content: null } }, { message: { content: [{ type: "text", text: "result" }] } }] } },
    ];
    for (const { headers, request, reply } of results) {
      const { fetcher } = providers({ "acme/first": ok(reply) });
      const res = await withFetch(fetcher, () => chat(db, request, headers as Record<string, string>));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), reply);
    }
  });
});

describe("opt-in required text on SSE", () => {
  const header = { "X-Governor-Require-Output": "text" };
  const body = { model: "auto", stream: true, messages: [{ role: "user", content: "CSV only" }] };
  const identity = { id: "gen-123", model: "acme/stream" };
  const totals = { prompt_tokens: 11, completion_tokens: 17, total_tokens: 28, cost: 0, completion_tokens_details: { reasoning_tokens: 17 } };
  function source(delta: object, finish: string, usage: object | null = totals) {
    const frames = [
      { ...identity, choices: [{ index: 0, delta: { role: "assistant", reasoning: "private internal" } }] },
      { ...identity, choices: [{ index: 0, delta, finish_reason: finish }] },
      { ...identity, choices: [], usage },
    ];
    return frames.map(f => "data: " + JSON.stringify(f) + "\n\n").join("") + "data: [DONE]\n\n";
  }
  async function send(wire: string, headers: Record<string,string> = header) {
    const { db } = freshDb();
    await addModel(db, { id: "openrouter:acme/stream", quality: 100 });
    await addModel(db, { id: "openrouter:acme/second", quality: 5 });
    const { calls, fetcher } = providers({ "acme/stream": () => new Response(wire) });
    const res = await withFetch(fetcher, () => chat(db, body, headers));
    const text = await res.text();
    assert.equal(calls.length, 1);
    const { results } = await db.prepare("SELECT id,status,prompt_tokens,completion_tokens,cost_usd FROM llm_usage_events").all();
    assert.equal(results.length, 1);
    return { res, text, row: { ...results[0] } };
  }

  test("a reasoning-only complete stream returns a verified error followed by DONE and writes once", async () => {
    const { res, text, row } = await send(source({ content: " \n " }, "length"));
    assert.equal(res.status, 200);
    assert.ok(!text.includes("private internal"));
    assert.ok(!text.includes('"finish_reason":"length","delta"'));
    const frames = text.trim().split("\n\n").map(line => line.slice(6));
    assert.equal(frames.pop(), "[DONE]");
    const { error } = JSON.parse(frames.pop()!);
    assert.match(error.usage_event_id,/^use_/);
    assert.deepEqual(error, {usage_event_id:row.id,status:502,type:"governor_error",code:"empty_output",message:"Provider completed without visible text.",
      requested_model:"auto",model:"openrouter:acme/stream",served_model:"acme/stream",completion_id:"gen-123",finish_reason:"length",usage:totals});
    assert.deepEqual(row,{id:error.usage_event_id,status:"empty_output",prompt_tokens:11,completion_tokens:17,cost_usd:0});
  });

  test("ordinary streams are byte-identical; opted-in text, tools, and refusals remain deliverable", async () => {
    const blank = source({}, "length");
    const normal = await send(blank, {});
    assert.equal(normal.text, blank);
    assert.equal(normal.row.status, "success");
    for (const [delta, finish] of [
      [{content:"a,b"}, "stop"], [{refusal:"declined"}, "stop"], [{}, "content_filter"],
      [{tool_calls:[{index:0,function:{name:"lookup",arguments:"{}"}}]}, "tool_calls"],
    ] as const) {
      const result = await send(source(delta, finish));
      assert.equal(result.row.status, "success");
      assert.ok(!result.text.includes("empty_output"));
      assert.ok(!result.text.includes("private internal"));
      assert.ok(result.text.includes(JSON.stringify(delta)));
    }
  });

  test("a broken stream does not authorize fallback; interim counters cannot serve as final evidence", async () => {
    const provisional = "data: "+JSON.stringify({...identity,choices:[{delta:{reasoning:"private internal"}}],usage:totals})+"\n\n";
    const upstreamClaim = 'data: {"error":{"code":"empty_output","type":"governor_error"}}\n\ndata: [DONE]\n\n';
    const denied = await send(upstreamClaim);
    assert.ok(denied.text.includes("upstream_error"));
    assert.ok(!denied.text.includes("empty_output"));
    assert.equal(denied.row.status, "error");
    const mixedTransport = source({}, "length").replace('"delta":{}','"message":{"role":"assistant","refusal":"declined"},"delta":{}');
    assert.ok(!(await send(mixedTransport)).text.includes("empty_output"));
    const changedId = source({}, "length").replace('"id":"gen-123"', '"id":"different"');
    assert.ok(!(await send(changedId)).text.includes("empty_output"));
    for (const wire of [
      "data: [DONE]\n\n",
      "data: "+JSON.stringify({...identity,choices:[],usage:totals})+"\n\ndata: [DONE]\n\n",
    ]) assert.ok(!(await send(wire)).text.includes("empty_output"));
    const incomplete = await send(provisional);
    assert.equal(incomplete.row.status,"error");
    assert.ok(!incomplete.text.includes("empty_output"));
    const truncated = await send(source({}, "length").replace("data: [DONE]\n\n", ""));
    assert.equal(truncated.row.status, "error");
    assert.ok(!truncated.text.includes("empty_output"));
    for (const reason of ["tool_calls", "function_call", "unknown"]) {
      assert.ok(!(await send(source({}, reason))).text.includes("empty_output"));
    }
    const complete = await send(provisional+source({},"length",null));
    const error = JSON.parse(complete.text.split("\n\n").filter(l=>l.includes('"empty_output"'))[0].slice(6)).error;
    assert.deepEqual(error.usage,{});
  });
});

test("client disconnect during opted-in terminal tail and forged telemetry cannot mark empty output", async () => {
  const { db } = freshDb();
  await addModel(db, {id:"openrouter:x"});
  const client = new AbortController();
  let origin!: ReadableStreamDefaultController<Uint8Array>;
  const { fetcher } = providers({x:() => new Response(new ReadableStream({start(c) {origin=c;}}))});
  const tasks: Promise<unknown>[] = [];
  const request = new Request("https://gov.test/v1/chat/completions", {method:"POST",signal:client.signal,
    headers: {Authorization:"Bearer client-secret","X-Governor-Require-Output":"text"},
    body: JSON.stringify({model:"auto",stream:true,messages:[{role:"user",content:"CSV"}]})});
  const res = await withFetch(fetcher,()=>worker.fetch(request,{DB:db,...ENV},{waitUntil(t){tasks.push(t);}}));
  const reader=res.body!.getReader();
  const push=(obj:unknown)=>origin.enqueue(new TextEncoder().encode("data: "+JSON.stringify(obj)+"\n\n"));
  push({id:"gen-disconnect",model:"x",choices:[{delta:{role:"assistant"}}]});
  await reader.read();
  push({model:"x",choices:[{delta:{},finish_reason:"length"}]});
  await new Promise(resolve=>setImmediate(resolve));
  client.abort();
  push({model:"x",choices:[],usage:{prompt_tokens:7,completion_tokens:12}});
  origin.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
  await Promise.all(tasks);
  const log=await worker.fetch(new Request("https://gov.test/api/telemetry/log",{method:"POST",headers:{Authorization:"Bearer hub-secret"},
    body:JSON.stringify({modelId:"x",podId:"z",status:"empty_output"})}),{DB:db,...ENV});
  assert.equal(log.status,400);
  const rows=await db.prepare("SELECT status FROM llm_usage_events").all();
  assert.deepEqual(rows.results.map(r=>r.status),["cancelled"]);
});

describe("governor-owned extraction deadline", () => {
  const model = "openrouter:extract-free";
  const messages = [{role:"user",content:"CSV only"}];
  const headers = {"X-Governor-Require-Output":"text","X-Governor-Recover-On":"upstream_timeout"};
  const frame = (obj:unknown) => "data: "+JSON.stringify(obj)+"\n\n";
  const encoder = new TextEncoder();
  const reason = {model:"extract-free",id:"gen-deadline",choices:[{index:0,delta:{role:"assistant",reasoning:"private"}}]};
  const usage = {prompt_tokens:19,completion_tokens:4,total_tokens:23,completion_tokens_details:{reasoning_tokens:4},cost:0};
  const row = (db: Db) => db.prepare("SELECT * FROM llm_usage_events").all<any>();

  test("HTTP 504 from governor before headers has a D1 row and explicitly unknown usage", async () => {
    const {db} = freshDb();
    await addModel(db,{id:model});
    let calls=0;
    // Model an outstanding IO handle: Node's AbortSignal.timeout does not keep the event loop alive.
    const fetcher = (async (_url: unknown, init: RequestInit) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("test upstream did not abort")), 5000);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("test upstream aborted"));
        }, { once: true });
      });
    }) as typeof fetch;
    const res = await withFetch(fetcher,()=>chat(db,{model,taskId:"attempt-1",stream:true,messages},
      {...headers,"X-Governor-Timeout-Ms":"1000","X-Governor-Caller":"scout"}));
    assert.equal(res.status,504);
    assert.equal(res.headers.get("X-Governor-Tier"),"0");
    assert.equal(res.headers.get("X-Governor-Attempts"),"1");
    const {error} = await res.json() as any;
    const {results} = await row(db);
    assert.equal(calls,1);
    assert.equal(results.length,1);
    const meta = {requested_model:model,model,served_model:null,completion_id:null,timeout_ms:1000,usage_state:"unknown",usage:{}};
    assert.deepEqual(error,{...meta,status:504,code:"upstream_timeout",type:"governor_error",usage_event_id:results[0].id,
      finish_reason:null,message:"The governor upstream deadline expired before visible output."});
    assert.equal(results[0].status,"upstream_timeout");
    assert.equal(results[0].task_id,"attempt-1");
    assert.deepEqual(JSON.parse(results[0].recovery_metadata_json),meta);
  });

  async function stalled(first:string, action:"deadline"|"disconnect"|"failure"="deadline") {
    const {db} = freshDb();
    await addModel(db,{id:model});await addModel(db,{id:"openrouter:alternative"});
    let origin!:ReadableStreamDefaultController<Uint8Array>,calls=0;
    const upstream = new ReadableStream<Uint8Array>({start(c){origin=c;if(first)c.enqueue(encoder.encode(first));}});
    const client=new AbortController(),clock=new AbortController();
    const tasks:Promise<void>[]=[];
    const fetcher=(async()=>{calls++;return new Response(upstream,{headers:{"Content-Type":"text/event-stream"}})}) as typeof fetch;
    const running=runChatCompletion(db,ENV,{callerId:"scout",taskId:"test-task",model,requireTextForModel:model,
      recoveryTimeoutMs:120000,body:{stream:true,messages}},fetcher,undefined,
      {signal:client.signal,deadlineClock:ms=>{assert.equal(ms,120000);return clock.signal},waitUntil:t=>tasks.push(t)});
    await new Promise(r=>setImmediate(r));
    if(action==="deadline") clock.abort();else if(action==="disconnect")client.abort();else origin.error(new Error("provider-originated timeout"));
    const out=await running;
    let wire="";
    if(out.ok && out.kind==="stream") {
      try{wire=await new Response(out.stream).text()}catch{wire="transport error"}
      await Promise.all(tasks);
    }
    assert.equal(calls,1);
    const {results}=await row(db);assert.equal(results.length,1);
    return {out,wire,row:results[0]};
  }

  test("before the first named SSE event only the owned clock is recoverable", async () => {
    const s=await stalled("");
    assert.equal(!s.out.ok && s.out.code,"upstream_timeout");
    assert.equal(s.row.status,"upstream_timeout");
    for (const action of ["failure","disconnect"] as const) {
      const result=await stalled("",action);
      assert.notEqual(result.row.status,"upstream_timeout");
    }
    const partial=await stalled('data: {"model":"extract-free","choices":[{"delta":{"content":"partial');
    assert.notEqual(partial.row.status,"upstream_timeout");
  });

  test("an identified unfinished generation keeps provisional usage and hides reasoning",async()=>{
    const s=await stalled(frame({...reason,usage}));
    assert.equal(s.row.status,"upstream_timeout");
    assert.equal(s.row.prompt_tokens,19);assert.equal(s.row.completion_tokens,4);
    assert.ok(!s.wire.includes("private"));assert.ok(s.wire.endsWith("data: [DONE]\n\n"));
    const {error}=JSON.parse(s.wire.split("\n\n").at(-3)!.slice(6));
    const meta={requested_model:model,model,served_model:"extract-free",completion_id:"gen-deadline",timeout_ms:120000,usage_state:"partial",usage};
    assert.equal(error.usage_event_id,s.row.id);
    assert.deepEqual(JSON.parse(s.row.recovery_metadata_json),meta);
    for(const [k,v] of Object.entries(meta))assert.deepEqual(error[k],v);
    const unknown=await stalled(frame(reason));assert.equal(JSON.parse(unknown.row.recovery_metadata_json).usage_state,"unknown");
    const newer=await stalled(frame({...reason,usage})+frame({...reason,usage:{completion_tokens:5}}));
    assert.deepEqual(JSON.parse(newer.row.recovery_metadata_json).usage,{prompt_tokens:19,completion_tokens:5,completion_tokens_details:{reasoning_tokens:4},cost:0});
    const onlyTotal=await stalled(frame({...reason,usage:{total_tokens:21}}));
    assert.equal(onlyTotal.row.total_tokens,21);
    assert.deepEqual(JSON.parse(onlyTotal.row.recovery_metadata_json).usage,{total_tokens:21});
  });

  test("visible output, refusals, tools, fragments, disconnects and provider errors never authorize recovery",async()=>{
    for(const delta of [{content:"a,b"},{refusal:"no"},{tool_calls:[{function:{arguments:"partial"}}]},{unrecognized_output:"refusal"}]){
      const s=await stalled(frame({...reason,choices:[{delta}]}));assert.notEqual(s.row.status,"upstream_timeout");
    }
    for (const bad of [{prompt_tokens:"all"}, {cost:-1}, {cost:0.0001}, {prompt_tokens:8,total_tokens:7}, {completion_tokens_details:{reasoning_tokens:-3}}]) {
      assert.notEqual((await stalled(frame({...reason,usage:bad}))).row.status,"upstream_timeout");
    }
    assert.notEqual((await stalled("event: error\n\n")).row.status, "upstream_timeout");
    const incomplete=await stalled(frame(reason)+'data: {"choices":[{"delta":{"content":"x');
    assert.notEqual(incomplete.row.status,"upstream_timeout");
    for(const action of ["failure","disconnect"] as const) assert.notEqual((await stalled(frame(reason),action)).row.status,"upstream_timeout");
    const fake=await stalled(frame(reason)+frame({model:"extract-free",error:{code:"upstream_timeout",type:"governor_error"}}));
    assert.notEqual(fake.row.status,"upstream_timeout");
  });

  test("invalid override and non-exact, paid, tool or multi-choice requests make no upstream calls", async()=>{
    const {db}=freshDb();await addModel(db,{id:model});await addModel(db,{id:"openrouter:paid",tier:"PAID",out:1});
    const fetcher=(()=>{assert.fail("unexpected upstream request")}) as typeof fetch;
    await withFetch(fetcher, async()=>{
      for(const ms of ["0","999","120001","2000.1","1e4",""]) {
        assert.equal((await chat(db,{model,messages,stream:true},{...headers,"X-Governor-Timeout-Ms":ms})).status,400);
      }
      for(const extra of [{model:"auto"},{model:"extract-free"},{model:"openrouter:paid"},{n:2},{stream:false},{tools:TOOLS}]) {
        assert.equal((await chat(db,{model,messages,stream:true,...extra},headers)).status,400);
      }
    });
    const fake=await worker.fetch(new Request("https://gov.test/api/telemetry/log",{method:"POST",headers:{Authorization:"Bearer hub-secret"},
      body:JSON.stringify({podId:"scout",modelId:model,status:"upstream_timeout"})}),{DB:db,...ENV});
    assert.equal(fake.status,400);assert.equal((await row(db)).results.length,0);
  });
});

test("timeout metadata upgrades existing receipt storage without reinterpreting historical rows",async()=>{
  const {sqlite,db}=freshDb();
  sqlite.exec("ALTER TABLE llm_usage_events DROP COLUMN recovery_metadata_json");
  sqlite.exec(`INSERT INTO llm_usage_events(id,pod_id,provider,model_id,tier,prompt_tokens,completion_tokens,total_tokens,
    cost_usd,saved_usd,latency_ms,status,created_at) VALUES('old','pilot','p','m','FREE_TIER',1,2,3,0,0,4,'success',5)`);
  resetSchemaCache();await ensureSchema(db);resetSchemaCache();await ensureSchema(db);
  const row=sqlite.prepare("SELECT status,total_tokens,recovery_metadata_json FROM llm_usage_events WHERE id='old'").get();
  assert.deepEqual({...row},{status:"success",total_tokens:3,recovery_metadata_json:null});
  sqlite.exec("ALTER TABLE llm_usage_events DROP COLUMN recovery_metadata_json");
  sqlite.exec(readFileSync(decodeURIComponent(new URL("../migrations/0009_usage_recovery_metadata.sql",import.meta.url).pathname),"utf8"));
  resetSchemaCache();await ensureSchema(db);
  assert.equal(sqlite.prepare("SELECT recovery_metadata_json FROM llm_usage_events WHERE id='old'").get()!.recovery_metadata_json,null);
});

test("provider timeouts, wrong identity and non-SSE error bodies cannot mint governor timeout evidence",async()=>{
  const {db}=freshDb(), model="openrouter:extract-free";
  await addModel(db,{id:model});
  for (const provider of [
    () => new Response("504",{status:504}),
    () => new Response('{"error":{"code":"upstream_timeout"}}',{headers:{"Content-Type":"application/json"}}),
    () => new Response('data: {"model":"other","choices":[]}\n\n',{headers:{"Content-Type":"text/event-stream"}}),
  ]) {
    const {fetcher,calls}=providers({"extract-free":provider});
    const res=await withFetch(fetcher,()=>chat(db,{model,stream:true,messages:[{role:"user",content:"CSV"}]},{
      "X-Governor-Require-Output":"text","X-Governor-Recover-On":"upstream_timeout","X-Governor-Timeout-Ms":"1000"}));
    assert.notEqual((await res.json() as any).error.code,"upstream_timeout");
    assert.equal(calls.length,1);
  }
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM llm_usage_events WHERE status='upstream_timeout'").first<any>())?.n,0);
});

test("the first daily-pool 429 stops peer models and later chat requests report the shared limit", async()=>{
  const {db,sqlite}=freshDb();
  await addModel(db,{id:"openrouter:primary",quality:100});
  await addModel(db,{id:"openrouter:peer",quality:95});
  const p=providers({primary:status(429,JSON.stringify({error:{message:"Rate limit exceeded: free-models-per-day-high-balance"}}))});
  const body={model:"auto",messages:TOOL_MESSAGES,tools:TOOLS};
  await withFetch(p.fetcher,async()=>{
    const env = {...ENV, DEFAULT_CALLER_MAX_TIER: "0", GOVERNOR_QUOTA_FAILOVER_CALLERS: "pilot"};
    for (const caller of ["pilot", "other", "pilot"]) {
      const r = await chat(db, body, {"X-Governor-Caller": caller}, undefined, env);
      assert.equal(r.status, 429);
      const {error} = await r.json() as any;
      assert.equal(error.code, "free_pool_exhausted");
      assert.equal(error.type, caller === "pilot" ? "insufficient_quota" : "rate_limit_exceeded");
      assert.equal(r.headers.get("x-should-retry"), caller === "pilot" ? "false" : null);
      assert.match(error.message, /rate limit/i);
    }
  });
  assert.equal(p.calls.length,1);
  assert.equal((sqlite.prepare("SELECT status FROM model_catalog WHERE id='openrouter:primary'").get() as any).status,"active");
  sqlite.exec("UPDATE provider_quotas SET resets_at=0 WHERE provider='openrouter:free'");
  const okProvider=providers({primary:ok(TOOL_ANSWER)});
  await withFetch(okProvider.fetcher,async()=>assert.equal((await chat(db,body)).status,200));
});

test("only the opted-in caller yields on a daily denial; transient 429s still use eligible alternatives", async () => {
  for (const [caller, cause, expected] of [
    ["writer", "free-models-per-day-high-balance", 429],
    ["neighbor", "free-models-per-day-high-balance", 200],
    ["writer", "temporary upstream rate limit", 200],
  ] as const) {
    const {db} = freshDb();
    await addModel(db, {id:"openrouter:primary", quality:100});
    await addModel(db, {id:"cerebras:alternate", provider:"cerebras", quality:90});
    const env = {...ENV, CEREBRAS_API_KEY:"test", GOVERNOR_QUOTA_FAILOVER_CALLERS:"writer"};
    const p = providers({primary:status(429,JSON.stringify({error:{message:cause}})), alternate:ok(TOOL_ANSWER)});
    const res = await withFetch(p.fetcher, () => chat(db, {model:"auto", messages:TOOL_MESSAGES}, {"X-Governor-Caller":caller}, undefined, env));
    assert.equal(res.status, expected);
    assert.deepEqual(p.calls.map(c=>c.body.model), expected === 429 ? ["primary"] : ["primary","alternate"]);
  }
});
