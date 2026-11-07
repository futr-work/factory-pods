import type { PodStorage } from "@futr-work/pod-kernel/storage";

// Daily model usage analyzer. Reads what pods actually spent and how each model actually behaved
// (llm_usage_events), sets it beside what probes measured (model_catalog), and stores one report per
// UTC day. Every recommendation carries the numbers it rests on. Dollar figures are catalog-price
// arithmetic on the real token counts, labelled as estimates; nothing is an invented baseline.

const DAY_MS = 86_400_000;
/** A model needs this many calls in the window before a rule may judge it. */
export const MIN_CALLS = 20;
const ERROR_RATE_WARN = 0.1;
const ERROR_RATE_HIGH = 0.25;
const SLOW_RATIO = 2;
const MAX_EVENTS = 100_000;

interface UsageRow {
  pod_id: string;
  provider: string;
  model_id: string;
  tier: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  latency_ms: number;
  status: string;
}

interface CatalogRow {
  id: string;
  model_name: string;
  provider: string;
  category: string;
  tier: string;
  family: string | null;
  input_cost_per_1m: number | null;
  output_cost_per_1m: number | null;
  avg_latency_ms: number | null;
  quality_score: number | null;
  probe_runs: number;
  lifecycle: string;
  status: string;
  first_seen_at: number | null;
}

export interface ModelUsageStats {
  modelId: string;
  provider: string;
  tier: string;
  category: string | null;
  calls: number;
  errors: number;
  rateLimited: number;
  errorRate: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** Latency of successful calls only: failures time out or bail early and would flatter the numbers. */
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  probeRuns: number | null;
  /** Smoke-suite pass rate in percent; not a general quality claim. */
  probePassRate: number | null;
  probeAvgLatencyMs: number | null;
}

export type RecommendationKind = "high_error_rate" | "slow_vs_probe" | "unmeasured" | "cheaper_alternative" | "unpriced";

export interface Recommendation {
  kind: RecommendationKind;
  severity: "info" | "warn" | "high";
  modelId: string;
  message: string;
  evidence: Record<string, number | string | null>;
}

export interface UsageReport {
  date: string;
  windowStart: number;
  windowEnd: number;
  generatedAt: number;
  totals: {
    calls: number;
    errors: number;
    tokens: number;
    costUsd: number;
    tokensByTier: Record<string, number>;
    /** Share of tokens served by FREE_TIER or OAUTH models, in percent; null when no tokens. */
    freeOrOauthTokenPct: number | null;
  };
  models: ModelUsageStats[];
  pods: { podId: string; calls: number; errors: number; tokens: number; costUsd: number }[];
  recommendations: Recommendation[];
  radar: {
    newlyDiscoveredCount: number;
    newlyDiscoveredIds: string[];
    providersNotActive: { provider: string; status: string; resetsAt: number | null }[];
  };
}

export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Nearest-rank percentile on an ascending array. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

const round = (n: number, places = 6) => Number(n.toFixed(places));

function listCost(m: CatalogRow, promptTokens: number, completionTokens: number): number | null {
  if (m.tier === "FREE_TIER") return 0;
  if (m.input_cost_per_1m === null || m.output_cost_per_1m === null) return null;
  return (promptTokens / 1e6) * m.input_cost_per_1m + (completionTokens / 1e6) * m.output_cost_per_1m;
}

