import type { PodStorage } from "@futr-work/pod-kernel/storage";

const DAY = 86_400_000;
export const FREE_POOL = "openrouter:free";

export function dailyPoolDenial(provider: string, tier: string, status: number, message: string): boolean {
  return provider === "openrouter" && tier === "FREE_TIER" && status === 429 && /\bfree-models-per-day\b/i.test(message);
}

export async function markFreePoolExhausted(db: PodStorage, now: number): Promise<void> {
  const reset = (Math.floor(now / DAY) + 1) * DAY;
  await db.prepare(`INSERT INTO provider_quotas (provider,status,error,exhausted_at,resets_at,updated_at)
    VALUES (?, 'exhausted', 'OpenRouter free daily request limit', ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET status=excluded.status,error=excluded.error,
      exhausted_at=excluded.exhausted_at,resets_at=excluded.resets_at,updated_at=excluded.updated_at`)
    .bind(FREE_POOL,now,reset,now).run();
}

export async function freePoolReset(db: PodStorage, now: number): Promise<number | null> {
  const row = await db.prepare("SELECT resets_at FROM provider_quotas WHERE provider=? AND status='exhausted' AND resets_at>?")
    .bind(FREE_POOL,now).first<{resets_at:number}>();
  return row?.resets_at ?? null;
}

export function probeRequestLimit(setting?: string): number {
  if (setting === undefined) return 20;
  const limit = Number(setting);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
}

function counter(now: number) {
  const start = Math.floor(now / DAY) * DAY;
  return { start, key: "probe_requests:" + new Date(start).toISOString().slice(0,10) };
}

// Old probes lack individual request receipts. Conservatively charge the suite length even if it failed early.
const legacyCount = "(SELECT COALESCE(SUM(total),0) FROM model_probes WHERE device IS NULL AND created_at>=? AND created_at<?)";

export async function probeStatus(db: PodStorage, setting?: string, now = Date.now()) {
  const {key,start} = counter(now);
  const row = await db.prepare(`SELECT COALESCE((SELECT CAST(value_json AS INTEGER) FROM pod_info WHERE key=?),
    ${legacyCount}) AS charged, (SELECT COUNT(*) FROM pod_info WHERE key GLOB 'probe_change:*' AND json_extract(value_json,'$.pending')=1) AS pending`)
    .bind(key,start,start+DAY).first<{charged:number;pending:number}>();
  const dailyLimit = probeRequestLimit(setting);
  return {utcDate:new Date(start).toISOString().slice(0,10), dailyLimit, charged:row!.charged,
    remaining:Math.max(0,dailyLimit-row!.charged), pendingChanges:row!.pending, openRouterFreeReset:await freePoolReset(db,now)};
}

/** Count an attempt before dispatch. No refund on cancellation, transport failure, or isolate loss. */
export async function reserveProbeRequest(db: PodStorage, limit: number, now: number): Promise<boolean> {
  if (!limit) return false;
  const {key,start} = counter(now);
  await db.prepare(`INSERT INTO pod_info(key,value_json,updated_at) SELECT ?, CAST(${legacyCount} AS TEXT), ?
    WHERE NOT EXISTS (SELECT 1 FROM pod_info WHERE key=?) ON CONFLICT(key) DO NOTHING`)
    .bind(key,start,start+DAY,now,key).run();
  const reservation = await db.prepare(`UPDATE pod_info SET value_json=CAST(CAST(value_json AS INTEGER)+1 AS TEXT),
    updated_at=? WHERE key=? AND CAST(value_json AS INTEGER) < ?`).bind(now,key,limit).run();
  return reservation.meta?.changes === 1;
}
