import type {
  CoverageStatus,
  DefinitionInput,
  EvidenceInput,
  ObservationInput,
  ReconciliationStatus,
} from "../types.js";
import type { CollectorCredentialEntry } from "./credentials.js";
import { redactCollectorSecrets } from "./credentials.js";

export const GSC_SOURCE = "gsc_api";
export const GSC_DEFINITION_VERSION = "gsc-api-v1";
export const GSC_ADAPTER_NAME = "gsc-search-analytics";
export const GSC_ADAPTER_VERSION = "1.0.0";
export const GSC_READONLY_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const DEFAULT_GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const GSC_API_ORIGIN = "https://searchconsole.googleapis.com";
export const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class ProviderResponseLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderResponseLimitError";
  }
}

export class ProviderTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderTimeoutError";
  }
}

/**
 * Fetch a provider endpoint with bounded timeout and streaming byte-cap enforcement.
 * Cancels the underlying response body stream immediately upon overflow without buffering unbounded bytes.
 */
export async function fetchBoundedProviderText(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  opts: { maxBytes?: number; timeoutMs?: number } = {}
): Promise<{ status: number; ok: boolean; headers: Headers; text: string }> {
  const maxBytes = opts.maxBytes ?? MAX_PROVIDER_RESPONSE_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let resp: Response;
    try {
      resp = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err: any) {
      if (timedOut) {
        throw new ProviderTimeoutError(`Provider request timed out after ${timeoutMs}ms`);
      }
      throw err;
    }

    if (resp.status >= 300 && resp.status < 400) {
      await resp.body?.cancel?.().catch(() => {});
      return { status: resp.status, ok: false, headers: resp.headers, text: "" };
    }

    const contentLengthHeader = resp.headers?.get?.("content-length");
    if (contentLengthHeader !== null && contentLengthHeader !== undefined) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await resp.body?.cancel?.().catch(() => {});
        controller.abort();
        throw new ProviderResponseLimitError(`Provider response declared ${declared} bytes, exceeding ${maxBytes}-byte limit`);
      }
    }

    if (resp.body && typeof resp.body.getReader === "function") {
      const reader = resp.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        while (true) {
          let readRes: ReadableStreamReadResult<Uint8Array>;
          try {
            readRes = await reader.read();
          } catch (err) {
            if (timedOut) {
              throw new ProviderTimeoutError(`Provider response body timed out after ${timeoutMs}ms`);
            }
            throw err;
          }
          if (readRes.done) break;
          const chunk = readRes.value;
          if (!chunk || chunk.byteLength === 0) continue;
          totalBytes += chunk.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel().catch(() => {});
            controller.abort();
            throw new ProviderResponseLimitError(`Provider response exceeded ${maxBytes}-byte limit`);
          }
          chunks.push(chunk);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Reader already closed/canceled
        }
      }
      const merged = new Uint8Array(totalBytes);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
      return { status: resp.status, ok: resp.ok, headers: resp.headers, text: new TextDecoder().decode(merged) };
    }

    const buf = await resp.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new ProviderResponseLimitError(`Provider response exceeded ${maxBytes}-byte limit`);
    }
    return { status: resp.status, ok: resp.ok, headers: resp.headers, text: new TextDecoder().decode(buf) };
  } finally {
    clearTimeout(timer);
  }
}

export interface ProviderCollectionSuccess {
  ok: true;
  source: string;
  requestsUsed: number;
  evidence: EvidenceInput;
  observations: ObservationInput[];
  coverageStatus: CoverageStatus;
  reconciliationStatus: ReconciliationStatus;
  sourceTotalText: string;
  interpretedTotalText: string;
  discrepancyText: string;
  truncated: boolean;
  budgetLimited: boolean;
}

export interface ProviderCollectionFailure {
  ok: false;
  requestsUsed: number;
  status: "failed" | "blocked";
  errorClass: string;
  errorMessage: string;
  retryable: boolean;
}

export type ProviderCollectionResult = ProviderCollectionSuccess | ProviderCollectionFailure;

