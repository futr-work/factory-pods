// Tiered routing and per-caller budgets. A tier is derived from the catalog price, never hand-assigned:
//   tier 0  free (FREE_TIER, or a zero price)
//   tier 1  cheap paid: output price <= TIER1_MAX_OUTPUT_COST_PER_1M (default $4/1M)
//   tier 2  premium: anything pricier, or a paid model whose price is unknown
// A caller (X-Governor-Caller, else podId) has a policy: the tier it starts at, the highest tier it may reach,
// and a daily spend cap. Over the cap, paid tiers are off for the rest of the UTC day.

import type { PodStorage } from "@futr-work/pod-kernel/storage";
import type { ModelEntry } from "./governor.js";

export type Tier = 0 | 1 | 2;

export interface RoutingEnv {
  TIER1_MAX_OUTPUT_COST_PER_1M?: string;
  DEFAULT_CALLER_TIER?: string;
  DEFAULT_CALLER_MAX_TIER?: string;
  DEFAULT_CALLER_DAILY_BUDGET_USD?: string;
  /** Optional fleet-wide daily cap. Per-caller caps trust the caller header; this one does not. */
  GOVERNOR_DAILY_BUDGET_USD?: string;
}

export interface CallerPolicy {
  callerId: string;
  category: string | null;
  preferredTier: Tier;
  maxTier: Tier;
  dailyBudgetUsd: number;
  /** Which row supplied it: the caller's own, the stored '*' default, or the environment defaults. */
  source: "caller" | "stored_default" | "env_default";
}

export interface BudgetState {
  policy: CallerPolicy;
  spentTodayUsd: number;
  capped: boolean;
  /** Which cap is spent: the caller's own, or the fleet-wide one. */
  cappedBy: "caller" | "fleet" | null;
  /** The tier ceiling in force for this request after the cap is applied. */
  effectiveMaxTier: Tier;
}

const DAY_MS = 86_400_000;
export const DEFAULT_TIER1_MAX_OUTPUT_COST_PER_1M = 4;