export async function analyzeUsage(db: PodStorage, windowStart: number, windowEnd: number, now = Date.now()): Promise<UsageReport> {
  const usage = (
    await db
      .prepare(
        `SELECT pod_id, provider, model_id, tier, prompt_tokens, completion_tokens, cost_usd, latency_ms, status
         FROM llm_usage_events WHERE created_at >= ? AND created_at < ? LIMIT ${MAX_EVENTS}`,
      )
      .bind(windowStart, windowEnd)
      .all<UsageRow>()
  ).results;
  const catalog = (await db.prepare("SELECT * FROM model_catalog").all<CatalogRow>()).results;
  // Usage events name a model by catalog id or by provider model name (see recordUsage).
  const byKey = new Map<string, CatalogRow>();
  for (const c of catalog) {
    byKey.set(c.model_name, c);
    byKey.set(c.id, c);
  }

  const groups = new Map<string, UsageRow[]>();
  for (const u of usage) {
    const g = groups.get(u.model_id);
    if (g) g.push(u);
    else groups.set(u.model_id, [u]);
  }

  const models: ModelUsageStats[] = [];
  for (const [modelId, rows] of groups) {
    const cat = byKey.get(modelId) ?? null;
    const ok = rows.filter((r) => r.status === "success");
    const latencies = ok.map((r) => r.latency_ms).sort((a, b) => a - b);
    const errors = rows.length - ok.length;
    models.push({
      modelId,
      provider: rows[0].provider,
      tier: cat?.tier ?? rows[0].tier,
      category: cat?.category ?? null,
      calls: rows.length,
      errors,
      rateLimited: rows.filter((r) => r.status === "rate_limited").length,
      errorRate: round(errors / rows.length, 4),
      promptTokens: rows.reduce((s, r) => s + r.prompt_tokens, 0),
      completionTokens: rows.reduce((s, r) => s + r.completion_tokens, 0),
      costUsd: round(rows.reduce((s, r) => s + r.cost_usd, 0)),
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      probeRuns: cat ? cat.probe_runs : null,
      probePassRate: cat?.quality_score ?? null,
      probeAvgLatencyMs: cat?.avg_latency_ms ?? null,
    });
  }
  models.sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls || a.modelId.localeCompare(b.modelId));

  const recommendations: Recommendation[] = [];
  const candidates = catalog.filter((c) => c.lifecycle === "qualified" && c.status === "active");
  for (const m of models) {
    if (m.calls < MIN_CALLS) continue;
    if (m.errorRate >= ERROR_RATE_WARN) {
      recommendations.push({
        kind: "high_error_rate",
        severity: m.errorRate >= ERROR_RATE_HIGH ? "high" : "warn",
        modelId: m.modelId,
        message: `${(m.errorRate * 100).toFixed(1)}% of ${m.calls} calls failed (${m.rateLimited} rate limited). Check provider status or route around it.`,
        evidence: { calls: m.calls, errors: m.errors, rateLimited: m.rateLimited },
      });
    }
    if (m.tier === "PAID" && m.costUsd === 0) {
      recommendations.push({
        kind: "unpriced",
        severity: "warn",
        modelId: m.modelId,
        message: `${m.calls} PAID-tier calls recorded zero cost: the model has no catalog pricing, so spend is invisible. Run discovery for it, or have the caller send actualCost.`,
        evidence: { calls: m.calls, costUsd: m.costUsd },
      });
    }
    if (m.probeRuns === 0 || m.probeRuns === null) {
      recommendations.push({
        kind: "unmeasured",
        severity: "info",
        modelId: m.modelId,
        message: `${m.calls} calls used a model with no capability probe on record. Probe it so routing rests on a measurement.`,
        evidence: { calls: m.calls, probeRuns: m.probeRuns },
      });
    }
    if (m.p50LatencyMs !== null && m.probeAvgLatencyMs && m.calls - m.errors >= MIN_CALLS && m.p50LatencyMs >= SLOW_RATIO * m.probeAvgLatencyMs) {
      recommendations.push({
        kind: "slow_vs_probe",
        severity: "warn",
        modelId: m.modelId,
        message: `Real median latency ${m.p50LatencyMs} ms is ${(m.p50LatencyMs / m.probeAvgLatencyMs).toFixed(1)}x the probe average (${m.probeAvgLatencyMs} ms). Production prompts or provider load differ from the smoke suite.`,
        evidence: { p50LatencyMs: m.p50LatencyMs, probeAvgLatencyMs: m.probeAvgLatencyMs },
      });
    }
    const cat = byKey.get(m.modelId);
    if (cat && m.costUsd > 0 && m.probePassRate !== null) {
      let best: { id: string; cost: number } | null = null;
      for (const alt of candidates) {
        if (alt.id === cat.id || alt.category !== cat.category) continue;
        if (alt.quality_score === null || alt.quality_score < m.probePassRate) continue;
        const cost = listCost(alt, m.promptTokens, m.completionTokens);
        if (cost !== null && cost < m.costUsd && (!best || cost < best.cost)) best = { id: alt.id, cost };
      }
      if (best) {
        recommendations.push({
          kind: "cheaper_alternative",
          severity: "info",
          modelId: m.modelId,
          message: `Qualified ${best.id} passes the same smoke suite at least as well. Estimated ${round(best.cost, 4)} USD instead of ${m.costUsd} USD for these tokens at catalog prices. The suite is a smoke test, so confirm on real prompts before switching.`,
          evidence: { alternative: best.id, estimatedCostAtAlternativeUsd: round(best.cost), actualCostUsd: m.costUsd, probePassRate: m.probePassRate },
        });
      }
    }
  }
  const sevOrder = { high: 0, warn: 1, info: 2 } as const;
  recommendations.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || a.modelId.localeCompare(b.modelId) || a.kind.localeCompare(b.kind));

  const podMap = new Map<string, { podId: string; calls: number; errors: number; tokens: number; costUsd: number }>();
  const tokensByTier: Record<string, number> = {};
  let tokens = 0;
  for (const u of usage) {
    const p = podMap.get(u.pod_id) ?? { podId: u.pod_id, calls: 0, errors: 0, tokens: 0, costUsd: 0 };
    const t = u.prompt_tokens + u.completion_tokens;
    p.calls += 1;
    p.errors += u.status === "success" ? 0 : 1;
    p.tokens += t;
    p.costUsd += u.cost_usd;
    podMap.set(u.pod_id, p);
    tokensByTier[u.tier] = (tokensByTier[u.tier] ?? 0) + t;
    tokens += t;
  }
  const freeTokens = (tokensByTier.FREE_TIER ?? 0) + (tokensByTier.OAUTH ?? 0);

  const fresh = catalog.filter((c) => c.first_seen_at !== null && c.first_seen_at >= windowStart && c.first_seen_at < windowEnd);
  const quotas = (
    await db.prepare("SELECT provider, status, resets_at FROM provider_quotas WHERE status != 'active'").all<{ provider: string; status: string; resets_at: number | null }>()
  ).results;

  return {
    date: utcDate(windowStart),
    windowStart,
    windowEnd,
    generatedAt: now,
    totals: {
      calls: usage.length,
      errors: usage.filter((u) => u.status !== "success").length,
      tokens,
      costUsd: round(usage.reduce((s, u) => s + u.cost_usd, 0)),
      tokensByTier,
      freeOrOauthTokenPct: tokens > 0 ? round((freeTokens / tokens) * 100, 1) : null,
    },
    models,
    pods: [...podMap.values()].map((p) => ({ ...p, costUsd: round(p.costUsd) })).sort((a, b) => b.costUsd - a.costUsd || a.podId.localeCompare(b.podId)),
    recommendations,
    radar: {
      newlyDiscoveredCount: fresh.length,
      newlyDiscoveredIds: fresh.map((c) => c.id).sort().slice(0, 20),
      providersNotActive: quotas.map((q) => ({ provider: q.provider, status: q.status, resetsAt: q.resets_at })),
    },
  };
}