const GSC_DIMS_SCHEMA = {
  scope: { type: "string" as const, required: true },
  search_type: { type: "string" as const, required: true },
  value_status: { type: "string" as const, required: true, enum: ["measured", "unknown"] },
  page: { type: "string" as const },
  query: { type: "string" as const },
  country: { type: "string" as const },
  device: { type: "string" as const },
};

export function gscMetricDefinitions(tenantId: string): DefinitionInput[] {
  return [
    {
      tenantId,
      metricId: "gsc_clicks",
      version: GSC_DEFINITION_VERSION,
      family: "seo",
      unit: "count",
      valueType: "integer",
      grain: "daily",
      windowTz: "UTC",
      dimensionsSchema: GSC_DIMS_SCHEMA,
      numeratorRule: "gsc_api_clicks_count",
      denominatorRule: null,
      exclusionsRule: "row_limit_truncation_recorded",
      aggregationRule: "sum",
      comparabilityKey: "gsc:gsc_clicks:v1:count:UTC:daily",
    },
    {
      tenantId,
      metricId: "gsc_impressions",
      version: GSC_DEFINITION_VERSION,
      family: "seo",
      unit: "count",
      valueType: "integer",
      grain: "daily",
      windowTz: "UTC",
      dimensionsSchema: GSC_DIMS_SCHEMA,
      numeratorRule: "gsc_api_impressions_count",
      denominatorRule: null,
      exclusionsRule: "row_limit_truncation_recorded",
      aggregationRule: "sum",
      comparabilityKey: "gsc:gsc_impressions:v1:count:UTC:daily",
    },
    {
      tenantId,
      metricId: "gsc_ctr",
      version: GSC_DEFINITION_VERSION,
      family: "seo",
      unit: "ratio",
      valueType: "decimal_string",
      grain: "daily",
      windowTz: "UTC",
      dimensionsSchema: GSC_DIMS_SCHEMA,
      numeratorRule: "gsc_api_clicks_count",
      denominatorRule: "gsc_api_impressions_count",
      exclusionsRule: "zero_impressions_unknown",
      aggregationRule: "ratio_of_sums",
      comparabilityKey: "gsc:gsc_ctr:v1:ratio:UTC:daily",
    },
    {
      tenantId,
      metricId: "gsc_position",
      version: GSC_DEFINITION_VERSION,
      family: "seo",
      unit: "position",
      valueType: "decimal_string",
      grain: "daily",
      windowTz: "UTC",
      dimensionsSchema: GSC_DIMS_SCHEMA,
      numeratorRule: "gsc_api_weighted_position_sum",
      denominatorRule: "gsc_api_impressions_count",
      exclusionsRule: "zero_impressions_unknown",
      aggregationRule: "impression_weighted_mean",
      comparabilityKey: "gsc:gsc_position:v1:position:UTC:daily",
    },
  ];
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace(/-----BEGIN [A-Z0-9 ]+-----/g, "")
    .replace(/-----END [A-Z0-9 ]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(cleaned);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidCalendarIsoDate(raw: string): boolean {
  const m = raw.match(DATE_RE);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === mo && dt.getUTCDate() === d;
}

function safeNonNegativeInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function isRequiredNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidOptionalNonNegativeNumber(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function formatRatio(num: number, den: number): string {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return "0";
  const val = num / den;
  const fixed = val.toFixed(12).replace(/\.?0+$/, "");
  return fixed || "0";
}

function validateGoogleTokenUri(uri: string, customFetch: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return "Google OAuth tokenUri is not a valid URL";
  }
  if (parsed.protocol !== "https:") {
    return "Google OAuth tokenUri must use https://";
  }
  if (!customFetch && parsed.hostname !== "oauth2.googleapis.com") {
    return "Google OAuth tokenUri host is not allowlisted";
  }
  return null;
}

async function mintGoogleAccessToken(
  credential: Extract<CollectorCredentialEntry, { kind: "gsc_service_account" | "gsc_oauth_refresh" }>,
  fetchImpl: FetchLike,
  customFetch: boolean,
  nowMs: number,
  timeoutMs: number
): Promise<{ ok: true; accessToken: string } | { ok: false; status: "blocked" | "failed"; errorClass: string; errorMessage: string; retryable: boolean }> {
  const tokenUri = credential.tokenUri || DEFAULT_GOOGLE_TOKEN_URI;
  const uriError = validateGoogleTokenUri(tokenUri, customFetch);
  if (uriError) {
    return {
      ok: false,
      status: "blocked",
      errorClass: "provider_config_invalid",
      errorMessage: uriError,
      retryable: false,
    };
  }

  let formBody: URLSearchParams;
  if (credential.kind === "gsc_service_account") {
    const iat = Math.floor(nowMs / 1000);
    const exp = iat + 3600;
    const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const payload = base64UrlEncode(
      new TextEncoder().encode(
        JSON.stringify({
          iss: credential.clientEmail,
          scope: GSC_READONLY_SCOPE,
          aud: tokenUri,
          iat,
          exp,
        })
      )
    );
    const signingInput = `${header}.${payload}`;
    let cryptoKey: CryptoKey;
    try {
      cryptoKey = await crypto.subtle.importKey(
        "pkcs8",
        pemToArrayBuffer(credential.privateKeyPem),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
      );
    } catch {
      return {
        ok: false,
        status: "blocked",
        errorClass: "provider_config_invalid",
        errorMessage: "Google service account private key could not be imported",
        retryable: false,
      };
    }
    const sigBuf = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      new TextEncoder().encode(signingInput)
    );
    const assertion = `${signingInput}.${base64UrlEncode(new Uint8Array(sigBuf))}`;
    formBody = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
  } else {
    formBody = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credential.clientId,
      client_secret: credential.clientSecret,
      refresh_token: credential.refreshToken,
    });
  }

  let resp: { status: number; ok: boolean; headers: Headers; text: string };
  try {
    resp = await fetchBoundedProviderText(
      fetchImpl,
      tokenUri,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: formBody.toString(),
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
        errorMessage: err.message,
        retryable: true,
      };
    }
    if (err instanceof ProviderTimeoutError) {
      return {
        ok: false,
        status: "failed",
        errorClass: "provider_timeout",
        errorMessage: err.message,
        retryable: true,
      };
    }
    return {
      ok: false,
      status: "failed",
      errorClass: "provider_network_error",
      errorMessage: err?.message || "Google OAuth token request failed",
      retryable: true,
    };
  }

  if (resp.status >= 300 && resp.status < 400) {
    return {
      ok: false,
      status: "blocked",
      errorClass: "provider_redirect_blocked",
      errorMessage: `Google OAuth token endpoint returned redirect HTTP ${resp.status}`,
      retryable: false,
    };
  }
  if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
    return {
      ok: false,
      status: "blocked",
      errorClass: "provider_auth_denied",
      errorMessage: `Google OAuth token exchange denied (HTTP ${resp.status})`,
      retryable: false,
    };
  }
  if (!resp.ok) {
    return {
      ok: false,
      status: "failed",
      errorClass: resp.status === 429 ? "provider_rate_limited" : "provider_unavailable",
      errorMessage: `Google OAuth token exchange failed (HTTP ${resp.status})`,
      retryable: true,
    };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(resp.text);
  } catch {
    return {
      ok: false,
      status: "failed",
      errorClass: "provider_malformed_response",
      errorMessage: "Google OAuth token endpoint returned malformed JSON",
      retryable: true,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.access_token !== "string" || !parsed.access_token.trim()) {
    return {
      ok: false,
      status: "blocked",
      errorClass: "provider_auth_denied",
      errorMessage: "Google OAuth token response omitted access_token",
      retryable: false,
    };
  }
  return { ok: true, accessToken: parsed.access_token.trim() };
}

