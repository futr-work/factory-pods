import type {
  CoverageStatus,
  DefinitionInput,
  EvidenceInput,
  ObservationInput,
  ReconciliationStatus,
} from "../types.js";
import type { CollectorCredentialEntry } from "./credentials.js";
import { redactCollectorSecrets } from "./credentials.js";
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  fetchBoundedProviderText,
  isValidCalendarIsoDate,
  MAX_PROVIDER_RESPONSE_BYTES,
  ProviderResponseLimitError,
  ProviderTimeoutError,
  type FetchLike,
  type ProviderCollectionResult,
} from "./gsc.js";

export const BING_SOURCE = "bing_webmaster";
export const BING_DEFINITION_VERSION = "bing-api-v1";
export const BING_ADAPTER_NAME = "bing-webmaster-api";
export const BING_ADAPTER_VERSION = "1.0.0";
const DEFAULT_BING_API_BASE = "https://ssl.bing.com/webmaster/api.svc/json";

const BING_DIMS_SCHEMA = {
  scope: { type: "string" as const, required: true },
  value_status: { type: "string" as const, required: true, enum: ["measured", "unknown"] },
  page: { type: "string" as const },
  query: { type: "string" as const },
};

export function bingMetricDefinitions(tenantId: string): DefinitionInput[] {
  return [
    {
      tenantId,
      metricId: "bing_clicks",
      version: BING_DEFINITION_VERSION,
      family: "seo",
      unit: "count",
      valueType: "integer",
      grain: "daily",
      windowTz: "UTC",
      dimensionsSchema: BING_DIMS_SCHEMA,
      numeratorRule: "bing_webmaster_clicks_count",
      denominatorRule: null,
      exclusionsRule: "bing_dimensions_limited_to_site_query_page",
      aggregationRule: "sum",
      comparabilityKey: "bing:bing_clicks:v1:count:UTC:daily",
    },
    {
      tenantId,
      metricId: "bing_impressions",
      version: BING_DEFINITION_VERSION,
      family: "seo",
      unit: "count",
      valueType: "integer",
      grain: "daily",
      windowTz: "UTC",
      dimensionsSchema: BING_DIMS_SCHEMA,
      numeratorRule: "bing_webmaster_impressions_count",
      denominatorRule: null,
      exclusionsRule: "bing_dimensions_limited_to_site_query_page",
      aggregationRule: "sum",
      comparabilityKey: "bing:bing_impressions:v1:count:UTC:daily",
    },
    {
      tenantId,
      metricId: "bing_ctr",
      version: BING_DEFINITION_VERSION,
      family: "seo",
      unit: "ratio",
      valueType: "decimal_string",
      grain: "daily",
      windowTz: "UTC",
      dimensionsSchema: BING_DIMS_SCHEMA,
      numeratorRule: "bing_webmaster_clicks_count",
      denominatorRule: "bing_webmaster_impressions_count",
      exclusionsRule: "zero_impressions_unknown",
      aggregationRule: "ratio_of_sums",
      comparabilityKey: "bing:bing_ctr:v1:ratio:UTC:daily",
    },
    {
      tenantId,
      metricId: "bing_position",
      version: BING_DEFINITION_VERSION,
      family: "seo",
      unit: "position",
      valueType: "decimal_string",
      grain: "daily",
      windowTz: "UTC",
      dimensionsSchema: BING_DIMS_SCHEMA,
      numeratorRule: "bing_webmaster_weighted_position_sum",
      denominatorRule: "bing_webmaster_impressions_count",
      exclusionsRule: "zero_impressions_unknown",
      aggregationRule: "impression_weighted_mean",
      comparabilityKey: "bing:bing_position:v1:position:UTC:daily",
    },
  ];
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function safeNonNegativeInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function isRequiredNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidOptionalNonNegativeNumber(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function formatRatio(num: number, den: number): string {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return "0";
  const fixed = (num / den).toFixed(12).replace(/\.?0+$/, "");
  return fixed || "0";
}

const ISO_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Strictly parse Bing Webmaster `/Date(1700000000000-0800)/`, calendar-valid `YYYY-MM-DD`,
 * or timezone-bearing ISO-8601 timestamps into UTC `YYYY-MM-DD`.
 * Rejects trailing garbage, invalid calendar dates (e.g. 2026-02-31), and ambiguous strings.
 */
export function parseBingDateToUtc(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();

  // 1. WCF JSON date format: integer is UTC epoch milliseconds; optional ±HHMM is display-only offset
  const msMatch = s.match(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/);
  if (msMatch) {
    const d = new Date(Number(msMatch[1]));
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }

  // 2. Strict calendar date-only string: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return isValidCalendarIsoDate(s) ? s : null;
  }

  // 3. Strict full ISO-8601 timestamp with explicit Z or ±HH:MM offset, normalized to UTC
  const tsMatch = s.match(ISO_TIMESTAMP_RE);
  if (tsMatch) {
    const datePart = tsMatch[1];
    const hour = Number(tsMatch[2]);
    const minute = Number(tsMatch[3]);
    const second = tsMatch[4] !== undefined ? Number(tsMatch[4]) : 0;
    if (!isValidCalendarIsoDate(datePart) || hour > 23 || minute > 59 || second > 59) {
      return null;
    }
    if (tsMatch[6]) {
      const offH = Number(tsMatch[7]);
      const offM = Number(tsMatch[8]);
      if (offH > 23 || offM > 59) return null;
    }
    const parsed = Date.parse(s);
    if (Number.isNaN(parsed)) return null;
    return new Date(parsed).toISOString().slice(0, 10);
  }

  return null;
}

function validateBingBaseUrl(baseUrl: string, customFetch: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return "Bing Webmaster API baseUrl is not a valid URL";
  }
  if (parsed.protocol !== "https:") {
    return "Bing Webmaster API baseUrl must use https://";
  }
  if (!customFetch && parsed.hostname !== "ssl.bing.com") {
    return "Bing Webmaster API baseUrl host is not allowlisted";
  }
  return null;
}