function num(raw: string | undefined, fallback: number): number {
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function asTier(n: unknown, fallback: Tier): Tier {
  const t = Number(n);
  return t === 0 || t === 1 || t === 2 ? t : fallback;
}

export function tierOf(model: ModelEntry, env: RoutingEnv = {}): Tier {
  if (model.tier === "FREE_TIER") return 0;
  if (model.outputCostPer1M === 0 && model.inputCostPer1M === 0) return 0;
  if (model.outputCostPer1M === null) return 2;
  return model.outputCostPer1M <= num(env.TIER1_MAX_OUTPUT_COST_PER_1M, DEFAULT_TIER1_MAX_OUTPUT_COST_PER_1M) ? 1 : 2;
}

export function startOfUtcDay(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

function fromRow(callerId: string, r: any, source: CallerPolicy["source"]): CallerPolicy {
  const maxTier = asTier(r.max_tier, 1);
  return {
    callerId,
    category: r.category ?? null,
    preferredTier: Math.min(asTier(r.preferred_tier, 0), maxTier) as Tier,
    maxTier,
    dailyBudgetUsd: Number(r.daily_budget_usd),
    source,
  };
}

export async function getCallerPolicy(db: PodStorage, callerId: string, env: RoutingEnv = {}): Promise<CallerPolicy> {
  const own = await db.prepare("SELECT * FROM caller_policies WHERE caller_id = ?").bind(callerId).first<any>();
  if (own) return fromRow(callerId, own, "caller");
  const stored = await db.prepare("SELECT * FROM caller_policies WHERE caller_id = '*'").first<any>();
  if (stored) return fromRow(callerId, stored, "stored_default");
  return fromRow(
    callerId,
    {
      category: null,
      preferred_tier: num(env.DEFAULT_CALLER_TIER, 0),
      max_tier: num(env.DEFAULT_CALLER_MAX_TIER, 1),
      daily_budget_usd: num(env.DEFAULT_CALLER_DAILY_BUDGET_USD, 1),
    },
    "env_default",
  );
}

export interface PolicyPatch {
  category?: string | null;
  preferredTier?: number;
  maxTier?: number;
  dailyBudgetUsd?: number;
}

export async function setCallerPolicy(db: PodStorage, callerId: string, patch: PolicyPatch, env: RoutingEnv = {}, now = Date.now()): Promise<CallerPolicy> {
  const current = await getCallerPolicy(db, callerId, env);
  const maxTier = patch.maxTier === undefined ? current.maxTier : asTier(patch.maxTier, current.maxTier);
  const preferredTier = patch.preferredTier === undefined ? current.preferredTier : asTier(patch.preferredTier, current.preferredTier);
  const budget = patch.dailyBudgetUsd === undefined ? current.dailyBudgetUsd : Number(patch.dailyBudgetUsd);
  if (!Number.isFinite(budget) || budget < 0) throw new Error("dailyBudgetUsd must be a non-negative number");
  const category = patch.category === undefined ? current.category : patch.category;
  await db
    .prepare(`INSERT INTO caller_policies (caller_id, category, preferred_tier, max_tier, daily_budget_usd, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(caller_id) DO UPDATE SET category = excluded.category, preferred_tier = excluded.preferred_tier,
        max_tier = excluded.max_tier, daily_budget_usd = excluded.daily_budget_usd, updated_at = excluded.updated_at`)
    .bind(callerId, category, Math.min(preferredTier, maxTier), maxTier, budget, now)
    .run();
  return getCallerPolicy(db, callerId, env);
}

export async function spentToday(db: PodStorage, callerId: string, now = Date.now()): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM llm_usage_events WHERE pod_id = ? AND created_at >= ?")
    .bind(callerId, startOfUtcDay(now))
    .first<{ spent: number }>();
  return Number(row?.spent ?? 0);
}

export async function budgetState(db: PodStorage, callerId: string, env: RoutingEnv = {}, now = Date.now()): Promise<BudgetState> {
  const policy = await getCallerPolicy(db, callerId, env);
  const spentTodayUsd = await spentToday(db, callerId, now);
  const fleetCap = num(env.GOVERNOR_DAILY_BUDGET_USD, Infinity);
  let cappedBy: BudgetState["cappedBy"] = spentTodayUsd >= policy.dailyBudgetUsd ? "caller" : null;
  if (!cappedBy && Number.isFinite(fleetCap)) {
    const fleet = await db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM llm_usage_events WHERE created_at >= ?")
      .bind(startOfUtcDay(now))
      .first<{ spent: number }>();
    if (Number(fleet?.spent ?? 0) >= fleetCap) cappedBy = "fleet";
  }
  const capped = cappedBy !== null;
  return { policy, spentTodayUsd: +spentTodayUsd.toFixed(6), capped, cappedBy, effectiveMaxTier: capped ? 0 : policy.maxTier };
}

/** Tier visiting order: the preferred tier, then cheaper tiers (degrade before spending more), then pricier up to the ceiling. */
export function tierOrder(preferred: Tier, maxTier: Tier): Tier[] {
  const start = Math.min(preferred, maxTier);
  const order: Tier[] = [];
  for (let t = start; t >= 0; t--) order.push(t as Tier);
  for (let t = start + 1; t <= maxTier; t++) order.push(t as Tier);
  return order;
}

/** Orders routable models into the fallback chain: by tier order, then within a tier by the category's ranking. */
export function rankCandidates(models: ModelEntry[], category: string, order: Tier[], env: RoutingEnv = {}): { model: ModelEntry; tier: Tier }[] {
  const rank = new Map(order.map((t, i) => [t, i]));
  const within = (a: ModelEntry, b: ModelEntry) => {
    const q = (b.qualityScore ?? -1) - (a.qualityScore ?? -1);
    const cost = (a.outputCostPer1M ?? 1e9) - (b.outputCostPer1M ?? 1e9);
    const speed = (b.tokensPerSec ?? -1) - (a.tokensPerSec ?? -1);
    return category === "fast_classification" ? speed || q || cost : q || cost || speed;
  };
  return models
    .map((model) => ({ model, tier: tierOf(model, env) }))
    .filter((c) => rank.has(c.tier))
    .sort((a, b) => rank.get(a.tier)! - rank.get(b.tier)! || within(a.model, b.model) || a.model.id.localeCompare(b.model.id));
}

/** Today's spend against budget for every caller with a stored policy or usage today. */
export async function callersToday(db: PodStorage, env: RoutingEnv = {}, now = Date.now()) {
  const { results } = await db
    .prepare(`SELECT caller_id FROM caller_policies WHERE caller_id != '*'
      UNION SELECT DISTINCT pod_id FROM llm_usage_events WHERE created_at >= ?`)
    .bind(startOfUtcDay(now))
    .all<{ caller_id: string }>();
  const out = [];
  for (const r of results ?? []) {
    const s = await budgetState(db, r.caller_id, env, now);
    out.push({ ...s.policy, spentTodayUsd: s.spentTodayUsd, capped: s.capped, effectiveMaxTier: s.effectiveMaxTier });
  }
  return out.sort((a, b) => b.spentTodayUsd - a.spentTodayUsd || a.callerId.localeCompare(b.callerId));
}