interface GscApiRow {
  keys: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

const VALID_GSC_DIMENSIONS = new Set(["date", "page", "query", "country", "device"]);
const VALID_GSC_SEARCH_TYPES = new Set(["web", "image", "video", "news", "discover", "googleNews"]);

const ALLOWED_GSC_ENVELOPE_KEYS = new Set(["rows", "responseAggregationType"]);

function parseGscEnvelope(
  rawBody: string,
  expectedDimCount: number
): { ok: true; rows: GscApiRow[] } | { ok: false; errorMessage: string } {
  let parsed: any;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, errorMessage: "GSC API returned malformed JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errorMessage: "GSC API response envelope must be a JSON object" };
  }
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_GSC_ENVELOPE_KEYS.has(key)) {
      return { ok: false, errorMessage: `GSC API response contains unexpected envelope field '${key}'` };
    }
  }
  if (parsed.responseAggregationType !== undefined && typeof parsed.responseAggregationType !== "string") {
    return { ok: false, errorMessage: "GSC API responseAggregationType must be a string when present" };
  }
  if (parsed.rows === undefined) {
    // Documented GSC empty-result shape: {} or { responseAggregationType: "byProperty" }
    return { ok: true, rows: [] };
  }
  if (!Array.isArray(parsed.rows)) {
    return { ok: false, errorMessage: "GSC API response 'rows' field must be an array when present" };
  }
  const rows: GscApiRow[] = [];
  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return { ok: false, errorMessage: `GSC API rows[${i}] must be a JSON object` };
    }
    if (!Array.isArray(row.keys) || row.keys.length !== expectedDimCount || !row.keys.every((k: unknown) => typeof k === "string")) {
      return { ok: false, errorMessage: `GSC API rows[${i}].keys must contain ${expectedDimCount} strings` };
    }
    const day = row.keys[0].trim();
    if (!isValidCalendarIsoDate(day)) {
      return { ok: false, errorMessage: `GSC API rows[${i}].keys[0] is not a valid calendar date` };
    }
    if (
      !isRequiredNonNegativeNumber(row.clicks) ||
      !isRequiredNonNegativeNumber(row.impressions) ||
      !isValidOptionalNonNegativeNumber(row.ctr) ||
      !isValidOptionalNonNegativeNumber(row.position)
    ) {
      return { ok: false, errorMessage: `GSC API rows[${i}] is missing or has invalid required metric values` };
    }
    rows.push(row as GscApiRow);
  }
  return { ok: true, rows };
}