const ALLOWED_BING_ENVELOPE_KEYS = new Set(["d", "__type"]);

function parseBingEnvelope(rawBody: string): { ok: true; items: any[] } | { ok: false; errorMessage: string } {
  let parsed: any;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, errorMessage: "Bing Webmaster API returned malformed JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errorMessage: "Bing Webmaster API response envelope must be a JSON object" };
  }
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_BING_ENVELOPE_KEYS.has(key)) {
      return { ok: false, errorMessage: `Bing Webmaster API response contains unexpected envelope field '${key}'` };
    }
  }
  if (!Array.isArray(parsed.d)) {
    return { ok: false, errorMessage: "Bing Webmaster API response field 'd' must be an array" };
  }
  for (let i = 0; i < parsed.d.length; i++) {
    const item = parsed.d[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, errorMessage: `Bing Webmaster API d[${i}] must be a JSON object` };
    }
    const day = parseBingDateToUtc(item.Date ?? item.date);
    if (day === null) {
      return { ok: false, errorMessage: `Bing Webmaster API d[${i}] has invalid or missing Date` };
    }
    const rawClicks = item.Clicks !== undefined ? item.Clicks : item.clicks;
    const rawImpressions = item.Impressions !== undefined ? item.Impressions : item.impressions;
    if (
      !isRequiredNonNegativeNumber(rawClicks) ||
      !isRequiredNonNegativeNumber(rawImpressions) ||
      !isValidOptionalNonNegativeNumber(item.AvgImpressionPosition) ||
      !isValidOptionalNonNegativeNumber(item.AvgClickPosition) ||
      !isValidOptionalNonNegativeNumber(item.position)
    ) {
      return { ok: false, errorMessage: `Bing Webmaster API d[${i}] is missing or has invalid required metric values` };
    }
  }
  return { ok: true, items: parsed.d };
}

