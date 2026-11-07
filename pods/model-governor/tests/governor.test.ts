// honest governor. Real SQLite (node:sqlite) behind a D1-shaped adapter; fetch is stubbed,
// so nothing here calls a provider or spends money.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SqliteFileStorage } from "@futr-work/pod-kernel/storage/sqlite";
import { familyOf, fromOpenRouter, runDiscovery, runScheduledDiscovery } from "../src/discovery.js";
import { clean, estimateSuiteCost, gradeZipRegex, probeModel, recordProbe, runProbeCycle, SUITE } from "../src/probe.js";
import { recordUsage, resolveOptimalModel, getModelCatalog, getSubscriptionAdvisor } from "../src/governor.js";
import { analyzeUsage, getUsageReport, percentile, runDailyUsageAnalysis, utcDate } from "../src/analyzer.js";
import { runInference } from "../src/inference.js";
import { authGate } from "../src/auth.js";
import worker from "../src/worker.js";
import { renderPodUiHtml } from "../src/ui.js";
import { loadPodConfig } from "../src/config.js";


function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(decodeURIComponent(new URL("../schema.sql", import.meta.url).pathname), "utf8"));
  return { sqlite, db: new SqliteFileStorage(sqlite) };
}

const orModels = {
  data: [
    { id: "acme/free-coder:free", context_length: 131072, created: 1793000000, pricing: { prompt: "0", completion: "0" } },
    { id: "anthropic/claude-x", context_length: 200000, created: 1793000000, pricing: { prompt: "0.000003", completion: "0.000015" } },
    { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
    { id: "google/lyria-3-pro-preview", pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text"], output_modalities: ["audio"] } },
    { id: "openai/gpt-x:batch", pricing: { prompt: "0.000001", completion: "0.000002" } },
  ],
};
const fetchCatalog = async () => new Response(JSON.stringify(orModels), { status: 200 });

/** A stub provider that answers the smoke suite correctly (or with a fixed wrong answer). */
function answering(correct: boolean) {
  const answers: Record<string, string> = { exact: "PONG", json: '{"a":391,"b":"x"}', instruction: "2,3,5,7,11", code_read: "12", code_write: "/^\\d{5}$/" };
  return async (_url: string, init?: RequestInit) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string;
    const item = SUITE.find((s) => s.prompt === prompt)!;
    const content = correct ? answers[item.name] : "nope";
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 5 } }), { status: 200 });
  };
}

describe("discovery", () => {
  test("maps real OpenRouter records; drops negative-priced routers", () => {
    const m = fromOpenRouter(orModels.data[1])!;
    assert.equal(m.id, "openrouter:anthropic/claude-x");
    assert.equal(m.family, "anthropic");
    assert.equal(m.tier, "PAID");
    assert.equal(m.outputCostPer1M, 15);
    assert.equal(fromOpenRouter(orModels.data[0])!.tier, "FREE_TIER");
    assert.equal(fromOpenRouter(orModels.data[2]), null);
    assert.equal(fromOpenRouter(orModels.data[3]), null, "music model is not a chat model");
    assert.equal(fromOpenRouter(orModels.data[4]), null, "batch variants are skipped");
    assert.equal(familyOf("meta-llama/llama-4"), "meta");
  });

  test("upserts as unmeasured candidates and retires superseded 2024 seeds", async () => {
    const { db, sqlite } = freshDb();
    sqlite.exec(`INSERT INTO model_catalog (id, provider, model_name, category, tier, lifecycle, source) VALUES ('old', 'openrouter', 'google/gemini-2.0-flash-exp:free', 'general_reasoning', 'FREE_TIER', 'candidate', 'seed-2024')`);
    const reports = await runDiscovery(db, {}, fetchCatalog, 1_800_000_000_000);
    assert.equal(reports[0].seen, 2);
    assert.equal(reports[0].newIds.length, 2);
    const rows = sqlite.prepare("SELECT id, lifecycle, quality_score, tokens_per_sec, first_seen_at FROM model_catalog ORDER BY id").all() as any[];
    const fresh = rows.find((r) => r.id === "openrouter:acme/free-coder:free");
    assert.equal(fresh.lifecycle, "candidate");
    assert.equal(fresh.quality_score, null, "no invented measurements");
    assert.equal(fresh.tokens_per_sec, null);
    assert.equal(fresh.first_seen_at, 1_800_000_000_000);
    assert.equal(rows.find((r) => r.id === "old").lifecycle, "retired");
    const again = await runDiscovery(db, {}, fetchCatalog, 1_800_000_100_000);
    assert.equal(again[0].newIds.length, 0, "second run discovers nothing new");
  });
});