export async function collectGscWindow(params: {
  tenantId: string;
  resourceId: string;
  siteUrl: string;
  windowStart: string;
  windowEnd: string;
  dimensions: string[];
  searchType: string;
  maxRowsPerWindow: number;
  canReserveRequest?: () => Promise<boolean>;
  reserveRequest: () => Promise<boolean>;
  credential: Extract<CollectorCredentialEntry, { kind: "gsc_service_account" | "gsc_oauth_refresh" }>;
  secretsToRedact: string[];
  fetchImpl?: FetchLike;
  now?: number;
  timeoutMs?: number;
}): Promise<ProviderCollectionResult> {
  const nowMs = params.now ?? Date.now();
  const timeoutMs = params.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const customFetch = Boolean(params.fetchImpl);
  const fetchImpl: FetchLike = params.fetchImpl ?? ((input, init) => fetch(input, init));
  const searchType = VALID_GSC_SEARCH_TYPES.has(params.searchType) ? params.searchType : "web";
  const requestedDims = params.dimensions.filter((d) => VALID_GSC_DIMENSIONS.has(d));
  const extraDims = requestedDims.filter((d) => d !== "date");
  let requestsUsed = 0;

  // Validate Google OAuth token URI before any network request
  const tokenUri = params.credential.tokenUri || DEFAULT_GOOGLE_TOKEN_URI;
  const uriError = validateGoogleTokenUri(tokenUri, customFetch);
  if (uriError) {
    return {
      ok: false,
      requestsUsed: 0,
      status: "blocked",
      errorClass: "provider_config_invalid",
      errorMessage: redactCollectorSecrets(uriError, params.secretsToRedact),
      retryable: false,
    };
  }

  // Fail-closed pre-check before OAuth so exhausted quota makes 0 OAuth calls
  if (params.canReserveRequest && !(await params.canReserveRequest())) {
    return {
      ok: false,
      requestsUsed: 0,
      status: "blocked",
      errorClass: "quota_exceeded",
      errorMessage: "Daily request budget exhausted before GSC query",
      retryable: false,
    };
  }

  const tokenRes = await mintGoogleAccessToken(params.credential, fetchImpl, customFetch, nowMs, timeoutMs);
  if (!tokenRes.ok) {
    return {
      ok: false,
      requestsUsed: 0,
      status: tokenRes.status,
      errorClass: tokenRes.errorClass,
      errorMessage: redactCollectorSecrets(tokenRes.errorMessage, params.secretsToRedact),
      retryable: tokenRes.retryable,
    };
  }

  // Atomically reserve the totals query AFTER OAuth completes and IMMEDIATELY before query dispatch
  // so OAuth crossing UTC midnight always books quota against the actual execution day!
  const totalsReserved = await params.reserveRequest();
  if (!totalsReserved) {
    return {
      ok: false,
      requestsUsed: 0,
      status: "blocked",
      errorClass: "quota_exceeded",
      errorMessage: "Daily request budget exhausted before GSC query",
      retryable: false,
    };
  }
  requestsUsed += 1;

  const accessToken = tokenRes.accessToken;
  const allSecrets = [...params.secretsToRedact, accessToken];
  const queryUrl = `${GSC_API_ORIGIN}/webmasters/v3/sites/${encodeURIComponent(params.siteUrl)}/searchAnalytics/query`;

  const runQuery = async (
    body: Record<string, any>,
    expectedDimCount: number
  ): Promise<
    | { ok: true; rows: GscApiRow[]; rawBody: string }
    | { ok: false; status: "blocked" | "failed"; errorClass: string; errorMessage: string; retryable: boolean }
  > => {
    let resp: { status: number; ok: boolean; headers: Headers; text: string };
    try {
      resp = await fetchBoundedProviderText(
        fetchImpl,
        queryUrl,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
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
          errorMessage: redactCollectorSecrets(err.message, allSecrets),
          retryable: true,
        };
      }
      if (err instanceof ProviderTimeoutError) {
        return {
          ok: false,
          status: "failed",
          errorClass: "provider_timeout",
          errorMessage: redactCollectorSecrets(err.message, allSecrets),
          retryable: true,
        };
      }
      return {
        ok: false,
        status: "failed",
        errorClass: "provider_network_error",
        errorMessage: redactCollectorSecrets(err?.message || "GSC request failed", allSecrets),
        retryable: true,
      };
    }

    if (resp.status >= 300 && resp.status < 400) {
      return {
        ok: false,
        status: "blocked",
        errorClass: "provider_redirect_blocked",
        errorMessage: `GSC API returned redirect HTTP ${resp.status}`,
        retryable: false,
      };
    }
    if (resp.status === 401 || resp.status === 403) {
      return {
        ok: false,
        status: "blocked",
        errorClass: "provider_auth_denied",
        errorMessage: `GSC denied access for property (HTTP ${resp.status})`,
        retryable: false,
      };
    }
    if (resp.status === 429) {
      return {
        ok: false,
        status: "failed",
        errorClass: "provider_rate_limited",
        errorMessage: "GSC API rate limit exceeded (HTTP 429)",
        retryable: true,
      };
    }
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status >= 500 ? "failed" : "blocked",
        errorClass: resp.status >= 500 ? "provider_unavailable" : "provider_bad_request",
        errorMessage: `GSC API returned HTTP ${resp.status}`,
        retryable: resp.status >= 500,
      };
    }
    const parsed = parseGscEnvelope(resp.text, expectedDimCount);
    if (!parsed.ok) {
      return {
        ok: false,
        status: "failed",
        errorClass: "provider_malformed_response",
        errorMessage: parsed.errorMessage,
        retryable: true,
      };
    }
    return { ok: true, rows: parsed.rows, rawBody: resp.text };
  };

  // 1. Property-level daily totals query (quota slot already reserved above)
  const totalsRes = await runQuery(
    {
      startDate: params.windowStart,
      endDate: params.windowEnd,
      dimensions: ["date"],
      type: searchType,
      rowLimit: 25000,
      dataState: "final",
    },
    1
  );
  if (!totalsRes.ok) {
    return { ...totalsRes, requestsUsed };
  }

  // 2. Dimensional breakdown query when requested and atomic quota reservation succeeds
  let dimRows: GscApiRow[] = [];
  let dimRawBody: string | null = null;
  let truncated = false;
  let budgetLimited = false;
  const dimQueryDimensions = ["date", ...extraDims];

  if (extraDims.length > 0) {
    const dimReserved = await params.reserveRequest();
    if (dimReserved) {
      requestsUsed += 1;
      const dimRes = await runQuery(
        {
          startDate: params.windowStart,
          endDate: params.windowEnd,
          dimensions: dimQueryDimensions,
          type: searchType,
          rowLimit: params.maxRowsPerWindow,
          dataState: "final",
        },
        dimQueryDimensions.length
      );
      if (!dimRes.ok) {
        return { ...dimRes, requestsUsed };
      }
      dimRows = dimRes.rows;
      dimRawBody = dimRes.rawBody;
      if (dimRows.length >= params.maxRowsPerWindow) {
        truncated = true;
      }
    } else {
      budgetLimited = true;
      truncated = true;
    }
  }

  // Finalize slice & truncation BEFORE hashing evidence identity so config/row-limit changes produce a new revision cleanly
  const maxDimObservations = Math.min(dimRows.length, 4000);
  if (dimRows.length > maxDimObservations) {
    truncated = true;
  }

  const collectedAt = new Date(nowMs).toISOString();
  const sourceAsOf = `${params.windowEnd}T00:00:00Z`;
  const evidencePayload = JSON.stringify({
    connector: "gsc",
    siteUrl: params.siteUrl,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    searchType,
    dimensions: requestedDims,
    maxRowsPerWindow: params.maxRowsPerWindow,
    totalsRowCount: totalsRes.rows.length,
    dimRowCount: maxDimObservations,
    truncated,
    budgetLimited,
    totalsBodySha256: await sha256Hex(totalsRes.rawBody),
    dimBodySha256: dimRawBody !== null ? await sha256Hex(dimRawBody) : null,
  });
  const evidenceDigest = await sha256Hex(evidencePayload);
  const evidenceId = `ev_gsc_${(await sha256Hex(`${params.tenantId}|${params.resourceId}|${params.windowStart}|${params.windowEnd}|${evidenceDigest}`)).slice(0, 32)}`;
  const rawByteSize =
    new TextEncoder().encode(totalsRes.rawBody).byteLength +
    (dimRawBody !== null ? new TextEncoder().encode(dimRawBody).byteLength : 0);

  const evidence: EvidenceInput = {
    evidenceId,
    uriPointer: `evidence://gsc/${evidenceId}/${evidenceDigest}`,
    sha256: evidenceDigest,
    byteSize: rawByteSize,
    mediaType: "application/json",
    privacyClass: "restricted",
    retentionClass: "365d",
    collectedAt,
    sourceAsOf,
    adapterName: GSC_ADAPTER_NAME,
    adapterVersion: GSC_ADAPTER_VERSION,
  };

  const observations: ObservationInput[] = [];
  let sourceTotalClicks = 0;
  let interpretedTotalClicks = 0;
  let hasUnknownRate = false;

  const pushMetricQuad = async (
    day: string,
    clicks: number,
    impressions: number,
    position: number,
    baseDims: Record<string, string>,
    exclusions: Record<string, any> | null
  ) => {
    const intClicks = safeNonNegativeInt(clicks);
    const intImpressions = safeNonNegativeInt(impressions);
    const weightedPos = intImpressions > 0 && Number.isFinite(position) && position >= 0 ? position * intImpressions : 0;
    const rateStatus = intImpressions > 0 ? "measured" : "unknown";
    if (rateStatus === "unknown") hasUnknownRate = true;

    const entries: Array<{
      metricId: string;
      valueNum?: number;
      valueText?: string;
      numerator: number;
      denominator: number | null;
      valueStatus: "measured" | "unknown";
    }> = [
      { metricId: "gsc_clicks", valueNum: intClicks, numerator: intClicks, denominator: null, valueStatus: "measured" },
      { metricId: "gsc_impressions", valueNum: intImpressions, numerator: intImpressions, denominator: null, valueStatus: "measured" },
      {
        metricId: "gsc_ctr",
        valueText: intImpressions > 0 ? formatRatio(intClicks, intImpressions) : "0",
        numerator: intClicks,
        denominator: intImpressions,
        valueStatus: rateStatus,
      },
      {
        metricId: "gsc_position",
        valueText: intImpressions > 0 ? formatRatio(weightedPos, intImpressions) : "0",
        numerator: weightedPos,
        denominator: intImpressions,
        valueStatus: rateStatus,
      },
    ];

    for (const item of entries) {
      const dims: Record<string, string> = { ...baseDims, value_status: item.valueStatus };
      const dimKey = Object.keys(dims)
        .sort()
        .map((k) => `${k}=${dims[k]}`)
        .join("|");
      const idem = `gsc:${(await sha256Hex(`${params.resourceId}|${item.metricId}|${day}|${dimKey}`)).slice(0, 40)}`;
      observations.push({
        metricId: item.metricId,
        definitionVersion: GSC_DEFINITION_VERSION,
        windowStart: day,
        windowEnd: day,
        windowTz: "UTC",
        grain: "daily",
        dimensions: dims,
        ...(item.valueNum !== undefined ? { valueNum: item.valueNum } : { valueText: item.valueText }),
        numerator: item.numerator,
        denominator: item.denominator,
        exclusions,
        interpretationVersion: GSC_ADAPTER_VERSION,
        sourceRevision: 1,
        sourceAsOf,
        idempotencyKey: idem,
      });
    }
  };

  for (const row of totalsRes.rows) {
    const day = row.keys[0].trim();
    const clicks = safeNonNegativeInt(row.clicks);
    const impressions = safeNonNegativeInt(row.impressions);
    const position = Number.isFinite(Number(row.position)) ? Number(row.position) : 0;
    sourceTotalClicks += clicks;
    interpretedTotalClicks += clicks;
    await pushMetricQuad(
      day,
      clicks,
      impressions,
      position,
      { scope: "Property", search_type: searchType },
      truncated ? { breakdown_truncated: true, max_rows: params.maxRowsPerWindow, budget_limited: budgetLimited } : null
    );
  }

  // Emit dimensional breakdown observations (bounded to stay within staged-import limits; never synthesize missing dimensions)
  for (let i = 0; i < maxDimObservations; i++) {
    const row = dimRows[i];
    const day = row.keys[0].trim();
    const dims: Record<string, string> = { scope: "Breakdown", search_type: searchType };
    for (let dIdx = 1; dIdx < dimQueryDimensions.length; dIdx++) {
      const dimName = dimQueryDimensions[dIdx];
      const val = row.keys[dIdx];
      if (typeof val === "string" && val.trim().length > 0) {
        dims[dimName] = val.trim();
      }
    }
    await pushMetricQuad(
      day,
      safeNonNegativeInt(row.clicks),
      safeNonNegativeInt(row.impressions),
      Number.isFinite(Number(row.position)) ? Number(row.position) : 0,
      dims,
      truncated ? { row_limit_truncated: true, max_rows: params.maxRowsPerWindow } : null
    );
  }

  let dimClickSum = 0;
  for (const r of dimRows) dimClickSum += safeNonNegativeInt(r.clicks);
  const discrepancy = sourceTotalClicks - interpretedTotalClicks;
  const reconciliationStatus: ReconciliationStatus =
    discrepancy !== 0
      ? "mismatch"
      : truncated || (extraDims.length > 0 && dimRows.length > 0 && dimClickSum !== sourceTotalClicks)
        ? "partial"
        : "matched";

  const coverageStatus: CoverageStatus =
    totalsRes.rows.length === 0
      ? "zero"
      : truncated || hasUnknownRate
        ? "partial"
        : sourceTotalClicks === 0 && totalsRes.rows.every((r) => Number(r.impressions ?? 0) === 0)
          ? "zero"
          : "successful";

  return {
    ok: true,
    source: GSC_SOURCE,
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
