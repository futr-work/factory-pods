import type { PodStorage } from "@futr-work/pod-kernel/storage";
import {
  buildCollectorLeaseFenceStatement,
  ForbiddenError,
  LeaseFenceError,
  MeasurementService,
  NotFoundError,
  SQL_TX_NOW_MS_EXPR,
  ValidationError,
  type CollectorLeaseFence,
} from "../service.js";
import type {
  AtomicIngestGroupInput,
  CollectorConnector,
  CollectorFreshnessState,
  CollectorRunOutcome,
  CollectorRunRequest,
  CollectorScheduleInput,
  CollectorScheduleRecord,
  CollectorStatusItem,
  CollectorWindowOutcome,
  CoverageStatus,
  ObservationInput,
  RunStatus,
} from "../types.js";
import { bingMetricDefinitions, BING_SOURCE, collectBingWindow } from "./bing.js";
import {
  parseCollectorCredentials,
  redactCollectorSecrets,
  resolveCollectorCredential,
  type CollectorCredentialEntry,
} from "./credentials.js";
import { collectGscWindow, gscMetricDefinitions, GSC_SOURCE, type FetchLike } from "./gsc.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_CONNECTORS = new Set<CollectorConnector>(["gsc", "bing_webmaster"]);
const MAX_BACKFILL_WINDOWS_PER_CALL = 31;
const BASE_RETRY_COOLDOWN_SEC = 300;
const SCHEDULE_LEASE_MS = 5 * 60 * 1000;
const MAX_ATOMIC_OBS = 1000;

export class ScheduleLeaseLostError extends Error {
  constructor(message = "Schedule execution lease expired or was preempted") {
    super(message);
    this.name = "ScheduleLeaseLostError";
  }
}

function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function nextUtcMidnightMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

function addUtcDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function diffUtcDays(startIso: string, endIso: string): number {
  const [y1, m1, d1] = startIso.split("-").map(Number);
  const [y2, m2, d2] = endIso.split("-").map(Number);
  return Math.floor((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

function requireIsoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !DATE_RE.test(value.trim())) {
    throw new ValidationError(`Field '${field}' must be YYYY-MM-DD`);
  }
  const s = value.trim();
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.toISOString().slice(0, 10) !== s) {
    throw new ValidationError(`Field '${field}' is not a valid calendar date`);
  }
  return s;
}