export async function getUsageReport(db: PodStorage, date?: string): Promise<UsageReport | null> {
  const row = date
    ? await db.prepare("SELECT report_json FROM usage_reports WHERE report_date = ?").bind(date).first<{ report_json: string }>()
    : await db.prepare("SELECT report_json FROM usage_reports ORDER BY report_date DESC LIMIT 1").first<{ report_json: string }>();
  return row ? (JSON.parse(row.report_json) as UsageReport) : null;
}

/**
 * Analyzes one complete UTC day (default: the day before `now`) and stores the report. Safe to call on every
 * scheduler tick: a day that already has a report is left alone unless `force` is set.
 * Returns the report and whether this call generated it.
 */
export async function runDailyUsageAnalysis(
  db: PodStorage,
  now: number,
  opts: { date?: string; force?: boolean } = {},
): Promise<{ report: UsageReport; generated: boolean }> {
  const date = opts.date ?? utcDate(now - DAY_MS);
  const windowStart = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(windowStart)) throw new Error(`invalid date: ${date}`);
  if (windowStart + DAY_MS > now) throw new Error(`${date} is not complete yet`);
  if (!opts.force) {
    const existing = await getUsageReport(db, date);
    if (existing) return { report: existing, generated: false };
  }
  const report = await analyzeUsage(db, windowStart, windowStart + DAY_MS, now);
  await db
    .prepare(
      `INSERT INTO usage_reports (report_date, window_start, window_end, report_json, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(report_date) DO UPDATE SET window_start = excluded.window_start, window_end = excluded.window_end,
         report_json = excluded.report_json, created_at = excluded.created_at`,
    )
    .bind(date, report.windowStart, report.windowEnd, JSON.stringify(report), now)
    .run();
  return { report, generated: true };
}