describe("probing and promotion", () => {
  test("graders are deterministic", () => {
    assert.equal(gradeZipRegex("/^\\d{5}$/"), true);
    assert.equal(gradeZipRegex("/\\d{5}/"), false, "unanchored matches 123456");
    assert.equal(clean("<think>hm</think>\n```\n12\n```"), "12");
  });

  test("a free model qualifies only after 3 measured passing runs", async () => {
    const { db, sqlite } = freshDb();
    await runDiscovery(db, {}, fetchCatalog, Date.now());
    const target = { id: "openrouter:acme/free-coder:free", provider: "openrouter", modelName: "acme/free-coder:free", tier: "FREE_TIER", inputCostPer1M: 0, outputCostPer1M: 0 };
    const env = { OPENROUTER_API_KEY: "k" };
    for (let i = 1; i <= 3; i++) {
      const r = await probeModel(target, env, answering(true) as any);
      assert.equal(r.passed, SUITE.length);
      const lifecycle = await recordProbe(db, target, r, Date.now() + i);
      assert.equal(lifecycle, i < 3 ? "candidate" : "qualified");
    }
    const row = sqlite.prepare("SELECT quality_score, probe_runs, last_benchmarked_at FROM model_catalog WHERE id = ?").get(target.id) as any;
    assert.equal(row.quality_score, 100);
    assert.equal(row.probe_runs, 3);
    assert.ok(row.last_benchmarked_at > 1_790_000_000_000, "measured now, not in 2024");
  });

  test("provider errors are recorded but never count as quality runs", async () => {
    const { db, sqlite } = freshDb();
    await runDiscovery(db, {}, fetchCatalog, Date.now());
    const target = { id: "openrouter:acme/free-coder:free", provider: "openrouter", modelName: "acme/free-coder:free", tier: "FREE_TIER", inputCostPer1M: 0, outputCostPer1M: 0 };
    const r = await probeModel(target, { OPENROUTER_API_KEY: "k" }, (async () => new Response("slow down", { status: 429 })) as any);
    assert.equal(await recordProbe(db, target, r, Date.now()), "provider_error");
    const row = sqlite.prepare("SELECT probe_runs, status FROM model_catalog WHERE id = ?").get(target.id) as any;
    assert.equal(row.probe_runs, 0);
    assert.equal(row.status, "rate_limited");
  });

  test("paid models: never probed with budget 0, never qualified without approval", async () => {
    const { db, sqlite } = freshDb();
    await runDiscovery(db, {}, fetchCatalog, Date.now());
    const calls: string[] = [];
    const spy = (async (url: string, init?: RequestInit) => { calls.push(JSON.parse(String(init?.body)).model); return answering(true)(url, init); }) as any;
    const cycle = await runProbeCycle(db, { OPENROUTER_API_KEY: "k" }, spy, Date.now());
    assert.ok(cycle.skippedPaid.includes("openrouter:anthropic/claude-x"));
    assert.ok(!calls.includes("anthropic/claude-x"), "no paid call at budget 0");
    const paid = { id: "openrouter:anthropic/claude-x", provider: "openrouter", modelName: "anthropic/claude-x", tier: "PAID", inputCostPer1M: 3, outputCostPer1M: 15 };
    assert.ok((estimateSuiteCost(paid) ?? 0) > 0);
    for (let i = 0; i < 3; i++) await recordProbe(db, paid, await probeModel(paid, { OPENROUTER_API_KEY: "k" }, answering(true) as any), Date.now() + i);
    assert.equal((sqlite.prepare("SELECT lifecycle FROM model_catalog WHERE id = ?").get(paid.id) as any).lifecycle, "candidate", "unapproved paid stays candidate");
  });
});

describe("re-applied migration resilience", () => {
  test("discovery restores family and provenance on existing rows (excludeFamily must never see NULL)", async () => {
    const { db, sqlite } = freshDb();
    await runDiscovery(db, {}, fetchCatalog, Date.now());
    sqlite.exec(`UPDATE model_catalog SET family = NULL, source = 'seed-2024' WHERE id = 'openrouter:anthropic/claude-x'`);
    await runDiscovery(db, {}, fetchCatalog, Date.now() + 1000);
    const row = sqlite.prepare("SELECT family, source, lifecycle FROM model_catalog WHERE id = 'openrouter:anthropic/claude-x'").get() as any;
    assert.equal(row.family, "anthropic");
    assert.equal(row.source, "discovered");
    assert.notEqual(row.lifecycle, "retired", "a live model is never retired as a superseded seed");
  });
});

describe("credit exhaustion", () => {
  test("a 402 pauses all paid probing for 24 h; free probing continues", async () => {
    const { db } = freshDb();
    await runDiscovery(db, {}, fetchCatalog, Date.now());
    const paidCalls: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model as string;
      if (!model.endsWith(":free")) { paidCalls.push(model); return new Response('{"error":{"message":"Insufficient credits"}}', { status: 402 }); }
      return answering(true)(url, init);
    }) as any;
    const first = await runProbeCycle(db, { OPENROUTER_API_KEY: "k", PROBE_BUDGET_USD_DAILY: "10" }, fetcher, Date.now());
    assert.ok(paidCalls.length >= 1, "paid model attempted while budget allows");
    const before = paidCalls.length;
    const second = await runProbeCycle(db, { OPENROUTER_API_KEY: "k", PROBE_BUDGET_USD_DAILY: "10" }, fetcher, Date.now() + 1000);
    assert.equal(paidCalls.length, before, "no paid calls while paused");
    assert.ok(second.paidPausedUntil && second.paidPausedUntil > Date.now());
    assert.ok(second.probed.some((p) => p.id.endsWith(":free")), "free probing continues");
    assert.ok(first.probed.length >= 1);
  });
});