function canonicalJson(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map((v) => canonicalJson(v)).join(",")}]`;
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function mapScheduleRow(row: any): CollectorScheduleRecord {
  let dimensions: string[] = [];
  try {
    const parsed = JSON.parse(String(row.dimensions_json || "[]"));
    if (Array.isArray(parsed)) dimensions = parsed.map((d) => String(d));
  } catch {
    dimensions = [];
  }
  return {
    scheduleId: String(row.schedule_id),
    tenantId: String(row.tenant_id),
    resourceId: String(row.resource_id),
    connector: row.connector as CollectorConnector,
    sourceResourceId: String(row.source_resource_id),
    credentialRef: String(row.credential_ref),
    cadenceSec: Number(row.cadence_sec),
    expectedLagSec: Number(row.expected_lag_sec),
    dailyRequestBudget: Number(row.daily_request_budget),
    maxRowsPerWindow: Number(row.max_rows_per_window),
    dimensions,
    searchType: String(row.search_type || "web"),
    zeroSpendConfirmed: Number(row.zero_spend_confirmed) === 1,
    enabled: Number(row.enabled) === 1,
    cursorDate: row.cursor_date ? String(row.cursor_date) : null,
    pendingWindowDate: row.pending_window_date ? String(row.pending_window_date) : null,
    nextRunAt: Number(row.next_run_at),
    lastAttemptAt: row.last_attempt_at !== null && row.last_attempt_at !== undefined ? Number(row.last_attempt_at) : null,
    lastSuccessAt: row.last_success_at !== null && row.last_success_at !== undefined ? Number(row.last_success_at) : null,
    consecutiveFailures: Number(row.consecutive_failures || 0),
    maxRetries: Number(row.max_retries || 3),
    cooldownUntil: row.cooldown_until !== null && row.cooldown_until !== undefined ? Number(row.cooldown_until) : null,
    lastStatus: (row.last_status || "planned") as RunStatus,
    lastErrorClass: row.last_error_class ? String(row.last_error_class) : null,
    lastErrorMessage: row.last_error_message ? String(row.last_error_message) : null,
    requestsUsedDate: row.requests_used_date ? String(row.requests_used_date) : null,
    requestsUsedToday: Number(row.requests_used_today || 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function aggregateOverallStatus(windows: CollectorWindowOutcome[]): RunStatus {
  if (windows.length === 0) return "succeeded";
  const hasSucceeded = windows.some((w) => w.status === "succeeded");
  const hasPartial = windows.some((w) => w.status === "partial");
  const hasFailed = windows.some((w) => w.status === "failed");
  const hasBlocked = windows.some((w) => w.status === "blocked");

  if (hasPartial) return "partial";
  if (hasSucceeded && (hasFailed || hasBlocked)) return "partial";
  if (hasSucceeded) return "succeeded";
  if (hasBlocked && !hasFailed) return "blocked";
  if (hasFailed) return "failed";
  return windows[windows.length - 1].status;
}

export class MeasurementCollectorScheduler {
  private readonly credentials: Record<string, CollectorCredentialEntry>;

  constructor(
    private readonly db: PodStorage,
    private readonly service: MeasurementService,
    private readonly opts: {
      collectorCredentialsRaw?: string;
      fetchImpl?: FetchLike;
      timeoutMs?: number;
      leaseMs?: number;
    } = {}
  ) {
    this.credentials = parseCollectorCredentials(opts.collectorCredentialsRaw);
  }

  public async upsertSchedule(raw: CollectorScheduleInput, now = Date.now()): Promise<CollectorScheduleRecord> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ValidationError("Schedule payload must be a JSON object");
    }
    const tenantId = typeof raw.tenantId === "string" ? raw.tenantId.trim() : "";
    const resourceId = typeof raw.resourceId === "string" ? raw.resourceId.trim() : "";
    const sourceResourceId = typeof raw.sourceResourceId === "string" ? raw.sourceResourceId.trim() : "";
    const credentialRef = typeof raw.credentialRef === "string" ? raw.credentialRef.trim() : "";
    if (!tenantId || !resourceId || !sourceResourceId || !credentialRef) {
      throw new ValidationError("tenantId, resourceId, sourceResourceId, and credentialRef are required");
    }
    if (!VALID_CONNECTORS.has(raw.connector)) {
      throw new ValidationError("connector must be 'gsc' or 'bing_webmaster'");
    }
    const resExists = await this.db
      .prepare("SELECT 1 FROM ms_resources WHERE tenant_id = ? AND resource_id = ?")
      .bind(tenantId, resourceId)
      .first<any>();
    if (!resExists) {
      throw new NotFoundError(`Resource '${resourceId}' is not registered for tenant '${tenantId}'`);
    }

    // Strict boolean validation (never coerce strings like "false" to true, and fail closed on new schedules!)
    if (raw.zeroSpendConfirmed !== undefined && typeof raw.zeroSpendConfirmed !== "boolean") {
      throw new ValidationError("zeroSpendConfirmed must be a boolean");
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
      throw new ValidationError("enabled must be a boolean");
    }

    // Unconditional registration-time full-tuple validation against authoritative server-side COLLECTOR_CREDENTIALS:
    // rejects unconfigured credentialRefs, connector mismatches, tenant mismatches, and unauthorized provider properties.
    const credCheck = resolveCollectorCredential(this.credentials, {
      credentialRef,
      connector: raw.connector,
      tenantId,
      resourceId,
      sourceResourceId,
    });
    if (!credCheck.ok) {
      throw new ForbiddenError(credCheck.reason);
    }

    const cadenceSec = raw.cadenceSec ?? 86400;
    if (!Number.isInteger(cadenceSec) || cadenceSec < 300 || cadenceSec > 30 * 86400) {
      throw new ValidationError("cadenceSec must be an integer in [300, 2592000]");
    }
    const expectedLagSec = raw.expectedLagSec ?? (raw.connector === "gsc" ? 3 * 86400 : 2 * 86400);
    if (!Number.isInteger(expectedLagSec) || expectedLagSec < 0 || expectedLagSec > 30 * 86400) {
      throw new ValidationError("expectedLagSec must be an integer in [0, 2592000]");
    }
    const dailyRequestBudget = raw.dailyRequestBudget ?? 100;
    if (!Number.isInteger(dailyRequestBudget) || dailyRequestBudget < 1 || dailyRequestBudget > 10000) {
      throw new ValidationError("dailyRequestBudget must be an integer in [1, 10000]");
    }
    const maxRowsPerWindow = raw.maxRowsPerWindow ?? 25000;
    if (!Number.isInteger(maxRowsPerWindow) || maxRowsPerWindow < 1 || maxRowsPerWindow > 25000) {
      throw new ValidationError("maxRowsPerWindow must be an integer in [1, 25000]");
    }
    const maxRetries = raw.maxRetries ?? 3;
    if (!Number.isInteger(maxRetries) || maxRetries < 1 || maxRetries > 10) {
      throw new ValidationError("maxRetries must be an integer in [1, 10]");
    }
    const dimensions = Array.isArray(raw.dimensions)
      ? raw.dimensions.map((d) => String(d).trim()).filter(Boolean)
      : raw.connector === "gsc"
        ? ["date", "page", "query", "country", "device"]
        : ["date", "query", "page"];
    const searchType = typeof raw.searchType === "string" && raw.searchType.trim() ? raw.searchType.trim() : "web";
    const cursorDate = raw.cursorDate !== undefined && raw.cursorDate !== null ? requireIsoDate(raw.cursorDate, "cursorDate") : null;

    const existing = await this.db
      .prepare("SELECT * FROM ms_collector_schedules WHERE tenant_id = ? AND resource_id = ? AND connector = ?")
      .bind(tenantId, resourceId, raw.connector)
      .first<any>();

    // Fail-closed default: new schedules require explicit zeroSpendConfirmed: true; updates preserve existing value when omitted.
    const zeroSpendConfirmed =
      raw.zeroSpendConfirmed !== undefined
        ? raw.zeroSpendConfirmed
        : existing
          ? Number(existing.zero_spend_confirmed) === 1
          : false;
    const enabled =
      raw.enabled !== undefined
        ? raw.enabled
        : existing
          ? Number(existing.enabled) === 1
          : true;

    const scheduleId =
      existing?.schedule_id ||
      (typeof raw.scheduleId === "string" && raw.scheduleId.trim()
        ? raw.scheduleId.trim()
        : `sched_${(await sha256Hex(`${tenantId}|${resourceId}|${raw.connector}`)).slice(0, 24)}`);

    if (existing) {
      const shouldResetBlock =
        (String(existing.last_status) === "blocked" && zeroSpendConfirmed) ||
        (Boolean(existing.pending_window_date) && dailyRequestBudget > Number(existing.daily_request_budget));
      await this.db
        .prepare(
          `UPDATE ms_collector_schedules
           SET source_resource_id = ?,
               credential_ref = ?,
               cadence_sec = ?,
               expected_lag_sec = ?,
               daily_request_budget = ?,
               max_rows_per_window = ?,
               dimensions_json = ?,
               search_type = ?,
               zero_spend_confirmed = ?,
               enabled = ?,
               cursor_date = COALESCE(?, cursor_date),
               max_retries = ?,
               consecutive_failures = CASE WHEN ? = 1 THEN 0 ELSE consecutive_failures END,
               cooldown_until = CASE WHEN ? = 1 THEN NULL ELSE cooldown_until END,
               next_run_at = CASE WHEN ? = 1 THEN ? ELSE next_run_at END,
               last_status = CASE WHEN ? = 1 AND last_status = 'blocked' THEN 'planned' ELSE last_status END,
               last_error_class = CASE WHEN ? = 1 AND last_status = 'blocked' THEN NULL ELSE last_error_class END,
               last_error_message = CASE WHEN ? = 1 AND last_status = 'blocked' THEN NULL ELSE last_error_message END,
               updated_at = ?
           WHERE schedule_id = ?`
        )
        .bind(
          sourceResourceId,
          credentialRef,
          cadenceSec,
          expectedLagSec,
          dailyRequestBudget,
          maxRowsPerWindow,
          JSON.stringify(dimensions),
          searchType,
          zeroSpendConfirmed ? 1 : 0,
          enabled ? 1 : 0,
          cursorDate,
          maxRetries,
          shouldResetBlock ? 1 : 0,
          shouldResetBlock ? 1 : 0,
          shouldResetBlock ? 1 : 0,
          now,
          shouldResetBlock ? 1 : 0,
          shouldResetBlock ? 1 : 0,
          shouldResetBlock ? 1 : 0,
          now,
          scheduleId
        )
        .run();
    } else {
      await this.db
        .prepare(
          `INSERT INTO ms_collector_schedules (
             schedule_id, tenant_id, resource_id, connector, source_resource_id, credential_ref,
             cadence_sec, expected_lag_sec, daily_request_budget, max_rows_per_window,
             dimensions_json, search_type, zero_spend_confirmed, enabled, cursor_date,
             next_run_at, max_retries, last_status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`
        )
        .bind(
          scheduleId,
          tenantId,
          resourceId,
          raw.connector,
          sourceResourceId,
          credentialRef,
          cadenceSec,
          expectedLagSec,
          dailyRequestBudget,
          maxRowsPerWindow,
          JSON.stringify(dimensions),
          searchType,
          zeroSpendConfirmed ? 1 : 0,
          enabled ? 1 : 0,
          cursorDate,
          now,
          maxRetries,
          now,
          now
        )
        .run();
    }

    const updated = await this.db
      .prepare("SELECT * FROM ms_collector_schedules WHERE schedule_id = ?")
      .bind(scheduleId)
      .first<any>();
    return mapScheduleRow(updated);
  }

  public async getScheduleById(tenantId: string, scheduleId: string): Promise<CollectorScheduleRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM ms_collector_schedules WHERE tenant_id = ? AND schedule_id = ?")
      .bind(tenantId, scheduleId)
      .first<any>();
    return row ? mapScheduleRow(row) : null;
  }

  public async getCollectorStatus(
    params: {
      tenantId: string;
      resourceId?: string;
      connector?: CollectorConnector;
      allowedResourceFilter?: (resourceId: string) => boolean;
    },
    now = Date.now()
  ): Promise<CollectorStatusItem[]> {
    const clauses = ["tenant_id = ?"];
    const binds: any[] = [params.tenantId];
    if (params.resourceId) {
      clauses.push("resource_id = ?");
      binds.push(params.resourceId);
    }
    if (params.connector) {
      clauses.push("connector = ?");
      binds.push(params.connector);
    }
    const res = await this.db
      .prepare(`SELECT * FROM ms_collector_schedules WHERE ${clauses.join(" AND ")} ORDER BY resource_id ASC, connector ASC`)
      .bind(...binds)
      .all<any>();

    const todayUtc = utcDateString(now);
    const items: CollectorStatusItem[] = [];
    for (const row of res.results || []) {
      const rec = mapScheduleRow(row);
      if (params.allowedResourceFilter && !params.allowedResourceFilter(rec.resourceId)) {
        continue;
      }
      const credEntry = this.credentials[rec.credentialRef];
      const credCheck = resolveCollectorCredential(this.credentials, {
        credentialRef: rec.credentialRef,
        connector: rec.connector,
        tenantId: rec.tenantId,
        resourceId: rec.resourceId,
        sourceResourceId: rec.sourceResourceId,
      });
      const latestEligibleDate = utcDateString(now - rec.expectedLagSec * 1000);
      let backlogDays =
        rec.cursorDate === null
          ? 1
          : Math.max(0, diffUtcDays(rec.cursorDate, latestEligibleDate));
      if (rec.pendingWindowDate && (rec.cursorDate === null || rec.pendingWindowDate > rec.cursorDate)) {
        backlogDays = Math.max(backlogDays, 1);
      }
      const ageSec = rec.lastSuccessAt !== null ? Math.max(0, Math.floor((now - rec.lastSuccessAt) / 1000)) : null;

      let freshnessState: CollectorFreshnessState;
      if (!rec.enabled) {
        freshnessState = "disabled";
      } else if (rec.lastStatus === "blocked" || !rec.zeroSpendConfirmed || !credCheck.ok) {
        freshnessState = "blocked";
      } else if (rec.lastStatus === "failed" && rec.consecutiveFailures > 0) {
        freshnessState = "failing";
      } else if (rec.lastSuccessAt === null) {
        freshnessState = "never_collected";
      } else if (ageSec !== null && ageSec > rec.cadenceSec * 2) {
        freshnessState = "stale";
      } else {
        freshnessState = "fresh";
      }

      const requestsUsedToday = rec.requestsUsedDate === todayUtc ? rec.requestsUsedToday : 0;
      items.push({
        ...rec,
        requestsUsedToday,
        credentialConfigured: Boolean(credEntry),
        credentialScopeAuthorized: credCheck.ok,
        freshnessState,
        ageSec,
        latestEligibleDate,
        backlogDays,
      });
    }
    return items;
  }

  private async ensureConnectorDefinitions(tenantId: string, connector: CollectorConnector, now: number): Promise<void> {
    const defs = connector === "gsc" ? gscMetricDefinitions(tenantId) : bingMetricDefinitions(tenantId);
    for (const def of defs) {
      await this.service.defineMetric(def, now);
    }
  }

  /**
   * Verify and renew the active schedule execution lease before persistence or mutations,
   * evaluating expiry at SQLite transaction execution time.
   */
  private async assertAndRenewLease(
    scheduleId: string,
    leaseOwner: string,
    nowTs: number,
    leaseMs: number,
    clockOffsetMs = 0
  ): Promise<void> {
    const res = await this.db
      .prepare(
        `UPDATE ms_collector_schedules
         SET lease_expires_at = ${SQL_TX_NOW_MS_EXPR} + ?,
             updated_at = ${SQL_TX_NOW_MS_EXPR}
         WHERE schedule_id = ?
           AND lease_owner = ?
           AND lease_expires_at > ${SQL_TX_NOW_MS_EXPR}`
      )
      .bind(nowTs, clockOffsetMs, leaseMs, nowTs, clockOffsetMs, scheduleId, leaseOwner, nowTs, clockOffsetMs)
      .run();
    if (Number((res as any)?.meta?.changes ?? 0) !== 1) {
      throw new ScheduleLeaseLostError();
    }
  }

  /**
   * Fail-closed read-only check before OAuth minting: verifies lease ownership + remaining daily quota
   * without consuming a quota slot prematurely (the actual slot is reserved right before query dispatch).
   */
  private async canReserveDailyRequestSlot(
    scheduleId: string,
    leaseOwner: string,
    nowTs: number,
    clockOffsetMs = 0
  ): Promise<boolean> {
    const effectiveNow = Math.max(nowTs, Date.now() + clockOffsetMs);
    const todayUtc = utcDateString(effectiveNow);
    const row = await this.db
      .prepare(
        `SELECT lease_owner, lease_expires_at, daily_request_budget, requests_used_date, requests_used_today
         FROM ms_collector_schedules
         WHERE schedule_id = ?`
      )
      .bind(scheduleId)
      .first<any>();
    if (!row || String(row.lease_owner || "") !== leaseOwner || Number(row.lease_expires_at || 0) <= effectiveNow) {
      throw new ScheduleLeaseLostError();
    }
    const usedDate = row.requests_used_date ? String(row.requests_used_date) : null;
    if (usedDate === null || usedDate < todayUtc) {
      return true;
    }
    if (usedDate === todayUtc) {
      return Number(row.requests_used_today || 0) < Number(row.daily_request_budget || 0);
    }
    return false;
  }

  /**
   * Atomically reserve 1 daily request slot in SQLite/D1 BEFORE any outbound provider HTTP request,
   * while verifying and renewing the active lease at SQLite transaction execution time AND evaluating
   * the current UTC date dynamically (so executions crossing UTC midnight never overspend the new day's budget!).
   */
  private async reserveDailyRequestSlot(
    scheduleId: string,
    leaseOwner: string,
    nowTs: number,
    leaseMs: number,
    clockOffsetMs = 0
  ): Promise<boolean> {
    const reserveDateUtc = utcDateString(Math.max(nowTs, Date.now() + clockOffsetMs));
    const res = await this.db
      .prepare(
        `UPDATE ms_collector_schedules
         SET requests_used_today = CASE WHEN requests_used_date = ? THEN requests_used_today + 1 ELSE 1 END,
             requests_used_date = ?,
             lease_expires_at = ${SQL_TX_NOW_MS_EXPR} + ?,
             updated_at = ${SQL_TX_NOW_MS_EXPR}
         WHERE schedule_id = ?
           AND lease_owner = ?
           AND lease_expires_at > ${SQL_TX_NOW_MS_EXPR}
           AND (
             requests_used_date IS NULL
             OR requests_used_date < ?
             OR (requests_used_date = ? AND requests_used_today < daily_request_budget)
           )`
      )
      .bind(
        reserveDateUtc,
        reserveDateUtc,
        nowTs,
        clockOffsetMs,
        leaseMs,
        nowTs,
        clockOffsetMs,
        scheduleId,
        leaseOwner,
        nowTs,
        clockOffsetMs,
        reserveDateUtc,
        reserveDateUtc
      )
      .run();

    if (Number((res as any)?.meta?.changes ?? 0) === 1) {
      return true;
    }

    // Distinguish lease loss/expiry from genuine daily quota exhaustion
    const effectiveCheckNow = Math.max(nowTs, Date.now() + clockOffsetMs);
    const row = await this.db
      .prepare("SELECT lease_owner, lease_expires_at FROM ms_collector_schedules WHERE schedule_id = ?")
      .bind(scheduleId)
      .first<any>();
    if (!row || String(row.lease_owner || "") !== leaseOwner || Number(row.lease_expires_at || 0) <= effectiveCheckNow) {
      throw new ScheduleLeaseLostError();
    }
    return false;
  }

  /**
   * Resolve exact replay vs incremented sourceRevision for each observation in a collected day window.
   * - Exact same evidence_id -> reuse stored sourceRevision & idempotencyKey (service verifies payloadDigest -> replayedNoop).
   * - New evidence on previously recorded logical key (e.g., partial-to-complete breakdown or provider correction) -> maxRev + 1.
   * - Brand new logical key -> sourceRevision = 1.
   */
  private async assignObservationRevisions(
    tenantId: string,
    resourceId: string,
    source: string,
    day: string,
    evidenceId: string,
    observations: ObservationInput[]
  ): Promise<ObservationInput[]> {
    if (observations.length === 0) return observations;

    const existingRes = await this.db
      .prepare(
        `SELECT metric_id, definition_version, dimensions_hash, source_revision, idempotency_key, evidence_id
         FROM ms_observations
         WHERE tenant_id = ? AND resource_id = ? AND source = ? AND window_start = ? AND window_end = ?
         ORDER BY source_revision DESC`
      )
      .bind(tenantId, resourceId, source, day, day)
      .all<any>();

    const maxRevByLogical = new Map<string, number>();
    const byLogicalAndEvidence = new Map<string, { sourceRevision: number; idempotencyKey: string }>();
    for (const row of existingRes.results || []) {
      const logicalKey = `${row.metric_id}|${row.definition_version}|${row.dimensions_hash}`;
      const rev = Number(row.source_revision || 1);
      const prevMax = maxRevByLogical.get(logicalKey) ?? 0;
      if (rev > prevMax) maxRevByLogical.set(logicalKey, rev);

      const evKey = `${logicalKey}|${row.evidence_id}`;
      if (!byLogicalAndEvidence.has(evKey)) {
        byLogicalAndEvidence.set(evKey, {
          sourceRevision: rev,
          idempotencyKey: String(row.idempotency_key),
        });
      }
    }

    const out: ObservationInput[] = [];
    for (const obs of observations) {
      const dimsHash = await sha256Hex(canonicalJson(obs.dimensions || {}));
      const logicalKey = `${obs.metricId}|${obs.definitionVersion}|${dimsHash}`;
      const exactMatch = byLogicalAndEvidence.get(`${logicalKey}|${evidenceId}`);
      if (exactMatch) {
        out.push({
          ...obs,
          sourceRevision: exactMatch.sourceRevision,
          idempotencyKey: exactMatch.idempotencyKey,
        });
      } else {
        const prevMax = maxRevByLogical.get(logicalKey) ?? 0;
        const nextRev = prevMax + 1;
        out.push({
          ...obs,
          sourceRevision: nextRev,
          idempotencyKey: `${obs.idempotencyKey}:r${nextRev}`,
        });
      }
    }
    return out;
  }

  private async recordBlockedOrFailedCoverage(
    schedule: CollectorScheduleRecord,
    leaseOwner: string,
    leaseMs: number,
    windowStart: string,
    windowEnd: string,
    requestedStatus: "blocked" | "failed",
    errorClass: string,
    errorMessage: string,
    retryable: boolean,
    getNow: () => number,
    getClockOffsetMs: () => number
  ): Promise<{
    effectiveStatus: "blocked" | "failed";
    effectiveErrorClass: string;
    cooldownUntil: number | null;
    consecutiveFailures: number;
  }> {
    const source = schedule.connector === "gsc" ? GSC_SOURCE : BING_SOURCE;
    const nextFailures = schedule.consecutiveFailures + 1;

    let effectiveStatus: "blocked" | "failed" = requestedStatus;
    let effectiveErrorClass = errorClass;

    if (!retryable || requestedStatus === "blocked") {
      effectiveStatus = "blocked";
    } else if (nextFailures > schedule.maxRetries) {
      effectiveStatus = "blocked";
      effectiveErrorClass = "retry_limit_exhausted";
    } else {
      effectiveStatus = "failed";
    }

    const safeMsg = redactCollectorSecrets(errorMessage);
    const runHash = (
      await sha256Hex(`${schedule.tenantId}|${schedule.resourceId}|${source}|${windowStart}|${windowEnd}|err`)
    ).slice(0, 32);
    const runId = `run_${schedule.connector}_${runHash}`;
    const runIdem = `collector:${schedule.connector}:${runHash}`;
    const reqDigest = await sha256Hex(
      canonicalJson({
        tenantId: schedule.tenantId,
        resourceId: schedule.resourceId,
        source,
        sourceResourceId: schedule.sourceResourceId,
        scheduleId: null,
        windowStart,
        windowEnd,
      })
    );
    const attemptId = `att_${crypto.randomUUID()}`;

    // Re-sample clock AFTER all awaited hashes, right before constructing the SQLite transaction!
    const txNow = getNow();
    const txClockOffset = getClockOffsetMs();
    let cooldownUntil: number | null = null;
    let nextRunAt: number;
    if (effectiveStatus === "blocked") {
      if (effectiveErrorClass === "quota_exceeded") {
        nextRunAt = nextUtcMidnightMs(txNow);
        cooldownUntil = nextRunAt;
      } else {
        cooldownUntil = null;
        nextRunAt = txNow + schedule.cadenceSec * 1000;
      }
    } else {
      const cooldownSec = Math.min(schedule.cadenceSec, BASE_RETRY_COOLDOWN_SEC * Math.pow(2, Math.max(0, nextFailures - 1)));
      cooldownUntil = txNow + cooldownSec * 1000;
      nextRunAt = cooldownUntil;
    }

    const initialRetryCount = effectiveStatus === "failed" ? 1 : 0;
    const freshnessAt = new Date(txNow).toISOString();
    const fallbackUrn = `site:${schedule.tenantId}:${schedule.resourceId}`;

    // Commit lease fence (evaluated at SQLite tx execution time) + ms_runs (preserving retry_count)
    // + ms_attempts + ms_events ('run.updated') + ms_coverage + ms_collector_schedules in ONE SINGLE atomic db.batch().
    try {
      await this.db.batch([
        buildCollectorLeaseFenceStatement(this.db, schedule.scheduleId, leaseOwner, txNow, txClockOffset),
        this.db
          .prepare(
            `INSERT INTO ms_runs (
               run_id, tenant_id, resource_id, source, source_resource_id, schedule_id,
               idempotency_key, request_digest, window_start, window_end, cursor,
               status, retry_count, max_retries, error_class, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(tenant_id, idempotency_key) DO UPDATE SET
               status = excluded.status,
               retry_count = CASE
                 WHEN excluded.status IN ('failed', 'partial') THEN ms_runs.retry_count + 1
                 ELSE ms_runs.retry_count
               END,
               error_class = excluded.error_class,
               updated_at = excluded.updated_at`
          )
          .bind(
            runId,
            schedule.tenantId,
            schedule.resourceId,
            source,
            schedule.sourceResourceId,
            runIdem,
            reqDigest,
            windowStart,
            windowEnd,
            effectiveStatus,
            initialRetryCount,
            schedule.maxRetries,
            effectiveErrorClass,
            txNow,
            txNow
          ),
        this.db
          .prepare(
            `INSERT INTO ms_attempts (
               attempt_id, run_id, tenant_id, attempt_number, status, cursor, error_class, started_at, finished_at
             ) VALUES (
               ?,
               (SELECT run_id FROM ms_runs WHERE tenant_id = ? AND idempotency_key = ?),
               ?,
               COALESCE((SELECT MAX(attempt_number) FROM ms_attempts WHERE run_id = (SELECT run_id FROM ms_runs WHERE tenant_id = ? AND idempotency_key = ?)), 0) + 1,
               ?,
               NULL,
               ?,
               ?,
               ?
             )`
          )
          .bind(
            attemptId,
            schedule.tenantId,
            runIdem,
            schedule.tenantId,
            schedule.tenantId,
            runIdem,
            effectiveStatus,
            effectiveErrorClass,
            txNow,
            txNow
          ),
        this.db
          .prepare(
            `INSERT INTO ms_events (tenant_id, resource_id, entity_urn, event_type, payload_json, created_at)
             VALUES (
               ?,
               ?,
               COALESCE((SELECT entity_urn FROM ms_resources WHERE tenant_id = ? AND resource_id = ?), ?),
               'run.updated',
               json_object(
                 'runId', (SELECT run_id FROM ms_runs WHERE tenant_id = ? AND idempotency_key = ?),
                 'attemptId', ?,
                 'attemptNumber', (SELECT attempt_number FROM ms_attempts WHERE attempt_id = ?),
                 'source', ?,
                 'status', ?,
                 'cursor', NULL,
                 'errorClass', ?
               ),
               ?
             )`
          )
          .bind(
            schedule.tenantId,
            schedule.resourceId,
            schedule.tenantId,
            schedule.resourceId,
            fallbackUrn,
            schedule.tenantId,
            runIdem,
            attemptId,
            attemptId,
            source,
            effectiveStatus,
            effectiveErrorClass,
            txNow
          ),
        this.db
          .prepare(
            `INSERT INTO ms_coverage (
               tenant_id, resource_id, source, window_start, window_end, status,
               expected_cadence_sec, expected_lag_sec, reconciliation_status, last_run_id, freshness_at, updated_at
             ) VALUES (
               ?, ?, ?, ?, ?, ?, ?, ?, 'unknown',
               (SELECT run_id FROM ms_runs WHERE tenant_id = ? AND idempotency_key = ?),
               ?, ?
             )
             ON CONFLICT (tenant_id, resource_id, source, window_start, window_end) DO UPDATE SET
               status = excluded.status,
               expected_cadence_sec = excluded.expected_cadence_sec,
               expected_lag_sec = excluded.expected_lag_sec,
               last_run_id = excluded.last_run_id,
               freshness_at = excluded.freshness_at,
               updated_at = excluded.updated_at`
          )
          .bind(
            schedule.tenantId,
            schedule.resourceId,
            source,
            windowStart,
            windowEnd,
            effectiveStatus,
            schedule.cadenceSec,
            schedule.expectedLagSec,
            schedule.tenantId,
            runIdem,
            freshnessAt,
            txNow
          ),
        this.db
          .prepare(
            `UPDATE ms_collector_schedules
             SET last_attempt_at = ?,
                 consecutive_failures = ?,
                 cooldown_until = ?,
                 next_run_at = ?,
                 last_status = ?,
                 last_error_class = ?,
                 last_error_message = ?,
                 lease_expires_at = ${SQL_TX_NOW_MS_EXPR} + ?,
                 updated_at = CASE
                   WHEN lease_owner = ? AND lease_expires_at > ${SQL_TX_NOW_MS_EXPR}
                   THEN ${SQL_TX_NOW_MS_EXPR}
                   ELSE NULL
                 END
             WHERE schedule_id = ?`
          )
          .bind(
            txNow,
            nextFailures,
            cooldownUntil,
            nextRunAt,
            effectiveStatus,
            effectiveErrorClass,
            safeMsg,
            txNow,
            txClockOffset,
            leaseMs,
            leaseOwner,
            txNow,
            txClockOffset,
            txNow,
            txClockOffset,
            schedule.scheduleId
          ),
        // Closing fence catches row deletion or any intra-transaction lease loss
        buildCollectorLeaseFenceStatement(this.db, schedule.scheduleId, leaseOwner, txNow, txClockOffset),
      ]);
    } catch (err: any) {
      const msg = String(err?.message || err || "");
      if (
        msg.includes("NOT NULL constraint failed") &&
        (msg.includes("ms_schema_migrations.applied_at") || msg.includes("ms_collector_schedules.updated_at"))
      ) {
        throw new ScheduleLeaseLostError();
      }
      const fbNow = getNow();
      const fbOffset = getClockOffsetMs();
      const effectiveCheckNow = Math.max(fbNow, Date.now() + fbOffset);
      const leaseRow = await this.db
        .prepare("SELECT lease_owner, lease_expires_at FROM ms_collector_schedules WHERE schedule_id = ?")
        .bind(schedule.scheduleId)
        .first<any>();
      if (!leaseRow || String(leaseRow.lease_owner || "") !== leaseOwner || Number(leaseRow.lease_expires_at || 0) <= effectiveCheckNow) {
        throw new ScheduleLeaseLostError();
      }
      // Fallback: persist schedule cooldown/status fenced by SQLite transaction-time lease expiry
      const schedUpd = await this.db
        .prepare(
          `UPDATE ms_collector_schedules
           SET last_attempt_at = ?,
               consecutive_failures = ?,
               cooldown_until = ?,
               next_run_at = ?,
               last_status = ?,
               last_error_class = ?,
               last_error_message = ?,
               lease_expires_at = ${SQL_TX_NOW_MS_EXPR} + ?,
               updated_at = ${SQL_TX_NOW_MS_EXPR}
           WHERE schedule_id = ?
             AND lease_owner = ?
             AND lease_expires_at > ${SQL_TX_NOW_MS_EXPR}`
        )
        .bind(
          fbNow,
          nextFailures,
          cooldownUntil,
          nextRunAt,
          effectiveStatus,
          effectiveErrorClass,
          safeMsg,
          fbNow,
          fbOffset,
          leaseMs,
          fbNow,
          fbOffset,
          schedule.scheduleId,
          leaseOwner,
          fbNow,
          fbOffset
        )
        .run();
      if (Number((schedUpd as any)?.meta?.changes ?? 0) !== 1) {
        throw new ScheduleLeaseLostError();
      }
    }

    return { effectiveStatus, effectiveErrorClass, cooldownUntil, consecutiveFailures: nextFailures };
  }

  public async executeSchedule(
    initialSchedule: CollectorScheduleRecord,
    opts: {
      windowStart?: string;
      windowEnd?: string;
      maxWindows?: number;
      force?: boolean;
      now?: number;
      nowFn?: () => number;
      leaseMs?: number;
    } = {}
  ): Promise<CollectorRunOutcome> {
    const getNow = () => (opts.nowFn ? opts.nowFn() : opts.now !== undefined ? opts.now : Date.now());
    const leaseMs = opts.leaseMs ?? this.opts.leaseMs ?? SCHEDULE_LEASE_MS;
    const startNow = getNow();
    const startWallNow = Date.now();
    const fixedClockOffsetMs = opts.now !== undefined && !opts.nowFn ? opts.now - startWallNow : 0;
    // Maps SQLite's live julianday('now') into the execution clock domain so real wall-clock delays
    // inside SQLite transactions ALWAYS expire leases accurately (both for live Date.now() and synthetic clocks!).
    const getClockOffsetMs = () => {
      if (opts.nowFn) return opts.nowFn() - Date.now();
      if (opts.now !== undefined) return fixedClockOffsetMs;
      return 0;
    };
    const startTodayUtc = utcDateString(startNow);

    // Validate caller-supplied explicit window parameters BEFORE acquiring lease or isolating errors
    let explicitDates: string[] | null = null;
    if (opts.windowStart || opts.windowEnd) {
      const start = requireIsoDate(opts.windowStart || opts.windowEnd, "windowStart");
      const end = requireIsoDate(opts.windowEnd || opts.windowStart, "windowEnd");
      if (start > end) {
        throw new ValidationError("windowStart cannot be after windowEnd");
      }
      const totalDays = diffUtcDays(start, end) + 1;
      const limit = Math.min(Math.max(opts.maxWindows ?? MAX_BACKFILL_WINDOWS_PER_CALL, 1), MAX_BACKFILL_WINDOWS_PER_CALL);
      if (totalDays > limit) {
        throw new ValidationError(`Backfill window spans ${totalDays} days, exceeding maxWindows (${limit})`);
      }
      explicitDates = [];
      for (let d = 0; d < totalDays; d++) {
        explicitDates.push(addUtcDays(start, d));
      }
    }

    // Acquire exclusive execution lease atomically using SQLite transaction-time clock
    const leaseOwner = crypto.randomUUID();
    let leaseAcquired = false;
    try {
      const acquireOffset = getClockOffsetMs();
      const leaseRes = await this.db
        .prepare(
          `UPDATE ms_collector_schedules
           SET lease_owner = ?,
               lease_expires_at = ${SQL_TX_NOW_MS_EXPR} + ?,
               updated_at = ${SQL_TX_NOW_MS_EXPR}
           WHERE schedule_id = ?
             AND (
               lease_owner IS NULL
               OR lease_expires_at IS NULL
               OR lease_expires_at <= ${SQL_TX_NOW_MS_EXPR}
             )`
        )
        .bind(
          leaseOwner,
          startNow,
          acquireOffset,
          leaseMs,
          startNow,
          acquireOffset,
          initialSchedule.scheduleId,
          startNow,
          acquireOffset
        )
        .run();

      if (Number((leaseRes as any)?.meta?.changes ?? 0) !== 1) {
        return {
          scheduleId: initialSchedule.scheduleId,
          tenantId: initialSchedule.tenantId,
          resourceId: initialSchedule.resourceId,
          connector: initialSchedule.connector,
          status: "running",
          windowsProcessed: 0,
          inserted: 0,
          replayedNoop: 0,
          requestsUsed: 0,
          cursorDate: initialSchedule.cursorDate,
          cooldownUntil: initialSchedule.cooldownUntil,
          errorClass: "schedule_locked",
          errorMessage: "Schedule is already executing under another lease",
          windows: [],
        };
      }
      leaseAcquired = true;
    } catch (err: any) {
      const safeMsg = redactCollectorSecrets(err?.message || "Failed to acquire schedule execution lease");
      return {
        scheduleId: initialSchedule.scheduleId,
        tenantId: initialSchedule.tenantId,
        resourceId: initialSchedule.resourceId,
        connector: initialSchedule.connector,
        status: "failed",
        windowsProcessed: 0,
        inserted: 0,
        replayedNoop: 0,
        requestsUsed: 0,
        cursorDate: initialSchedule.cursorDate,
        cooldownUntil: null,
        errorClass: "collector_lease_error",
        errorMessage: safeMsg,
        windows: [],
      };
    }

    // Hoist execution accumulators & current window state ABOVE try/catch so any later-window exception
    // preserves already-committed windows, totals, and records failure against the actual failing day!
    let schedule = initialSchedule;
    let cursorDate = initialSchedule.cursorDate;
    let consecutiveFailures = initialSchedule.consecutiveFailures;
    let totalRequestsThisCall = 0;
    let totalInserted = 0;
    let totalReplayed = 0;
    let finalErrorClass: string | null = null;
    let finalErrorMessage: string | null = null;
    let cooldownUntil: number | null = null;
    let currentDay: string = explicitDates?.[0] || utcDateString(startNow - initialSchedule.expectedLagSec * 1000);
    const windows: CollectorWindowOutcome[] = [];

    try {
      // Reload fresh schedule state AFTER acquiring the lease (never operate on stale snapshots!)
      const freshRow = await this.db
        .prepare("SELECT * FROM ms_collector_schedules WHERE schedule_id = ?")
        .bind(initialSchedule.scheduleId)
        .first<any>();
      if (!freshRow) {
        throw new NotFoundError(`Schedule '${initialSchedule.scheduleId}' no longer exists`);
      }
      schedule = mapScheduleRow(freshRow);
      cursorDate = schedule.cursorDate;
      consecutiveFailures = schedule.consecutiveFailures;
      const latestEligibleDate = utcDateString(startNow - schedule.expectedLagSec * 1000);
      currentDay = explicitDates?.[0] || latestEligibleDate;

      // Durable blocked gate: non-forced runs never auto-execute permanently blocked schedules
      if (!opts.force && schedule.lastStatus === "blocked") {
        const isQuotaReset =
          schedule.lastErrorClass === "quota_exceeded" &&
          (schedule.requestsUsedDate === null || schedule.requestsUsedDate < startTodayUtc);
        if (!isQuotaReset) {
          return {
            scheduleId: schedule.scheduleId,
            tenantId: schedule.tenantId,
            resourceId: schedule.resourceId,
            connector: schedule.connector,
            status: "blocked",
            windowsProcessed: 0,
            inserted: 0,
            replayedNoop: 0,
            requestsUsed: 0,
            cursorDate: schedule.cursorDate,
            cooldownUntil: schedule.cooldownUntil,
            errorClass: schedule.lastErrorClass,
            errorMessage: schedule.lastErrorMessage || "Schedule is blocked pending explicit recovery",
            windows: [],
          };
        }
      }

      // Determine target daily windows
      const targetDates: string[] = [];
      if (explicitDates) {
        targetDates.push(...explicitDates);
      } else {
        if (!opts.force && schedule.cooldownUntil !== null && startNow < schedule.cooldownUntil) {
          return {
            scheduleId: schedule.scheduleId,
            tenantId: schedule.tenantId,
            resourceId: schedule.resourceId,
            connector: schedule.connector,
            status: schedule.lastStatus,
            windowsProcessed: 0,
            inserted: 0,
            replayedNoop: 0,
            requestsUsed: 0,
            cursorDate: schedule.cursorDate,
            cooldownUntil: schedule.cooldownUntil,
            errorClass: schedule.lastErrorClass,
            errorMessage: "Schedule is in retry cooldown",
            windows: [],
          };
        }
        const maxWin = Math.min(Math.max(opts.maxWindows ?? 7, 1), MAX_BACKFILL_WINDOWS_PER_CALL);

        // Resume any incomplete budget-limited window first!
        if (schedule.pendingWindowDate) {
          targetDates.push(schedule.pendingWindowDate);
        }

        if (schedule.cursorDate === null) {
          if (!targetDates.includes(latestEligibleDate) && targetDates.length < maxWin) {
            targetDates.push(latestEligibleDate);
          }
        } else if (schedule.cursorDate < latestEligibleDate) {
          let cur = addUtcDays(schedule.cursorDate, 1);
          while (cur <= latestEligibleDate && targetDates.length < maxWin) {
            if (!targetDates.includes(cur)) {
              targetDates.push(cur);
            }
            cur = addUtcDays(cur, 1);
          }
        } else if (targetDates.length === 0) {
          if (opts.force) {
            targetDates.push(latestEligibleDate);
          } else {
            const nowTs = getNow();
            const offsetMs = getClockOffsetMs();
            const upd = await this.db
              .prepare(
                `UPDATE ms_collector_schedules
                 SET next_run_at = ?, updated_at = ${SQL_TX_NOW_MS_EXPR}
                 WHERE schedule_id = ? AND lease_owner = ? AND lease_expires_at > ${SQL_TX_NOW_MS_EXPR}`
              )
              .bind(nowTs + schedule.cadenceSec * 1000, nowTs, offsetMs, schedule.scheduleId, leaseOwner, nowTs, offsetMs)
              .run();
            if (Number((upd as any)?.meta?.changes ?? 0) !== 1) {
              throw new ScheduleLeaseLostError();
            }
            return {
              scheduleId: schedule.scheduleId,
              tenantId: schedule.tenantId,
              resourceId: schedule.resourceId,
              connector: schedule.connector,
              status: "succeeded",
              windowsProcessed: 0,
              inserted: 0,
              replayedNoop: 0,
              requestsUsed: 0,
              cursorDate: schedule.cursorDate,
              cooldownUntil: null,
              errorClass: null,
              errorMessage: null,
              windows: [],
            };
          }
        }
      }

      currentDay = targetDates[0] || latestEligibleDate;

      // Gate 1: Zero-spend guard (must be explicitly confirmed; fail closed)
      if (!schedule.zeroSpendConfirmed) {
        const msg = "Zero-incremental-spend policy is not confirmed for this collector schedule";
        const recorded = await this.recordBlockedOrFailedCoverage(
          { ...schedule, cursorDate, consecutiveFailures },
          leaseOwner,
          leaseMs,
          currentDay,
          currentDay,
          "blocked",
          "zero_spend_unconfirmed",
          msg,
          false,
          getNow,
          getClockOffsetMs
        );
        return {
          scheduleId: schedule.scheduleId,
          tenantId: schedule.tenantId,
          resourceId: schedule.resourceId,
          connector: schedule.connector,
          status: recorded.effectiveStatus,
          windowsProcessed: 0,
          inserted: 0,
          replayedNoop: 0,
          requestsUsed: 0,
          cursorDate: schedule.cursorDate,
          cooldownUntil: recorded.cooldownUntil,
          errorClass: recorded.effectiveErrorClass,
          errorMessage: msg,
          windows: [
            {
              windowStart: currentDay,
              windowEnd: currentDay,
              status: recorded.effectiveStatus,
              inserted: 0,
              replayedNoop: 0,
              requestsUsed: 0,
              coverageStatus: "blocked",
              reconciliationStatus: "unknown",
              truncated: false,
              errorClass: recorded.effectiveErrorClass,
              errorMessage: msg,
            },
          ],
        };
      }

      // Gate 2: Authoritative server-side credential & (tenantId, resourceId, connector, sourceResourceId) validation
      const credRes = resolveCollectorCredential(this.credentials, {
        credentialRef: schedule.credentialRef,
        connector: schedule.connector,
        tenantId: schedule.tenantId,
        resourceId: schedule.resourceId,
        sourceResourceId: schedule.sourceResourceId,
      });
      if (!credRes.ok) {
        const recorded = await this.recordBlockedOrFailedCoverage(
          { ...schedule, cursorDate, consecutiveFailures },
          leaseOwner,
          leaseMs,
          currentDay,
          currentDay,
          "blocked",
          credRes.errorClass,
          credRes.reason,
          false,
          getNow,
          getClockOffsetMs
        );
        return {
          scheduleId: schedule.scheduleId,
          tenantId: schedule.tenantId,
          resourceId: schedule.resourceId,
          connector: schedule.connector,
          status: recorded.effectiveStatus,
          windowsProcessed: 0,
          inserted: 0,
          replayedNoop: 0,
          requestsUsed: 0,
          cursorDate: schedule.cursorDate,
          cooldownUntil: recorded.cooldownUntil,
          errorClass: recorded.effectiveErrorClass,
          errorMessage: credRes.reason,
          windows: [
            {
              windowStart: currentDay,
              windowEnd: currentDay,
              status: recorded.effectiveStatus,
              inserted: 0,
              replayedNoop: 0,
              requestsUsed: 0,
              coverageStatus: "blocked",
              reconciliationStatus: "unknown",
              truncated: false,
              errorClass: recorded.effectiveErrorClass,
              errorMessage: credRes.reason,
            },
          ],
        };
      }

      // Ensure connector metric definitions exist idempotently before ingesting
      await this.ensureConnectorDefinitions(schedule.tenantId, schedule.connector, getNow());

      // Dynamic UTC date + lease-fenced atomic reservation called right BEFORE every outbound provider HTTP request
      const canReserveRequest = () =>
        this.canReserveDailyRequestSlot(schedule.scheduleId, leaseOwner, getNow(), getClockOffsetMs());
      const reserveRequest = () =>
        this.reserveDailyRequestSlot(schedule.scheduleId, leaseOwner, getNow(), leaseMs, getClockOffsetMs());

      for (const day of targetDates) {
        currentDay = day;
        // Verify lease before beginning each window
        await this.assertAndRenewLease(schedule.scheduleId, leaseOwner, getNow(), leaseMs, getClockOffsetMs());

        const collected =
          schedule.connector === "gsc"
            ? await collectGscWindow({
                tenantId: schedule.tenantId,
                resourceId: schedule.resourceId,
                siteUrl: schedule.sourceResourceId,
                windowStart: day,
                windowEnd: day,
                dimensions: schedule.dimensions,
                searchType: schedule.searchType,
                maxRowsPerWindow: schedule.maxRowsPerWindow,
                canReserveRequest,
                reserveRequest,
                credential: credRes.credential as Extract<
                  CollectorCredentialEntry,
                  { kind: "gsc_service_account" | "gsc_oauth_refresh" }
                >,
                secretsToRedact: credRes.secretsToRedact,
                fetchImpl: this.opts.fetchImpl,
                now: getNow(),
                timeoutMs: this.opts.timeoutMs,
              })
            : await collectBingWindow({
                tenantId: schedule.tenantId,
                resourceId: schedule.resourceId,
                siteUrl: schedule.sourceResourceId,
                windowStart: day,
                windowEnd: day,
                dimensions: schedule.dimensions,
                maxRowsPerWindow: schedule.maxRowsPerWindow,
                reserveRequest,
                credential: credRes.credential as Extract<CollectorCredentialEntry, { kind: "bing_api_key" }>,
                secretsToRedact: credRes.secretsToRedact,
                fetchImpl: this.opts.fetchImpl,
                now: getNow(),
                timeoutMs: this.opts.timeoutMs,
              });

        totalRequestsThisCall += collected.requestsUsed;

        if (!collected.ok) {
          const recorded = await this.recordBlockedOrFailedCoverage(
            { ...schedule, cursorDate, consecutiveFailures },
            leaseOwner,
            leaseMs,
            day,
            day,
            collected.status,
            collected.errorClass,
            collected.errorMessage,
            collected.retryable,
            getNow,
            getClockOffsetMs
          );
          consecutiveFailures = recorded.consecutiveFailures;
          cooldownUntil = recorded.cooldownUntil;
          finalErrorClass = recorded.effectiveErrorClass;
          finalErrorMessage = redactCollectorSecrets(collected.errorMessage, credRes.secretsToRedact);
          windows.push({
            windowStart: day,
            windowEnd: day,
            status: recorded.effectiveStatus,
            inserted: 0,
            replayedNoop: 0,
            requestsUsed: collected.requestsUsed,
            coverageStatus: recorded.effectiveStatus as CoverageStatus,
            reconciliationStatus: "unknown",
            truncated: false,
            errorClass: recorded.effectiveErrorClass,
            errorMessage: finalErrorMessage,
          });
          break;
        }

        // Resolve exact replay vs incremented sourceRevision so partial-to-complete & provider revisions work cleanly
        const persistNow = getNow();
        const revisedObservations = await this.assignObservationRevisions(
          schedule.tenantId,
          schedule.resourceId,
          collected.source,
          day,
          collected.evidence.evidenceId,
          collected.observations
        );

        const runHash = (
          await sha256Hex(
            `${schedule.tenantId}|${schedule.resourceId}|${collected.source}|${day}|${day}|${collected.evidence.sha256}`
          )
        ).slice(0, 32);
        const runId = `run_${schedule.connector}_${runHash}`;
        const runIdem = `collector:${schedule.connector}:${runHash}`;
        const freshnessAt = new Date(persistNow).toISOString();
        const winStatus: RunStatus = collected.truncated ? "partial" : "succeeded";
        const budgetPartialMsg = "Window partially collected due to daily request budget; queued for resume";

        // Atomic lease fence (evaluated at SQLite tx execution time) + schedule state update committed INSIDE
        // the exact same db.batch() transaction as observations, runs, evidence, and coverage! Zero TOCTOU window.
        let committedBudgetResumeAt: number | null = null;
        const collectorLeaseFence: CollectorLeaseFence = {
          scheduleId: schedule.scheduleId,
          leaseOwner,
          getNow,
          getClockOffsetMs,
          buildPostCommitStatements: (txNow: number, txClockOffset: number) => {
            if (collected.budgetLimited) {
              const nextResumeAt = nextUtcMidnightMs(txNow);
              committedBudgetResumeAt = nextResumeAt;
              return [
                this.db
                  .prepare(
                    `UPDATE ms_collector_schedules
                     SET pending_window_date = ?,
                         last_attempt_at = ?,
                         consecutive_failures = 0,
                         cooldown_until = NULL,
                         next_run_at = ?,
                         last_status = 'partial',
                         last_error_class = 'quota_exceeded',
                         last_error_message = ?,
                         lease_expires_at = ${SQL_TX_NOW_MS_EXPR} + ?,
                         updated_at = CASE
                           WHEN lease_owner = ? AND lease_expires_at > ${SQL_TX_NOW_MS_EXPR}
                           THEN ${SQL_TX_NOW_MS_EXPR}
                           ELSE NULL
                         END
                     WHERE schedule_id = ?`
                  )
                  .bind(
                    day,
                    txNow,
                    nextResumeAt,
                    budgetPartialMsg,
                    txNow,
                    txClockOffset,
                    leaseMs,
                    leaseOwner,
                    txNow,
                    txClockOffset,
                    txNow,
                    txClockOffset,
                    schedule.scheduleId
                  ),
              ];
            }
            return [
              this.db
                .prepare(
                  `UPDATE ms_collector_schedules
                   SET cursor_date = CASE WHEN cursor_date IS NULL OR ? > cursor_date THEN ? ELSE cursor_date END,
                       pending_window_date = CASE WHEN pending_window_date = ? THEN NULL ELSE pending_window_date END,
                       last_attempt_at = ?,
                       last_success_at = CASE WHEN ? = 'succeeded' THEN ? ELSE last_success_at END,
                       consecutive_failures = 0,
                       cooldown_until = NULL,
                       next_run_at = ?,
                       last_status = ?,
                       last_error_class = NULL,
                       last_error_message = NULL,
                       lease_expires_at = ${SQL_TX_NOW_MS_EXPR} + ?,
                       updated_at = CASE
                         WHEN lease_owner = ? AND lease_expires_at > ${SQL_TX_NOW_MS_EXPR}
                         THEN ${SQL_TX_NOW_MS_EXPR}
                         ELSE NULL
                       END
                   WHERE schedule_id = ?`
                )
                .bind(
                  day,
                  day,
                  day,
                  txNow,
                  winStatus,
                  txNow,
                  txNow + schedule.cadenceSec * 1000,
                  winStatus,
                  txNow,
                  txClockOffset,
                  leaseMs,
                  leaseOwner,
                  txNow,
                  txClockOffset,
                  txNow,
                  txClockOffset,
                  schedule.scheduleId
                ),
            ];
          },
        };

        let winInserted = 0;
        let winReplayed = 0;

        if (revisedObservations.length <= MAX_ATOMIC_OBS) {
          const group: AtomicIngestGroupInput = {
            resourceId: schedule.resourceId,
            source: collected.source,
            runId,
            runIdempotencyKey: runIdem,
            sourceResourceId: schedule.sourceResourceId,
            windowStart: day,
            windowEnd: day,
            runStatus: collected.truncated ? "partial" : "succeeded",
            evidence: collected.evidence,
            observations: revisedObservations,
            coverage: {
              status: collected.coverageStatus,
              expectedCadenceSec: schedule.cadenceSec,
              expectedLagSec: schedule.expectedLagSec,
              sourceTotalText: collected.sourceTotalText,
              interpretedTotalText: collected.interpretedTotalText,
              discrepancyText: collected.discrepancyText,
              reconciliationStatus: collected.reconciliationStatus,
              freshnessAt,
            },
          };
          const res = await this.service.ingestAtomicBatch(
            { tenantId: schedule.tenantId, groups: [group] },
            persistNow,
            { collectorLeaseFence }
          );
          winInserted = res.inserted;
          winReplayed = res.replayedNoop;
        } else {
          const importId = `imp_${schedule.connector}_${runHash}_${persistNow}_${crypto.randomUUID().slice(0, 8)}`;
          const STAGE_CHUNK_OBS = 500;
          let chunkIdx = 0;
          try {
            for (let offset = 0; offset < revisedObservations.length; offset += STAGE_CHUNK_OBS) {
              // Renew lease while staging chunks so long multi-chunk imports remain valid and detect preemption early
              await this.assertAndRenewLease(schedule.scheduleId, leaseOwner, getNow(), leaseMs, getClockOffsetMs());
              const slice = revisedObservations.slice(offset, offset + STAGE_CHUNK_OBS);
              const isLast = offset + STAGE_CHUNK_OBS >= revisedObservations.length;
              const group: AtomicIngestGroupInput = {
                resourceId: schedule.resourceId,
                source: collected.source,
                runId,
                runIdempotencyKey: runIdem,
                sourceResourceId: schedule.sourceResourceId,
                windowStart: day,
                windowEnd: day,
                cursor: `chunk-${chunkIdx + 1}`,
                runStatus: isLast && !collected.truncated ? "succeeded" : "partial",
                evidence: collected.evidence,
                observations: slice,
                coverage: {
                  status: isLast ? collected.coverageStatus : "partial",
                  expectedCadenceSec: schedule.cadenceSec,
                  expectedLagSec: schedule.expectedLagSec,
                  sourceTotalText: collected.sourceTotalText,
                  interpretedTotalText: collected.interpretedTotalText,
                  discrepancyText: collected.discrepancyText,
                  reconciliationStatus: isLast ? collected.reconciliationStatus : "partial",
                  freshnessAt,
                },
              };
              await this.service.stageImportChunk(
                { tenantId: schedule.tenantId, importId, chunkIndex: chunkIdx, groups: [group] },
                persistNow,
                { callerId: `collector:${schedule.scheduleId}` }
              );
              chunkIdx += 1;
            }
            const commitRes = await this.service.commitStagedImport(
              { tenantId: schedule.tenantId, importId, expectedChunks: chunkIdx },
              persistNow,
              { collectorLeaseFence }
            );
            winInserted = commitRes.inserted;
            winReplayed = commitRes.replayedNoop;
          } catch (stageErr) {
            // Clean up invisible staged chunks if lease was lost or commit aborted
            try {
              await this.service.abortStagedImport(schedule.tenantId, importId);
            } catch {
              // Best-effort cleanup of invisible staged chunks
            }
            throw stageErr;
          }
        }

        totalInserted += winInserted;
        totalReplayed += winReplayed;
        consecutiveFailures = 0; // Keep in-memory retry counter synchronized with DB reset!

        if (collected.budgetLimited) {
          cooldownUntil = committedBudgetResumeAt ?? nextUtcMidnightMs(getNow());
          finalErrorClass = "quota_exceeded";
          finalErrorMessage = budgetPartialMsg;
        } else if (cursorDate === null || day > cursorDate) {
          cursorDate = day;
        }

        windows.push({
          windowStart: day,
          windowEnd: day,
          status: winStatus,
          inserted: winInserted,
          replayedNoop: winReplayed,
          requestsUsed: collected.requestsUsed,
          coverageStatus: collected.coverageStatus,
          reconciliationStatus: collected.reconciliationStatus,
          truncated: collected.truncated,
          ...(collected.budgetLimited
            ? {
                errorClass: "quota_exceeded",
                errorMessage: "Breakdown skipped due to daily request budget; window retained for resume",
              }
            : {}),
        });

        if (collected.budgetLimited) {
          break;
        }
      }

      const finalStatus = aggregateOverallStatus(windows);

      return {
        scheduleId: schedule.scheduleId,
        tenantId: schedule.tenantId,
        resourceId: schedule.resourceId,
        connector: schedule.connector,
        status: finalStatus,
        windowsProcessed: windows.length,
        inserted: totalInserted,
        replayedNoop: totalReplayed,
        requestsUsed: totalRequestsThisCall,
        cursorDate,
        cooldownUntil,
        errorClass: finalErrorClass,
        errorMessage: finalErrorMessage,
        windows,
      };
    } catch (err: any) {
      if (err instanceof ScheduleLeaseLostError || err instanceof LeaseFenceError) {
        // Do NOT overwrite schedule or coverage state owned by a newer lease holder
        const status: RunStatus = windows.length > 0 ? "partial" : "running";
        return {
          scheduleId: schedule.scheduleId,
          tenantId: schedule.tenantId,
          resourceId: schedule.resourceId,
          connector: schedule.connector,
          status,
          windowsProcessed: windows.length,
          inserted: totalInserted,
          replayedNoop: totalReplayed,
          requestsUsed: totalRequestsThisCall,
          cursorDate,
          cooldownUntil,
          errorClass: "schedule_lease_lost",
          errorMessage: err.message,
          windows,
        };
      }

      // Isolate unexpected schedule execution / ingestion failures on the ACTUAL currentDay
      // while preserving all previously committed windows and accumulated totals!
      const errMsg = redactCollectorSecrets(err?.message || "Unexpected collector execution error");
      let effectiveStatus: "blocked" | "failed" = "failed";
      let effectiveErrorClass = "collector_execution_error";
      let recordedCooldown: number | null = cooldownUntil;
      try {
        const recorded = await this.recordBlockedOrFailedCoverage(
          { ...schedule, cursorDate, consecutiveFailures },
          leaseOwner,
          leaseMs,
          currentDay,
          currentDay,
          "failed",
          effectiveErrorClass,
          errMsg,
          true,
          getNow,
          getClockOffsetMs
        );
        effectiveStatus = recorded.effectiveStatus;
        effectiveErrorClass = recorded.effectiveErrorClass;
        recordedCooldown = recorded.cooldownUntil;
      } catch (recordErr) {
        if (recordErr instanceof ScheduleLeaseLostError) {
          return {
            scheduleId: schedule.scheduleId,
            tenantId: schedule.tenantId,
            resourceId: schedule.resourceId,
            connector: schedule.connector,
            status: windows.length > 0 ? "partial" : "running",
            windowsProcessed: windows.length,
            inserted: totalInserted,
            replayedNoop: totalReplayed,
            requestsUsed: totalRequestsThisCall,
            cursorDate,
            cooldownUntil,
            errorClass: "schedule_lease_lost",
            errorMessage: recordErr.message,
            windows,
          };
        }
      }
      windows.push({
        windowStart: currentDay,
        windowEnd: currentDay,
        status: effectiveStatus,
        inserted: 0,
        replayedNoop: 0,
        requestsUsed: 0,
        coverageStatus: effectiveStatus as CoverageStatus,
        reconciliationStatus: "unknown",
        truncated: false,
        errorClass: effectiveErrorClass,
        errorMessage: errMsg,
      });
      return {
        scheduleId: schedule.scheduleId,
        tenantId: schedule.tenantId,
        resourceId: schedule.resourceId,
        connector: schedule.connector,
        status: aggregateOverallStatus(windows),
        windowsProcessed: windows.length,
        inserted: totalInserted,
        replayedNoop: totalReplayed,
        requestsUsed: totalRequestsThisCall,
        cursorDate,
        cooldownUntil: recordedCooldown,
        errorClass: effectiveErrorClass,
        errorMessage: errMsg,
        windows,
      };
    } finally {
      if (leaseAcquired) {
        try {
          await this.db
            .prepare(
              "UPDATE ms_collector_schedules SET lease_owner = NULL, lease_expires_at = NULL WHERE schedule_id = ? AND lease_owner = ?"
            )
            .bind(initialSchedule.scheduleId, leaseOwner)
            .run();
        } catch {
          // Ignore lease cleanup error; lease_expires_at bounds lifetime
        }
      }
    }
  }

  public async runSchedules(
    req: CollectorRunRequest,
    opts: {
      allowedResourceFilter?: (resourceId: string) => boolean;
      now?: number;
      nowFn?: () => number;
    } = {}
  ): Promise<CollectorRunOutcome[]> {
    const queryNow = opts.nowFn ? opts.nowFn() : opts.now !== undefined ? opts.now : Date.now();
    const todayUtc = utcDateString(queryNow);

    // Pre-validate explicit window parameters once before iterating schedules
    if (req.windowStart || req.windowEnd) {
      const start = requireIsoDate(req.windowStart || req.windowEnd, "windowStart");
      const end = requireIsoDate(req.windowEnd || req.windowStart, "windowEnd");
      if (start > end) {
        throw new ValidationError("windowStart cannot be after windowEnd");
      }
      const totalDays = diffUtcDays(start, end) + 1;
      const limit = Math.min(Math.max(req.maxWindows ?? MAX_BACKFILL_WINDOWS_PER_CALL, 1), MAX_BACKFILL_WINDOWS_PER_CALL);
      if (totalDays > limit) {
        throw new ValidationError(`Backfill window spans ${totalDays} days, exceeding maxWindows (${limit})`);
      }
    }

    const clauses = ["tenant_id = ?"];
    const binds: any[] = [req.tenantId];
    if (req.scheduleId) {
      clauses.push("schedule_id = ?");
      binds.push(req.scheduleId);
    } else {
      clauses.push("enabled = 1");
      if (req.resourceId) {
        clauses.push("resource_id = ?");
        binds.push(req.resourceId);
      }
      if (req.connector) {
        clauses.push("connector = ?");
        binds.push(req.connector);
      }
      if (!req.force && !req.windowStart && !req.windowEnd) {
        clauses.push("next_run_at <= ?");
        binds.push(queryNow);
        clauses.push("(last_status != 'blocked' OR (last_error_class = 'quota_exceeded' AND (requests_used_date IS NULL OR requests_used_date < ?)))");
        binds.push(todayUtc);
      }
    }

    const res = await this.db
      .prepare(`SELECT * FROM ms_collector_schedules WHERE ${clauses.join(" AND ")} ORDER BY next_run_at ASC LIMIT 25`)
      .bind(...binds)
      .all<any>();

    const outcomes: CollectorRunOutcome[] = [];
    for (const row of res.results || []) {
      const sched = mapScheduleRow(row);
      if (opts.allowedResourceFilter && !opts.allowedResourceFilter(sched.resourceId)) {
        continue;
      }
      try {
        outcomes.push(
          await this.executeSchedule(sched, {
            windowStart: req.windowStart,
            windowEnd: req.windowEnd,
            maxWindows: req.maxWindows,
            force: req.force || Boolean(req.scheduleId),
            ...(opts.now !== undefined ? { now: opts.now } : {}),
            ...(opts.nowFn ? { nowFn: opts.nowFn } : {}),
          })
        );
      } catch (err: any) {
        const safeMsg = redactCollectorSecrets(err?.message || "Unexpected collector failure");
        outcomes.push({
          scheduleId: sched.scheduleId,
          tenantId: sched.tenantId,
          resourceId: sched.resourceId,
          connector: sched.connector,
          status: "failed",
          windowsProcessed: 0,
          inserted: 0,
          replayedNoop: 0,
          requestsUsed: 0,
          cursorDate: sched.cursorDate,
          cooldownUntil: null,
          errorClass: "collector_execution_error",
          errorMessage: safeMsg,
          windows: [],
        });
      }
    }
    return outcomes;
  }

  public async runDueSchedules(opts: { maxSchedules?: number; now?: number; nowFn?: () => number } = {}): Promise<CollectorRunOutcome[]> {
    const queryNow = opts.nowFn ? opts.nowFn() : opts.now !== undefined ? opts.now : Date.now();
    const todayUtc = utcDateString(queryNow);
    const limit = Math.min(Math.max(opts.maxSchedules ?? 5, 1), 25);
    const res = await this.db
      .prepare(
        `SELECT * FROM ms_collector_schedules
         WHERE enabled = 1
           AND next_run_at <= ?
           AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
           AND (
             last_status != 'blocked'
             OR (last_error_class = 'quota_exceeded' AND (requests_used_date IS NULL OR requests_used_date < ?))
           )
         ORDER BY next_run_at ASC
         LIMIT ?`
      )
      .bind(queryNow, queryNow, todayUtc, limit)
      .all<any>();

    const outcomes: CollectorRunOutcome[] = [];
    for (const row of res.results || []) {
      const sched = mapScheduleRow(row);
      try {
        outcomes.push(
          await this.executeSchedule(sched, {
            ...(opts.now !== undefined ? { now: opts.now } : {}),
            ...(opts.nowFn ? { nowFn: opts.nowFn } : {}),
          })
        );
      } catch (err: any) {
        const safeMsg = redactCollectorSecrets(err?.message || "Unexpected collector failure");
        outcomes.push({
          scheduleId: sched.scheduleId,
          tenantId: sched.tenantId,
          resourceId: sched.resourceId,
          connector: sched.connector,
          status: "failed",
          windowsProcessed: 0,
          inserted: 0,
          replayedNoop: 0,
          requestsUsed: 0,
          cursorDate: sched.cursorDate,
          cooldownUntil: null,
          errorClass: "collector_execution_error",
          errorMessage: safeMsg,
          windows: [],
        });
      }
    }
    return outcomes;
  }
}