export async function collectBingWindow(params: {
  tenantId: string;
  resourceId: string;
  siteUrl: string;
  windowStart: string;
  windowEnd: string;
  dimensions: string[];
  maxRowsPerWindow: number;
  reserveRequest: () => Promise<boolean>;
  credential: Extract<CollectorCredentialEntry, { kind: "bing_api_key" }>;
  secretsToRedact: string[];
  fetchImpl?: FetchLike;
  now?: number;
  timeoutMs?: number;
}): Promise<ProviderCollectionResult> {
  const nowMs = params.now ?? Date.now();
  const timeoutMs = params.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const customFetch = Boolean(params.fetchImpl);
  const fetchImpl: FetchLike = params.fetchImpl ?? ((input, init) => fetch(input, init));
  const apiBase = (params.credential.apiBaseUrl || DEFAULT_BING_API_BASE).replace(/\/+$/, "");

  const baseUrlErr = validateBingBaseUrl(apiBase, customFetch);
  if (baseUrlErr) {
    return {
      ok: false,
      requestsUsed: 0,
      status: "blocked",
      errorClass: "provider_config_invalid",
      errorMessage: redactCollectorSecrets(baseUrlErr, params.secretsToRedact),
      retryable: false,
    };
  }

  let requestsUsed = 0;
  const callBing = async (
    methodName: "GetRankAndTrafficStats" | "GetQueryStats" | "GetPageStats"
  ): Promise<
    | { ok: true; items: any[]; rawBody: string }
    | { ok: false; status: "blocked" | "failed"; errorClass: string; errorMessage: string; retryable: boolean }
  > => {
    const url = `${apiBase}/${methodName}?siteUrl=${encodeURIComponent(params.siteUrl)}&apikey=${encodeURIComponent(params.credential.apiKey)}`;
    let resp: { status: number; ok: boolean; headers: Headers; text: string };
    try {
      resp = await fetchBoundedProviderText(
        fetchImpl,
        url,
        {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "manual",
        },
        { maxBytes: MAX_PROVIDER_RESPONSE_BYTES, timeoutMs }
      );
    } catch (err: any) {
      if (err instanceof ProviderResponseLimitError) {
        return {
          ok: false,
          status: "failed",
          errorClass: "provider_response_oversized",
          errorMessage: redactCollectorSecrets(err.message, params.secretsToRedact),
          retryable: true,
        };
      }
      if (err instanceof ProviderTimeoutError) {
        return {
          ok: false,
          status: "failed",
          errorClass: "provider_timeout",
          errorMessage: redactCollectorSecrets(err.message, params.secretsToRedact),
          retryable: true,
        };
      }
      return {
        ok: false,
        status: "failed",
        errorClass: "provider_network_error",
        errorMessage: redactCollectorSecrets(err?.message || "Bing Webmaster request failed", params.secretsToRedact),
        retryable: true,
      };
    }

    if (resp.status >= 300 && resp.status < 400) {
      return {
        ok: false,
        status: "blocked",
        errorClass: "provider_redirect_blocked",
        errorMessage: `Bing Webmaster API returned redirect HTTP ${resp.status}`,
        retryable: false,
      };
    }
    if (resp.status === 401 || resp.status === 403) {
      return {
        ok: false,
        status: "blocked",
        errorClass: "provider_auth_denied",
        errorMessage: `Bing Webmaster denied access (HTTP ${resp.status})`,
        retryable: false,
      };
    }
    if (resp.status === 429) {
      return {
        ok: false,
        status: "failed",
        errorClass: "provider_rate_limited",
        errorMessage: "Bing Webmaster API rate limit exceeded (HTTP 429)",
        retryable: true,
      };
    }
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status >= 500 ? "failed" : "blocked",
        errorClass: resp.status >= 500 ? "provider_unavailable" : "provider_bad_request",
        errorMessage: `Bing Webmaster API returned HTTP ${resp.status}`,
        retryable: resp.status >= 500,
      };
    }
    const parsed = parseBingEnvelope(resp.text);
    if (!parsed.ok) {
      return {
        ok: false,
        status: "failed",
        errorClass: "provider_malformed_response",
        errorMessage: parsed.errorMessage,
        retryable: true,
      };
    }
    return { ok: true, items: parsed.items, rawBody: resp.text };
  };

  // 1. Site-level daily totals (atomically reserve quota before HTTP call)
  const siteReserved = await params.reserveRequest();
  if (!siteReserved) {
    return {
      ok: false,
      requestsUsed: 0,
      status: "blocked",
      errorClass: "quota_exceeded",
      errorMessage: "Daily request budget exhausted before Bing Webmaster query",
      retryable: false,
    };
  }
  requestsUsed += 1;
  const siteRes = await callBing("GetRankAndTrafficStats");
  if (!siteRes.ok) {
    return { ...siteRes, requestsUsed };
  }

  const inWindow = (item: any): string | null => {
    const day = parseBingDateToUtc(item?.Date ?? item?.date);
    if (!day || day < params.windowStart || day > params.windowEnd) return null;
    return day;
  };

  const siteWindowRows = siteRes.items
    .map((item) => ({ day: inWindow(item), item }))
    .filter((entry): entry is { day: string; item: any } => entry.day !== null);

  // 2. Optional Query & Page stats when requested and atomic quota reservation succeeds
  const wantQuery = params.dimensions.includes("query");
  const wantPage = params.dimensions.includes("page");
  let queryWindowRows: Array<{ day: string; item: any }> = [];
  let pageWindowRows: Array<{ day: string; item: any }> = [];
  let queryRawBody: string | null = null;
  let pageRawBody: string | null = null;
  let truncated = false;
  let budgetLimited = false;

  if (wantQuery) {
    const qReserved = await params.reserveRequest();
    if (qReserved) {
      requestsUsed += 1;
      const qRes = await callBing("GetQueryStats");
      if (!qRes.ok) return { ...qRes, requestsUsed };
      queryRawBody = qRes.rawBody;
      queryWindowRows = qRes.items
        .map((item) => ({ day: inWindow(item), item }))
        .filter((entry): entry is { day: string; item: any } => entry.day !== null);
    } else {
      budgetLimited = true;
      truncated = true;
    }
  }

  if (wantPage) {
    const pReserved = await params.reserveRequest();
    if (pReserved) {
      requestsUsed += 1;
      const pRes = await callBing("GetPageStats");
      if (!pRes.ok) return { ...pRes, requestsUsed };
      pageRawBody = pRes.rawBody;
      pageWindowRows = pRes.items
        .map((item) => ({ day: inWindow(item), item }))
        .filter((entry): entry is { day: string; item: any } => entry.day !== null);
    } else {
      budgetLimited = true;
      truncated = true;
    }
  }

  // Finalize row-limit truncation BEFORE hashing evidence identity so raising maxRowsPerWindow produces a new revision cleanly
  const maxSlice = Math.min(params.maxRowsPerWindow, 2000);
  if (queryWindowRows.length > maxSlice || pageWindowRows.length > maxSlice) {
    truncated = true;
  }

  const collectedAt = new Date(nowMs).toISOString();
  const sourceAsOf = `${params.windowEnd}T00:00:00Z`;
  const evidencePayload = JSON.stringify({
    connector: "bing_webmaster",
    siteUrl: params.siteUrl,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    dimensions: params.dimensions,
    maxRowsPerWindow: params.maxRowsPerWindow,
    siteRows: siteWindowRows.length,
    queryRows: Math.min(queryWindowRows.length, maxSlice),
    pageRows: Math.min(pageWindowRows.length, maxSlice),
    truncated,
    budgetLimited,
    siteSha256: await sha256Hex(siteRes.rawBody),
    querySha256: queryRawBody !== null ? await sha256Hex(queryRawBody) : null,
    pageSha256: pageRawBody !== null ? await sha256Hex(pageRawBody) : null,
  });
  const evidenceDigest = await sha256Hex(evidencePayload);
  const evidenceId = `ev_bing_${(await sha256Hex(`${params.tenantId}|${params.resourceId}|${params.windowStart}|${params.windowEnd}|${evidenceDigest}`)).slice(0, 32)}`;
  const rawByteSize =
    new TextEncoder().encode(siteRes.rawBody).byteLength +
    (queryRawBody !== null ? new TextEncoder().encode(queryRawBody).byteLength : 0) +
    (pageRawBody !== null ? new TextEncoder().encode(pageRawBody).byteLength : 0);

  const evidence: EvidenceInput = {
    evidenceId,
    uriPointer: `evidence://bing-webmaster/${evidenceId}/${evidenceDigest}`,
    sha256: evidenceDigest,
    byteSize: rawByteSize,
    mediaType: "application/json",
    privacyClass: "restricted",
    retentionClass: "365d",
    collectedAt,
    sourceAsOf,
    adapterName: BING_ADAPTER_NAME,
    adapterVersion: BING_ADAPTER_VERSION,
  };

  const observations: ObservationInput[] = [];
  let sourceTotalClicks = 0;
  let interpretedTotalClicks = 0;
  let hasUnknownRate = false;

  const pushBingQuad = async (
    day: string,
    clicks: number,
    impressions: number,
    avgPos: number | null,
    baseDims: Record<string, string>,
    exclusions: Record<string, any> | null
  ) => {
    const intClicks = safeNonNegativeInt(clicks);
    const intImpressions = safeNonNegativeInt(impressions);
    const hasPos = avgPos !== null && Number.isFinite(avgPos) && avgPos > 0 && intImpressions > 0;
    const weightedPos = hasPos ? avgPos * intImpressions : 0;
    const ctrStatus = intImpressions > 0 ? "measured" : "unknown";
    const posStatus = hasPos ? "measured" : "unknown";
    if (ctrStatus === "unknown" || posStatus === "unknown") hasUnknownRate = true;

    const entries: Array<{
      metricId: string;
      valueNum?: number;
      valueText?: string;
      numerator: number;
      denominator: number | null;
      valueStatus: "measured" | "unknown";
    }> = [
      { metricId: "bing_clicks", valueNum: intClicks, numerator: intClicks, denominator: null, valueStatus: "measured" },
      { metricId: "bing_impressions", valueNum: intImpressions, numerator: intImpressions, denominator: null, valueStatus: "measured" },
      {
        metricId: "bing_ctr",
        valueText: intImpressions > 0 ? formatRatio(intClicks, intImpressions) : "0",
        numerator: intClicks,
        denominator: intImpressions,
        valueStatus: ctrStatus,
      },
      {
        metricId: "bing_position",
        valueText: hasPos ? formatRatio(weightedPos, intImpressions) : "0",
        numerator: hasPos ? weightedPos : 0,
        denominator: hasPos ? intImpressions : 0,
        valueStatus: posStatus,
      },
    ];

    for (const entry of entries) {
      const dims: Record<string, string> = { ...baseDims, value_status: entry.valueStatus };
      const dimKey = Object.keys(dims)
        .sort()
        .map((k) => `${k}=${dims[k]}`)
        .join("|");
      const idem = `bing:${(await sha256Hex(`${params.resourceId}|${entry.metricId}|${day}|${dimKey}`)).slice(0, 40)}`;
      observations.push({
        metricId: entry.metricId,
        definitionVersion: BING_DEFINITION_VERSION,
        windowStart: day,
        windowEnd: day,
        windowTz: "UTC",
        grain: "daily",
        dimensions: dims,
        ...(entry.valueNum !== undefined ? { valueNum: entry.valueNum } : { valueText: entry.valueText }),
        numerator: entry.numerator,
        denominator: entry.denominator,
        exclusions,
        interpretationVersion: BING_ADAPTER_VERSION,
        sourceRevision: 1,
        sourceAsOf,
        idempotencyKey: idem,
      });
    }
  };

  for (const { day, item } of siteWindowRows) {
    const clicks = safeNonNegativeInt(item.Clicks ?? item.clicks);
    const impressions = safeNonNegativeInt(item.Impressions ?? item.impressions);
    const avgPosRaw = item.AvgImpressionPosition ?? item.AvgClickPosition ?? item.position ?? null;
    const avgPos = avgPosRaw !== null && avgPosRaw !== undefined && Number.isFinite(Number(avgPosRaw)) && Number(avgPosRaw) > 0 ? Number(avgPosRaw) : null;
    sourceTotalClicks += clicks;
    interpretedTotalClicks += clicks;
    await pushBingQuad(
      day,
      clicks,
      impressions,
      avgPos,
      { scope: "Property" },
      truncated ? { partial_breakdown: true, budget_limited: budgetLimited } : null
    );
  }

  for (const { day, item } of queryWindowRows.slice(0, maxSlice)) {
    const queryText = String(item.Query ?? item.query ?? "").trim();
    if (!queryText) continue;
    const avgPosRaw = item.AvgImpressionPosition ?? item.AvgClickPosition ?? null;
    const avgPos = avgPosRaw !== null && avgPosRaw !== undefined && Number(avgPosRaw) > 0 ? Number(avgPosRaw) : null;
    await pushBingQuad(
      day,
      Number(item.Clicks ?? 0),
      Number(item.Impressions ?? 0),
      avgPos,
      { scope: "Query", query: queryText },
      truncated ? { row_limit_truncated: true } : null
    );
  }

  for (const { day, item } of pageWindowRows.slice(0, maxSlice)) {
    const pageUrl = String(item.Query ?? item.Page ?? item.Url ?? item.url ?? "").trim();
    if (!pageUrl) continue;
    const avgPosRaw = item.AvgImpressionPosition ?? item.AvgClickPosition ?? null;
    const avgPos = avgPosRaw !== null && avgPosRaw !== undefined && Number(avgPosRaw) > 0 ? Number(avgPosRaw) : null;
    await pushBingQuad(
      day,
      Number(item.Clicks ?? 0),
      Number(item.Impressions ?? 0),
      avgPos,
      { scope: "Page", page: pageUrl },
      truncated ? { row_limit_truncated: true } : null
    );
  }

  const discrepancy = sourceTotalClicks - interpretedTotalClicks;
  const reconciliationStatus: ReconciliationStatus =
    discrepancy !== 0 ? "mismatch" : truncated ? "partial" : "matched";

  const coverageStatus: CoverageStatus =
    siteWindowRows.length === 0
      ? "zero"
      : truncated || hasUnknownRate
        ? "partial"
        : sourceTotalClicks === 0 && siteWindowRows.every(({ item }) => Number(item.Impressions ?? 0) === 0)
          ? "zero"
          : "successful";

  return {
    ok: true,
    source: BING_SOURCE,
    requestsUsed,
    evidence,
    observations,
    coverageStatus,
    reconciliationStatus,
    sourceTotalText: String(sourceTotalClicks),
    interpretedTotalText: String(interpretedTotalClicks),
    discrepancyText: String(discrepancy),
    truncated,
    budgetLimited,
  };
}