describe("routing", () => {
  test("only qualified models route; family exclusion holds; explicit null when none", async () => {
    const { db, sqlite } = freshDb();
    await runDiscovery(db, {}, fetchCatalog, Date.now());
    assert.equal(await resolveOptimalModel(db, "coding"), null, "nothing measured yet -> null, no fallback");
    sqlite.exec(`UPDATE model_catalog SET lifecycle = 'qualified', quality_score = 90, approved_by = 'hd' WHERE id = 'openrouter:anthropic/claude-x'`);
    sqlite.exec(`UPDATE model_catalog SET lifecycle = 'qualified', quality_score = 80 WHERE id = 'openrouter:acme/free-coder:free'`);
    assert.equal((await resolveOptimalModel(db, "coding"))!.id, "openrouter:anthropic/claude-x");
    assert.equal((await resolveOptimalModel(db, "coding", { excludeFamily: "anthropic" }))!.id, "openrouter:acme/free-coder:free");
    assert.equal(await resolveOptimalModel(db, "coding", { excludeFamily: "anthropic,acme" }), null);
    const catalog = await getModelCatalog(db);
    assert.equal(catalog[0].lifecycle, "qualified");
  });
});

describe("auth gate", () => {
  const env = { FACTORY_HUB_TOKEN: "pod-secret", GOVERNOR_ADMIN_TOKEN: "admin-secret" };
  const req = (method: string, path: string, token?: string) =>
    new Request(`https://gov.test${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  test("health open; everything else needs the pod token", () => {
    assert.equal(authGate(req("GET", "/health"), env), null);
    assert.equal(authGate(req("POST", "/api/telemetry/log"), env)!.status, 401);
    assert.equal(authGate(req("GET", "/api/models"), env)!.status, 401);
    assert.equal(authGate(req("GET", "/api/models", "pod-secret"), env), null);
  });
  test("a pod token cannot approve spend; the admin token can", () => {
    assert.equal(authGate(req("POST", "/api/models/x/approve", "pod-secret"), env)!.status, 403);
    assert.equal(authGate(req("POST", "/api/governor/probe", "pod-secret"), env)!.status, 403);
    assert.equal(authGate(req("POST", "/api/governor/probe-result", "pod-secret"), env)!.status, 403);
    assert.equal(authGate(req("POST", "/api/models/x/approve", "admin-secret"), env), null);
    assert.equal(authGate(req("POST", "/api/governor/probe-result", "admin-secret"), env), null);
    assert.equal(authGate(req("POST", "/api/models/x/approve", "admin-secret"), {})!.status, 403, "fails closed without admin token");
  });
});

describe("OAuth subscription models and device probing", () => {
  test("records probe with device provenance and $0 cost, qualifies without paid approval", async () => {
    const { db, sqlite } = freshDb();
    const now = Date.now();
    const oauthTarget = {
      id: "claude-code:claude-sonnet-5",
      provider: "anthropic",
      modelName: "claude-sonnet-5",
      tier: "OAUTH",
      inputCostPer1M: 0,
      outputCostPer1M: 0,
    };
    sqlite.exec(`
      INSERT INTO model_catalog (id, provider, model_name, family, category, tier, input_cost_per_1m, output_cost_per_1m, source, first_seen_at, last_seen_at, lifecycle, status)
      VALUES ('claude-code:claude-sonnet-5', 'anthropic', 'claude-sonnet-5', 'anthropic', 'coding', 'OAUTH', 0, 0, 'oauth_device', ${now}, ${now}, 'candidate', 'active')
    `);

    // Run 3 passing probe cycles with device = "mac-mini"
    for (let i = 1; i <= 3; i++) {
      const probeRes = {
        modelId: oauthTarget.id,
        passed: 5,
        total: 5,
        latencyMs: 820,
        tokensPerSec: 42.5,
        promptTokens: 400,
        completionTokens: 100,
        costUsd: 0,
        device: "mac-mini",
      };
      const lifecycle = await recordProbe(db, oauthTarget, probeRes, now + i * 1000);
      assert.equal(lifecycle, i < 3 ? "candidate" : "qualified");
    }

    // Verify model_probes records device and 0 cost
    const probeRows = sqlite.prepare("SELECT model_id, device, cost_usd FROM model_probes WHERE model_id = ?").all(oauthTarget.id) as any[];
    assert.equal(probeRows.length, 3);
    assert.equal(probeRows[0].device, "mac-mini");
    assert.equal(probeRows[0].cost_usd, 0);

    // Verify route?category=coding picks the qualified OAUTH model
    const routed = await resolveOptimalModel(db, "coding");
    assert.ok(routed);
    assert.equal(routed.id, "claude-code:claude-sonnet-5");
    assert.equal(routed.tier, "OAUTH");
  });
});

describe("quota awareness & routing failover", () => {
  test("excludes exhausted provider from routing", async () => {
    const { db, sqlite } = freshDb();
    const now = Date.now();
    sqlite.exec(`
      INSERT INTO model_catalog (id, provider, model_name, family, category, tier, input_cost_per_1m, output_cost_per_1m, source, lifecycle, status, quality_score)
      VALUES
        ('codex:gpt-5', 'openai', 'gpt-5', 'openai', 'coding', 'OAUTH', 0, 0, 'oauth_device', 'qualified', 'active', 95),
        ('claude-code:sonnet', 'anthropic', 'claude-sonnet-5', 'anthropic', 'coding', 'OAUTH', 0, 0, 'oauth_device', 'qualified', 'active', 90)
    `);

    // Initially openai has higher quality score (95 vs 90)
    assert.equal((await resolveOptimalModel(db, "coding"))!.id, "codex:gpt-5");

    // OpenAI hits quota limit
    sqlite.exec(`
      INSERT INTO provider_quotas (provider, status, error, exhausted_at, updated_at)
      VALUES ('openai', 'exhausted', 'usage limit reached', ${now}, ${now})
    `);

    // Route now fails over to anthropic
    const routed = await resolveOptimalModel(db, "coding");
    assert.ok(routed);
    assert.equal(routed.id, "claude-code:sonnet");
  });
});

describe("subscription advisor", () => {
  test("returns insufficient_data when events or days observed are below threshold", async () => {
    const { db } = freshDb();
    const advisor = await getSubscriptionAdvisor(db);
    assert.equal(advisor.status, "insufficient_data");
    assert.match(advisor.message, /insufficient data/);
    assert.deepEqual(advisor.recommendations, []);
    assert.equal(advisor.dataWindow.eventsCount, 0);
  });

  test("names data window and calculates honest recommendations without invented savings", async () => {
    const { db, sqlite } = freshDb();
    const now = Date.now();
    const tenDaysAgo = now - 10 * 86_400_000;

    // Seed 60 usage events across 10 days for Anthropic spending $50 total
    for (let i = 0; i < 60; i++) {
      const ts = tenDaysAgo + i * (10 * 86_400_000 / 60);
      sqlite.exec(`
        INSERT INTO llm_usage_events (
          id, pod_id, provider, model_id, tier, prompt_tokens, completion_tokens, total_tokens, cost_usd, saved_usd, latency_ms, status, created_at
        ) VALUES ('use_${i}', 'pod_x', 'anthropic', 'claude-sonnet-5', 'PAID', 1000, 500, 1500, 0.8333, 0, 500, 'success', ${ts})
      `);
    }

    // $50 across 10 days extrapolates to $150/mo. Anthropic subscription is $20/mo.
    const advisor = await getSubscriptionAdvisor(db, { days: 30, minDays: 7, minEvents: 50 });
    assert.equal(advisor.status, "active");
    assert.equal(advisor.dataWindow.eventsCount, 60);
    assert.ok(advisor.dataWindow.daysObserved >= 9.5);
    assert.equal(advisor.recommendations.length, 1);

    const rec = advisor.recommendations[0];
    assert.equal(rec.family, "anthropic");
    assert.equal(rec.subscriptionPriceUsd, 20);
    assert.ok(rec.monthlyProjectedSpendUsd > 100);
    assert.equal(rec.recommended, true);
    assert.ok(rec.monthlyProjectedSavingsUsd > 80);
    assert.match(rec.reason, /exceeds subscription price/);
  });
});

const DAY = 86_400_000;
const DAY_START = Date.parse("2026-11-02T00:00:00.000Z");

async function insertUsage(db: any, rows: { model: string; status?: string; tokens?: number; cost?: number; latency?: number; at?: number; tier?: string }[]) {
  for (const r of rows) {
    await db.prepare(`INSERT INTO llm_usage_events (id, pod_id, provider, model_id, tier, prompt_tokens, completion_tokens,
        total_tokens, cost_usd, saved_usd, latency_ms, status, created_at) VALUES (?, 'pm-pod', 'openrouter', ?, ?, 10, 0, 10, ?, 0, ?, ?, ?)`)
      .bind(`u_${Math.random().toString(36).slice(2)}`, r.model, r.tier ?? "PAID", r.cost ?? 0, r.latency ?? 500, r.status ?? "success", r.at ?? DAY_START + 3600_000)
      .run();
  }
}

async function insertModel(db: any, m: { id: string; provider?: string; category?: string; tier?: string; quality?: number; latency?: number; cost?: number; lifecycle?: string; firstSeen?: number; runs?: number }) {
  await db.prepare(`INSERT INTO model_catalog (id, provider, model_name, category, tier, input_cost_per_1m, output_cost_per_1m,
      avg_latency_ms, quality_score, lifecycle, status, probe_runs, first_seen_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 'active', ?, ?)`)
    .bind(m.id, m.provider ?? "openrouter", m.id.includes(":") ? m.id.slice(m.id.indexOf(":") + 1) : m.id, m.category ?? "coding", m.tier ?? "PAID", m.latency ?? 400, m.quality ?? 90, m.lifecycle ?? "qualified", m.runs ?? 3, m.firstSeen ?? null)
    .run();
}

describe("usage analyzer", () => {
  test("nearest-rank percentile", () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([100], 95), 100);
    assert.equal(percentile([10, 20, 30, 40], 50), 20);
    assert.equal(percentile([10, 20, 30, 40], 95), 40);
  });

  test("aggregates calls, errors and successful-call latency per model", async () => {
    const { db } = freshDb();
    await insertModel(db, { id: "openrouter:a" });
    await insertUsage(db, [
      ...Array.from({ length: 18 }, (_, i) => ({ model: "openrouter:a", latency: 100 + i * 10, cost: 0.01 })),
      { model: "openrouter:a", status: "error", latency: 9, cost: 0 },
      { model: "openrouter:a", status: "rate_limited", latency: 9, cost: 0 },
    ]);
    const report = await analyzeUsage(db, DAY_START, DAY_START + DAY);
    const m = report.models[0];
    assert.equal(m.calls, 20);
    assert.equal(m.errors, 2);
    assert.equal(m.rateLimited, 1);
    assert.equal(m.errorRate, 0.1);
    // 18 successes at 100..270 ms: nearest rank p50 is the 9th of 18; the 9 ms failures must not drag it down.
    assert.equal(m.p50LatencyMs, 180);
    assert.equal(m.p95LatencyMs, 270);
    assert.equal(report.totals.calls, 20);
    assert.equal(report.totals.errors, 2);
    assert.equal(report.totals.freeOrOauthTokenPct, 0);
  });

  test("flags a model failing at least 10% of 20+ calls; ignores small samples", async () => {
    const { db } = freshDb();
    await insertUsage(db, [
      ...Array.from({ length: 15 }, () => ({ model: "m/big" })),
      ...Array.from({ length: 5 }, () => ({ model: "m/big", status: "error" })),
      ...Array.from({ length: 3 }, () => ({ model: "m/small", status: "error" })),
    ]);
    const report = await analyzeUsage(db, DAY_START, DAY_START + DAY);
    const high = report.recommendations.filter((r) => r.kind === "high_error_rate");
    assert.deepEqual(high.map((r) => [r.modelId, r.severity]), [["m/big", "high"]]);
    assert.equal(report.recommendations.filter((r) => r.modelId === "m/small").length, 0);
  });

  test("suggests a qualified model that is at least as good and cheaper for the same tokens", async () => {
    const { db } = freshDb();
    await insertModel(db, { id: "openrouter:pricey", quality: 80, runs: 3 });
    await insertModel(db, { id: "openrouter:free-coder", tier: "FREE_TIER", quality: 85, runs: 5 });
    await insertUsage(db, Array.from({ length: 20 }, () => ({ model: "openrouter:pricey", cost: 2 })));
    const report = await analyzeUsage(db, DAY_START, DAY_START + DAY);
    const alt = report.recommendations.find((r) => r.kind === "cheaper_alternative");
    assert.ok(alt, "expected a cheaper-alternative recommendation");
    assert.equal(alt.evidence.alternative, "openrouter:free-coder");
    assert.equal(alt.evidence.estimatedCostAtAlternativeUsd, 0);
    // A model that only matches, never beats, must not be suggested for a single-model category.
    const { db: db2 } = freshDb();
    await insertModel(db2, { id: "openrouter:only", quality: 95 });
    await insertUsage(db2, Array.from({ length: 20 }, () => ({ model: "openrouter:only", cost: 1 })));
    const alone = await analyzeUsage(db2, DAY_START, DAY_START + DAY);
    assert.equal(alone.recommendations.some((r) => r.kind === "cheaper_alternative"), false);
  });

  test("flags PAID-tier calls that recorded no cost, so invisible spend cannot hide", async () => {
    const { db } = freshDb();
    // No catalog row: recordUsage falls back to PAID with zero cost.
    await insertUsage(db, Array.from({ length: 20 }, () => ({ model: "google/unpriced", tier: "PAID", cost: 0 })));
    const report = await analyzeUsage(db, DAY_START, DAY_START + DAY);
    const unpriced = report.recommendations.find((r) => r.kind === "unpriced");
    assert.equal(unpriced?.modelId, "google/unpriced");
    assert.equal(unpriced?.severity, "warn");
  });

  test("flags an unprobed model and reports models discovered inside the window", async () => {
    const { db } = freshDb();
    await insertModel(db, { id: "openrouter:fresh", runs: 0, firstSeen: DAY_START + 7200_000, lifecycle: "candidate" });
    await insertModel(db, { id: "openrouter:old", firstSeen: DAY_START - DAY });
    await insertUsage(db, Array.from({ length: 20 }, () => ({ model: "openrouter:fresh" })));
    const report = await analyzeUsage(db, DAY_START, DAY_START + DAY);
    assert.equal(report.recommendations.find((r) => r.kind === "unmeasured")!.modelId, "openrouter:fresh");
    assert.deepEqual(report.radar.newlyDiscoveredIds, ["openrouter:fresh"]);
    assert.equal(report.radar.newlyDiscoveredCount, 1);
  });

  test("stores one report per day: the second run reuses it and force regenerates", async () => {
    const { db } = freshDb();
    await insertUsage(db, [{ model: "m/x", cost: 1 }]);
    const now = DAY_START + DAY; // the previous complete UTC day is 2026-11-02
    const first = await runDailyUsageAnalysis(db, now);
    assert.equal(first.generated, true);
    assert.equal(first.report.date, "2026-11-02");
    await insertUsage(db, [{ model: "m/x", cost: 5 }]);
    const second = await runDailyUsageAnalysis(db, now);
    assert.equal(second.generated, false);
    assert.equal(second.report.totals.costUsd, 1);
    const forced = await runDailyUsageAnalysis(db, now, { force: true });
    assert.equal(forced.generated, true);
    assert.equal(forced.report.totals.costUsd, 6);
    assert.equal((await getUsageReport(db))!.date, "2026-11-02");
  });

  test("refuses an incomplete or unparseable day", async () => {
    const { db } = freshDb();
    await assert.rejects(() => runDailyUsageAnalysis(db, DAY_START + 60_000, { date: "2026-11-02" }), /not complete/);
    await assert.rejects(() => runDailyUsageAnalysis(db, DAY_START, { date: "not-a-date" }), /invalid date/);
  });

  test("recordUsage stores the outcome it is given", async () => {
    const { db } = freshDb();
    await recordUsage(db, { podId: "pm-pod", provider: "openrouter", modelId: "m/x", promptTokens: 1, completionTokens: 1, latencyMs: 5, status: "rate_limited" });
    const row = (await db.prepare("SELECT status FROM llm_usage_events").first()) as { status: string } | null;
    assert.equal(row?.status, "rate_limited");
  });
});

describe("discovery cadence", () => {
  const failing = async () => {
    throw new Error("upstream down");
  };

  test("runs once a day, not on every scheduler tick", async () => {
    const { db } = freshDb();
    const first = await runScheduledDiscovery(db, {}, DAY_START, fetchCatalog);
    assert.ok(first && first.some((r) => r.seen > 0));
    assert.equal(await runScheduledDiscovery(db, {}, DAY_START + 5 * 60_000, fetchCatalog), null);
    assert.equal(await runScheduledDiscovery(db, {}, DAY_START + DAY - 60_000, fetchCatalog), null);
    const next = await runScheduledDiscovery(db, {}, DAY_START + DAY, fetchCatalog);
    assert.ok(next, "a day after the last successful run it must run again");
  });

  test("a failed run does not count as success and retries at most hourly", async () => {
    const { db } = freshDb();
    const failed = await runScheduledDiscovery(db, {}, DAY_START, failing);
    assert.ok(failed && failed.every((r) => r.error), "a total failure is reported, not thrown");
    assert.equal(await runScheduledDiscovery(db, {}, DAY_START + 30 * 60_000, fetchCatalog), null);
    const retried = await runScheduledDiscovery(db, {}, DAY_START + 61 * 60_000, fetchCatalog);
    assert.ok(retried && retried.some((r) => r.seen > 0));
  });
});

describe("usage report routes and dashboard", () => {
  const env = (db: any) => ({ DB: db, FACTORY_HUB_TOKEN: "hub-secret", GOVERNOR_ADMIN_TOKEN: "admin-secret", POD_ID: "model-governor-pod" });
  const now = DAY_START + DAY;

  test("GET /api/governor/usage-report needs the hub token, 404s before a report, then serves it", async () => {
    const { db } = freshDb();
    await insertUsage(db, [{ model: "m/x", cost: 1 }]);
    const unauthed = await worker.fetch(new Request("https://gov.test/api/governor/usage-report"), env(db));
    assert.equal(unauthed.status, 401);
    const missing = await worker.fetch(new Request("https://gov.test/api/governor/usage-report", { headers: { Authorization: "Bearer hub-secret" } }), env(db));
    assert.equal(missing.status, 404);
    await runDailyUsageAnalysis(db, now);
    const res = await worker.fetch(new Request("https://gov.test/api/governor/usage-report", { headers: { Authorization: "Bearer hub-secret" } }), env(db));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { report: { date: string; totals: { calls: number } } };
    assert.equal(body.report.date, "2026-11-02");
    assert.equal(body.report.totals.calls, 1);
  });

  test("POST /api/governor/analyze requires the admin token and forces a fresh analysis", async () => {
    const { db } = freshDb();
    await insertUsage(db, [{ model: "m/x", cost: 2 }]);
    const post = (authorization: string, body: unknown) =>
      worker.fetch(
        new Request("https://gov.test/api/governor/analyze", { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        env(db),
      );
    assert.equal((await post("Bearer hub-secret", {})).status, 403);
    const first = await post("Bearer admin-secret", { date: "2026-11-02" });
    assert.equal(first.status, 200);
    const second = (await (await post("Bearer admin-secret", { date: "2026-11-02", force: true })).json()) as { generated: boolean };
    assert.equal(second.generated, true);
    const bad = await post("Bearer admin-secret", { date: "not-a-date" });
    assert.equal(bad.status, 400);
  });

  test("the dashboard shows yesterday's findings, or says there is no report yet", () => {
    const config = loadPodConfig();
    const report = {
      date: "2026-11-02",
      windowStart: DAY_START,
      windowEnd: DAY_START + DAY,
      generatedAt: DAY_START + 2 * DAY,
      totals: { calls: 40, errors: 6, tokens: 400, costUsd: 1.5, tokensByTier: { PAID: 400 }, freeOrOauthTokenPct: 0 },
      models: [],
      pods: [],
      recommendations: [{ kind: "high_error_rate" as const, severity: "high" as const, modelId: "openrouter:flaky", message: "15.0% of 40 calls failed", evidence: { calls: 40 } }],
      radar: { newlyDiscoveredCount: 0, newlyDiscoveredIds: [], providersNotActive: [] },
    };
    const withReport = renderPodUiHtml(config, [], [], undefined, [], null, report);
    assert.ok(withReport.includes("Yesterday's Model Usage"));
    assert.ok(withReport.includes("2026-11-02"));
    assert.ok(withReport.includes("openrouter:flaky"));
    const without = renderPodUiHtml(config, []);
    assert.ok(without.includes("No daily usage report yet"));
  });
});

describe("scheduler", () => {
  test("the cron tick stores yesterday's usage report once, even if it fires repeatedly", async () => {
    const { db } = freshDb();
    const now = Date.now();
    const yesterdayStart = Date.parse(`${utcDate(now - DAY)}T00:00:00.000Z`);
    await insertUsage(db, Array.from({ length: 21 }, (_, i) => ({ model: "m/x", cost: 0.5, at: yesterdayStart + 60_000 + i })));
    const scheduleEnv = { DB: db, FACTORY_HUB_TOKEN: "hub-secret", POD_ID: "model-governor-pod" };

    await worker.scheduled({}, scheduleEnv);
    const report = await getUsageReport(db);
    assert.equal(report!.date, utcDate(now - DAY));
    assert.equal(report!.totals.calls, 21);

    await worker.scheduled({}, scheduleEnv);
    const rows = (await db.prepare("SELECT COUNT(*) n FROM usage_reports").first()) as { n: number } | null;
    assert.equal(rows?.n, 1, "a second tick must not create a second report for the same day");
  });
});

describe("governor-mediated inference", () => {
  const env = { OPENROUTER_API_KEY: "sk-or-test" };
  const providerAnswer = (content: string) =>
    (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 11, completion_tokens: 4 } }), { status: 200 })) as unknown as typeof fetch;

  test("uses the chosen model's provider with the governor's key and records the usage", async () => {
    const { db } = freshDb();
    await insertModel(db, { id: "openrouter:acme/free", tier: "FREE_TIER", quality: 90 });
    let called = "";
    const fetcher = (async (url: string) => {
      called = url;
      return providerAnswer("PONG")(url);
    }) as unknown as typeof fetch;
    const result = await runInference(db, env, { podId: "egm-spec-pod", model: "openrouter:acme/free", messages: [{ role: "user", content: "ping" }] }, fetcher);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.content, "PONG");
    assert.equal(called, "https://openrouter.ai/api/v1/chat/completions");
    const usage = (await db.prepare("SELECT pod_id, model_id, prompt_tokens, completion_tokens, status FROM llm_usage_events").first()) as Record<string, unknown> | null;
    assert.deepEqual({ ...usage }, { pod_id: "egm-spec-pod", model_id: "openrouter:acme/free", prompt_tokens: 11, completion_tokens: 4, status: "success" });
  });

  test("a pinned model it cannot serve falls back to routing instead of failing the caller", async () => {
    const { db } = freshDb();
    await insertModel(db, { id: "openrouter:acme/paid", tier: "PAID", quality: 99 });
    // Unapproved spend: the pin is a preference, so a free qualified model serves the call.
    await insertModel(db, { id: "openrouter:acme/free", tier: "FREE_TIER", quality: 60 });
    const served = await runInference(db, env, { podId: "p", model: "openrouter:acme/paid", messages: [{ role: "user", content: "x" }] }, providerAnswer("ok"));
    assert.equal(served.ok, true);
    assert.equal(served.ok && served.model, "openrouter:acme/free");
    // An unknown name is a caller bug and is named as such.
    const unknown = await runInference(db, env, { podId: "p", model: "openrouter:no/such", messages: [{ role: "user", content: "x" }] }, providerAnswer("ok"));
    assert.deepEqual([unknown.ok, !unknown.ok && unknown.status], [false, 404]);
  });

  test("a provider key the governor lacks is a 503 that names the provider", async () => {
    const { db } = freshDb();
    await insertModel(db, { id: "orcarouter:acme/x", tier: "FREE_TIER", quality: 90, provider: "orcarouter" });
    const result = await runInference(db, env, { podId: "p", model: "orcarouter:acme/x", messages: [{ role: "user", content: "x" }] }, providerAnswer("ok"));
    assert.equal(!result.ok && result.status, 503);
    assert.match(!result.ok ? result.error : "", /orcarouter/);
  });

  test("a provider 429 is recorded as rate_limited and marks the model", async () => {
    const { db } = freshDb();
    await insertModel(db, { id: "openrouter:acme/free", tier: "FREE_TIER", quality: 90 });
    const result = await runInference(db, env, { podId: "p", model: "openrouter:acme/free", messages: [{ role: "user", content: "x" }] }, (async () => new Response("", { status: 429 })) as unknown as typeof fetch);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 429);
    const usage = (await db.prepare("SELECT status FROM llm_usage_events").first()) as { status: string } | null;
    assert.equal(usage?.status, "rate_limited");
    const model = (await db.prepare("SELECT status FROM model_catalog WHERE id = 'openrouter:acme/free'").first()) as { status: string } | null;
    assert.equal(model?.status, "rate_limited");
  });

  test("routing skips a subscription model that has no HTTP endpoint", async () => {
    const { db } = freshDb();
    // Highest quality, but an oauth-tier subscription driven by a local CLI: no HTTP endpoint exists for it.
    await db
      .prepare("INSERT INTO model_catalog (id, provider, model_name, category, tier, quality_score, status, lifecycle) VALUES (?,?,?,?,?,?,?,?)")
      .bind("oauth:antigravity", "antigravity", "antigravity", "general_reasoning", "OAUTH", 99, "active", "qualified")
      .run();
    await insertModel(db, { id: "openrouter:acme/free", tier: "FREE_TIER", quality: 70 });
    const result = await runInference(db, env, { podId: "p", category: "general_reasoning", messages: [{ role: "user", content: "x" }] }, providerAnswer("OK"));
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.model, "openrouter:acme/free");
    // Naming it explicitly does not try to call it; the request is served by the callable model instead.
    const named = await runInference(db, env, { podId: "p", model: "oauth:antigravity", messages: [{ role: "user", content: "x" }] }, providerAnswer("OK"));
    assert.equal(named.ok && named.model, "openrouter:acme/free");
  });

  test("the route needs the hub token and validates its body", async () => {
    const { db } = freshDb();
    const routeEnv = { DB: db, FACTORY_HUB_TOKEN: "hub-secret", POD_ID: "model-governor-pod", OPENROUTER_API_KEY: "sk-or-test" };
    const post = (body: unknown, authorization = "Bearer hub-secret") =>
      worker.fetch(
        new Request("https://gov.test/api/inference", { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        routeEnv,
      );
    assert.equal((await post({ podId: "p", messages: [{ role: "user", content: "x" }] }, "Bearer nope")).status, 401);
    assert.equal((await post({ messages: [{ role: "user", content: "x" }] })).status, 400);
    assert.equal((await post({ podId: "p", messages: [{ role: "user" }] })).status, 400);
    // Nothing qualified in the catalog yet, so the governor says so instead of guessing a model.
    const none = await post({ podId: "p", messages: [{ role: "user", content: "x" }] });
    assert.equal(none.status, 404);
  });
});

describe("quota cooldowns", () => {
  const routeEnv = { OPENROUTER_API_KEY: "sk-or-test" };
  const answer = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: {} }), { status: 200 })) as unknown as typeof fetch;
  const setQuota = (db: Parameters<typeof insertModel>[0], status: string, updatedAt: number, resetsAt: number | null) =>
    db.prepare("INSERT INTO provider_quotas (provider, status, exhausted_at, resets_at, updated_at) VALUES ('openrouter', ?, ?, ?, ?)")
      .bind(status, updatedAt, resetsAt, updatedAt).run();

  test("a limit recorded without a reset time expires instead of banning the provider forever", async () => {
    const { db } = freshDb();
    await insertModel(db, { id: "openrouter:acme/free", tier: "FREE_TIER", quality: 80 });
    const now = Date.now();
    // Fresh rate limit: respected.
    await setQuota(db, "rate_limited", now - 60_000, null);
    assert.equal((await runInference(db, routeEnv, { podId: "p", category: "general_reasoning", messages: [{ role: "user", content: "x" }] }, answer)).ok, false);
    // Same flag twenty minutes later: the cooldown has passed, so routing resumes.
    await db.prepare("UPDATE provider_quotas SET updated_at = ? WHERE provider = 'openrouter'").bind(now - 20 * 60_000).run();
    const routed = await runInference(db, routeEnv, { podId: "p", category: "general_reasoning", messages: [{ role: "user", content: "x" }] }, answer);
    assert.equal(routed.ok, true);
    // An explicit future reset time still blocks regardless of age.
    await db.prepare("UPDATE provider_quotas SET status = 'exhausted', resets_at = ?, updated_at = ? WHERE provider = 'openrouter'").bind(now + 3_600_000, now - 90 * 60_000).run();
    assert.equal((await runInference(db, routeEnv, { podId: "p", messages: [{ role: "user", content: "x" }] }, answer)).ok, false);
  });
});
