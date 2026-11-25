import type { PodStorage } from "@futr-work/pod-kernel/storage";
import { sha256Hex } from "@futr-work/pod-kernel/auth";
import type {
  AnnotationInput,
  AttemptInput,
  CoverageInput,
  CoverageQueryInput,
  DefinitionInput,
  DefinitionRecord,
  DimensionFieldSpec,
  EventsQueryInput,
  IngestAtomicBatchInput,
  IngestBatchInput,
  MetricFamily,
  ObservationInput,
  ResourceInput,
  ResourceRecord,
  ResourceType,
  RunInput,
  RunStatus,
  SeriesQueryInput,
  ValueType,
} from "./types.js";

export class ValidationError extends Error {
  public readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ConflictError extends Error {
  public readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class NotFoundError extends Error {
  public readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

const RESOURCE_TYPES = new Set<ResourceType>(["site", "analytics_property", "ad_account", "server_service"]);
const METRIC_FAMILIES = new Set<MetricFamily>(["seo", "analytics", "spend", "telemetry"]);
const VALUE_TYPES = new Set<ValueType>(["integer", "decimal_string", "gauge", "counter"]);
const RUN_STATUSES = new Set<RunStatus>(["planned", "running", "partial", "succeeded", "failed", "blocked"]);
const ATTEMPT_STATUSES = new Set(["running", "partial", "succeeded", "failed", "blocked"]);
const PRIVACY_CLASSES = new Set(["public", "internal", "restricted", "pii_minimized"]);
const COVERAGE_STATUSES = new Set([
  "planned",
  "attempted",
  "successful",
  "zero",
  "partial",
  "failed",
  "blocked",
  "not-collected",
  "stale",
]);
const RECONCILIATION_STATUSES = new Set(["matched", "mismatch", "partial", "unknown"]);
const GAUGE_REDUCERS = new Set(["last", "min", "max", "mean"]);
const ANNOTATION_KINDS = new Set(["deploy", "fixpack", "config_change", "incident", "note"]);

const DECIMAL_RE = /^-?\d+(?:\.\d+)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;
const EVIDENCE_URI_RE = /^(?:fixture|r2|s3|gcs|evidence):\/\/[A-Za-z0-9._\-\/:]+$/;
const MAX_BATCH_OBSERVATIONS = 500;
const MAX_ATOMIC_OBSERVATIONS = 1000;
const MAX_ATOMIC_GROUPS = 100;
const MAX_IN_CLAUSE_ITEMS = 90;
const MAX_LIST_LIMIT = 500;

function validateEvidencePointer(val: unknown): string {
  const uri = requireNonEmptyString(val, "evidence.uriPointer", 512);
  if (uri.includes("@") || uri.includes("?") || uri.includes("#") || uri.includes("..")) {
    throw new ValidationError("evidence.uriPointer must be an opaque handle without credentials, query params, fragments, or path traversal");
  }
  if (!EVIDENCE_URI_RE.test(uri)) {
    throw new ValidationError("evidence.uriPointer must use an allowed opaque scheme (fixture://, r2://, s3://, gcs://, evidence://); data: and inline payload URIs are forbidden");
  }
  return uri;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function assertAllowedKeys(obj: Record<string, any>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new ValidationError(`Unknown field '${key}' in ${label}`);
    }
  }
}

function requireNonEmptyString(val: unknown, field: string, maxLen = 256): string {
  if (typeof val !== "string" || !val.trim()) {
    throw new ValidationError(`Field '${field}' must be a non-empty string`);
  }
  const trimmed = val.trim();
  if (trimmed.length > maxLen) {
    throw new ValidationError(`Field '${field}' exceeds max length (${maxLen})`);
  }
  return trimmed;
}

function assertValidDecimalString(val: unknown, field: string): string {
  if (typeof val !== "string" || !DECIMAL_RE.test(val.trim())) {
    throw new ValidationError(`Field '${field}' must be an exact canonical decimal string (no binary float)`);
  }
  return val.trim();
}

export function buildEntityUrn(resourceType: ResourceType, tenantId: string, resourceId: string): string {
  return `${resourceType}:${tenantId}:${resourceId}`;
}

export function computeComparabilityKey(def: {
  metricId: string;
  version: string;
  unit: string;
  valueType: ValueType;
  grain: string;
  windowTz: string;
  aggregationRule: string;
}): string {
  return `${def.metricId}@${def.version}|${def.unit}|${def.valueType}|${def.grain}|${def.windowTz}|${def.aggregationRule}`;
}

function validateDimensions(
  dimensions: unknown,
  schema: Record<string, DimensionFieldSpec>
): Record<string, string | number | boolean> {
  if (!dimensions || typeof dimensions !== "object" || Array.isArray(dimensions)) {
    throw new ValidationError("Observation 'dimensions' must be a plain object");
  }
  const input = dimensions as Record<string, unknown>;
  const normalized: Record<string, string | number | boolean> = {};

  for (const key of Object.keys(input)) {
    const spec = schema[key];
    if (!spec) {
      throw new ValidationError(`Unknown dimension '${key}' not declared in metric definition`);
    }
    const val = input[key];
    if (typeof val !== spec.type) {
      throw new ValidationError(`Dimension '${key}' expected type '${spec.type}', got '${typeof val}'`);
    }
    if (spec.type === "number" && !Number.isFinite(val as number)) {
      throw new ValidationError(`Dimension '${key}' must be a finite number`);
    }
    if (spec.enum && !spec.enum.includes(String(val))) {
      throw new ValidationError(`Dimension '${key}' value '${String(val)}' is not in allowed enum`);
    }
    normalized[key] = val as string | number | boolean;
  }

  for (const [key, spec] of Object.entries(schema)) {
    if (spec.required && !(key in normalized)) {
      throw new ValidationError(`Missing required dimension '${key}'`);
    }
  }
  return normalized;
}

function clampLimit(limit: unknown, fallback = 100): number {
  const n = typeof limit === "number" ? limit : Number.parseInt(String(limit ?? fallback), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), MAX_LIST_LIMIT);
}

function clampOffset(offset: unknown): number {
  const n = typeof offset === "number" ? offset : Number.parseInt(String(offset ?? 0), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Shared domain service composed strictly over PodStorage (no raw-D1 branching).
 * Used identically by Cloudflare Worker fetch/MCP/Code Mode handlers and local Node runtime.
 */
export class MeasurementService {
  constructor(private readonly db: PodStorage) {}

  private async appendEvent(
    tenantId: string,
    resourceId: string,
    entityUrn: string,
    eventType: "resource.registered" | "run.updated" | "observation.recorded" | "coverage.updated" | "annotation.recorded",
    payload: Record<string, unknown>,
    now: number
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ms_events (tenant_id, resource_id, entity_urn, event_type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(tenantId, resourceId, entityUrn, eventType, JSON.stringify(payload), now)
      .run();
  }

  public async registerResource(raw: ResourceInput, now = Date.now()): Promise<ResourceRecord> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ValidationError("Resource payload must be a JSON object");
    }
    assertAllowedKeys(
      raw as any,
      new Set(["tenantId", "resourceId", "resourceType", "sourceResourceId", "displayName", "activeFrom", "activeTo"]),
      "resource"
    );

    const tenantId = requireNonEmptyString(raw.tenantId, "tenantId", 128);
    const resourceId = requireNonEmptyString(raw.resourceId, "resourceId", 128);
    const resourceType = requireNonEmptyString(raw.resourceType, "resourceType", 64) as ResourceType;
    if (!RESOURCE_TYPES.has(resourceType)) {
      throw new ValidationError(`Invalid resourceType '${resourceType}'`);
    }
    const sourceResourceId = requireNonEmptyString(raw.sourceResourceId, "sourceResourceId", 256);
    const activeFrom = requireNonEmptyString(raw.activeFrom, "activeFrom", 64);
    const activeTo = raw.activeTo == null ? null : requireNonEmptyString(raw.activeTo, "activeTo", 64);
    const displayName = raw.displayName == null ? null : requireNonEmptyString(raw.displayName, "displayName", 256);
    const entityUrn = buildEntityUrn(resourceType, tenantId, resourceId);

    const existing = await this.db
      .prepare("SELECT * FROM ms_resources WHERE tenant_id = ? AND resource_id = ?")
      .bind(tenantId, resourceId)
      .first<any>();

    if (existing) {
      if (existing.resource_type !== resourceType) {
        throw new ConflictError(`Resource '${resourceId}' already registered with type '${existing.resource_type}'`);
      }
      await this.db
        .prepare(
          `UPDATE ms_resources
           SET source_resource_id = ?, display_name = ?, active_from = ?, active_to = ?, updated_at = ?
           WHERE tenant_id = ? AND resource_id = ?`
        )
        .bind(sourceResourceId, displayName, activeFrom, activeTo, now, tenantId, resourceId)
        .run();
    } else {
      await this.db
        .prepare(
          `INSERT INTO ms_resources (tenant_id, resource_id, entity_urn, resource_type, source_resource_id, display_name, active_from, active_to, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(tenantId, resourceId, entityUrn, resourceType, sourceResourceId, displayName, activeFrom, activeTo, now, now)
        .run();
    }

    await this.appendEvent(
      tenantId,
      resourceId,
      entityUrn,
      "resource.registered",
      { resourceType, sourceResourceId, activeFrom, activeTo },
      now
    );

    return {
      tenantId,
      resourceId,
      entityUrn,
      resourceType,
      sourceResourceId,
      displayName,
      activeFrom,
      activeTo,
      createdAt: existing ? existing.created_at : now,
      updatedAt: now,
    };
  }

  public async listResources(tenantId: string, limit = 100, offset = 0): Promise<ResourceRecord[]> {
    const res = await this.db
      .prepare(
        `SELECT * FROM ms_resources
         WHERE tenant_id = ?
         ORDER BY resource_id ASC
         LIMIT ? OFFSET ?`
      )
      .bind(tenantId, clampLimit(limit), clampOffset(offset))
      .all<any>();

    return (res.results || []).map((r) => ({
      tenantId: r.tenant_id,
      resourceId: r.resource_id,
      entityUrn: r.entity_urn,
      resourceType: r.resource_type,
      sourceResourceId: r.source_resource_id,
      displayName: r.display_name,
      activeFrom: r.active_from,
      activeTo: r.active_to,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  public async defineMetric(raw: DefinitionInput, now = Date.now()): Promise<DefinitionRecord> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ValidationError("Metric definition payload must be a JSON object");
    }
    assertAllowedKeys(
      raw as any,
      new Set([
        "tenantId",
        "metricId",
        "version",
        "family",
        "unit",
        "valueType",
        "grain",
        "windowTz",
        "dimensionsSchema",
        "numeratorRule",
        "denominatorRule",
        "exclusionsRule",
        "aggregationRule",
        "comparabilityKey",
      ]),
      "definition"
    );

    const tenantId = requireNonEmptyString(raw.tenantId, "tenantId", 128);
    const metricId = requireNonEmptyString(raw.metricId, "metricId", 128);
    const version = requireNonEmptyString(raw.version, "version", 64);
    const family = requireNonEmptyString(raw.family, "family", 32) as MetricFamily;
    if (!METRIC_FAMILIES.has(family)) {
      throw new ValidationError(`Invalid metric family '${family}'`);
    }
    const unit = requireNonEmptyString(raw.unit, "unit", 64);
    const valueType = requireNonEmptyString(raw.valueType, "valueType", 32) as ValueType;
    if (!VALUE_TYPES.has(valueType)) {
      throw new ValidationError(`Invalid valueType '${valueType}'`);
    }
    if (family === "spend" && valueType !== "decimal_string") {
      throw new ValidationError("Paid-ad spend definitions MUST use valueType 'decimal_string'");
    }
    const grain = requireNonEmptyString(raw.grain, "grain", 64);
    const windowTz = requireNonEmptyString(raw.windowTz, "windowTz", 64);
    const aggregationRule = requireNonEmptyString(raw.aggregationRule, "aggregationRule", 64);
    if (valueType === "gauge" && !GAUGE_REDUCERS.has(aggregationRule)) {
      throw new ValidationError(`Gauge definitions require aggregationRule in last|min|max|mean, got '${aggregationRule}'`);
    }

    if (!raw.dimensionsSchema || typeof raw.dimensionsSchema !== "object" || Array.isArray(raw.dimensionsSchema)) {
      throw new ValidationError("Field 'dimensionsSchema' must be an object");
    }
    for (const [dimName, spec] of Object.entries(raw.dimensionsSchema)) {
      if (!dimName.trim() || !spec || typeof spec !== "object" || !["string", "number", "boolean"].includes(spec.type)) {
        throw new ValidationError(`Invalid dimension schema for '${dimName}'`);
      }
    }

    const comparabilityKey =
      typeof raw.comparabilityKey === "string" && raw.comparabilityKey.trim()
        ? raw.comparabilityKey.trim()
        : computeComparabilityKey({ metricId, version, unit, valueType, grain, windowTz, aggregationRule });

    const dimensionsSchemaJson = canonicalJson(raw.dimensionsSchema);
    const numeratorRule = raw.numeratorRule ?? null;
    const denominatorRule = raw.denominatorRule ?? null;
    const exclusionsRule = raw.exclusionsRule ?? null;

    const existing = await this.db
      .prepare("SELECT * FROM ms_definitions WHERE tenant_id = ? AND metric_id = ? AND version = ?")
      .bind(tenantId, metricId, version)
      .first<any>();

    if (existing) {
      const same =
        existing.family === family &&
        existing.unit === unit &&
        existing.value_type === valueType &&
        existing.grain === grain &&
        existing.window_tz === windowTz &&
        existing.dimensions_schema_json === dimensionsSchemaJson &&
        existing.numerator_rule === numeratorRule &&
        existing.denominator_rule === denominatorRule &&
        existing.exclusions_rule === exclusionsRule &&
        existing.aggregation_rule === aggregationRule &&
        existing.comparability_key === comparabilityKey;
      if (!same) {
        throw new ConflictError(`Metric definition '${metricId}@${version}' already exists with different immutable semantics`);
      }
      return {
        tenantId: existing.tenant_id,
        metricId: existing.metric_id,
        version: existing.version,
        family: existing.family,
        unit: existing.unit,
        valueType: existing.value_type,
        grain: existing.grain,
        windowTz: existing.window_tz,
        dimensionsSchema: JSON.parse(existing.dimensions_schema_json),
        numeratorRule: existing.numerator_rule,
        denominatorRule: existing.denominator_rule,
        exclusionsRule: existing.exclusions_rule,
        aggregationRule: existing.aggregation_rule,
        comparabilityKey: existing.comparability_key,
        createdAt: existing.created_at,
      };
    }

    await this.db
      .prepare(
        `INSERT INTO ms_definitions (
           tenant_id, metric_id, version, family, unit, value_type, grain, window_tz,
           dimensions_schema_json, numerator_rule, denominator_rule, exclusions_rule,
           aggregation_rule, comparability_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        tenantId,
        metricId,
        version,
        family,
        unit,
        valueType,
        grain,
        windowTz,
        dimensionsSchemaJson,
        numeratorRule,
        denominatorRule,
        exclusionsRule,
        aggregationRule,
        comparabilityKey,
        now
      )
      .run();

    return {
      tenantId,
      metricId,
      version,
      family,
      unit,
      valueType,
      grain,
      windowTz,
      dimensionsSchema: JSON.parse(dimensionsSchemaJson),
      numeratorRule,
      denominatorRule,
      exclusionsRule,
      aggregationRule,
      comparabilityKey,
      createdAt: now,
    };
  }

  public async createRun(raw: RunInput, now = Date.now()): Promise<{ run: any; existing: boolean }> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ValidationError("Run payload must be a JSON object");
    }
    assertAllowedKeys(
      raw as any,
      new Set([
        "runId",
        "tenantId",
        "resourceId",
        "source",
        "sourceResourceId",
        "scheduleId",
        "idempotencyKey",
        "windowStart",
        "windowEnd",
        "cursor",
        "status",
        "maxRetries",
        "errorClass",
      ]),
      "run"
    );

    const tenantId = requireNonEmptyString(raw.tenantId, "tenantId", 128);
    const resourceId = requireNonEmptyString(raw.resourceId, "resourceId", 128);
    const source = requireNonEmptyString(raw.source, "source", 128);
    const sourceResourceId = requireNonEmptyString(raw.sourceResourceId, "sourceResourceId", 256);
    const idempotencyKey = requireNonEmptyString(raw.idempotencyKey, "idempotencyKey", 256);
    const windowStart = requireNonEmptyString(raw.windowStart, "windowStart", 64);
    const windowEnd = requireNonEmptyString(raw.windowEnd, "windowEnd", 64);
    const status: RunStatus = (raw.status ?? "planned") as RunStatus;
    if (!RUN_STATUSES.has(status)) {
      throw new ValidationError(`Invalid run status '${status}'`);
    }

    const resource = await this.db
      .prepare("SELECT entity_urn FROM ms_resources WHERE tenant_id = ? AND resource_id = ?")
      .bind(tenantId, resourceId)
      .first<any>();
    if (!resource) {
      throw new NotFoundError(`Resource '${resourceId}' not found for tenant '${tenantId}'`);
    }

    const requestDigest = await sha256Hex(
      canonicalJson({ tenantId, resourceId, source, sourceResourceId, windowStart, windowEnd, scheduleId: raw.scheduleId ?? null })
    );

    const existing = await this.db
      .prepare("SELECT * FROM ms_runs WHERE tenant_id = ? AND idempotency_key = ?")
      .bind(tenantId, idempotencyKey)
      .first<any>();

    if (existing) {
      if (existing.request_digest !== requestDigest) {
        throw new ConflictError(`Run idempotencyKey '${idempotencyKey}' reused with different parameters`);
      }
      return { run: this.mapRunRow(existing), existing: true };
    }

    const runId = raw.runId ? requireNonEmptyString(raw.runId, "runId", 128) : `run_${crypto.randomUUID()}`;
    const maxRetries = typeof raw.maxRetries === "number" && raw.maxRetries >= 0 ? Math.min(raw.maxRetries, 10) : 3;

    await this.db
      .prepare(
        `INSERT INTO ms_runs (
           run_id, tenant_id, resource_id, source, source_resource_id, schedule_id,
           idempotency_key, request_digest, window_start, window_end, cursor, status,
           retry_count, max_retries, error_class, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
      )
      .bind(
        runId,
        tenantId,
        resourceId,
        source,
        sourceResourceId,
        raw.scheduleId ?? null,
        idempotencyKey,
        requestDigest,
        windowStart,
        windowEnd,
        raw.cursor ?? null,
        status,
        maxRetries,
        raw.errorClass ?? null,
        now,
        now
      )
      .run();

    await this.appendEvent(tenantId, resourceId, resource.entity_urn, "run.updated", { runId, source, status }, now);

    const created = await this.db.prepare("SELECT * FROM ms_runs WHERE run_id = ?").bind(runId).first<any>();
    return { run: this.mapRunRow(created), existing: false };
  }

  public async recordAttempt(raw: AttemptInput, now = Date.now()): Promise<any> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ValidationError("Attempt payload must be a JSON object");
    }
    assertAllowedKeys(raw as any, new Set(["attemptId", "tenantId", "runId", "status", "cursor", "errorClass"]), "attempt");

    const tenantId = requireNonEmptyString(raw.tenantId, "tenantId", 128);
    const runId = requireNonEmptyString(raw.runId, "runId", 128);
    const status = requireNonEmptyString(raw.status, "status", 32);
    if (!ATTEMPT_STATUSES.has(status)) {
      throw new ValidationError(`Invalid attempt status '${status}'`);
    }

    const run = await this.db
      .prepare("SELECT * FROM ms_runs WHERE run_id = ? AND tenant_id = ?")
      .bind(runId, tenantId)
      .first<any>();
    if (!run) {
      throw new NotFoundError(`Run '${runId}' not found for tenant '${tenantId}'`);
    }

    const resource = await this.db
      .prepare("SELECT entity_urn FROM ms_resources WHERE tenant_id = ? AND resource_id = ?")
      .bind(tenantId, run.resource_id)
      .first<any>();

    const countRow = await this.db
      .prepare("SELECT COUNT(*) as cnt FROM ms_attempts WHERE run_id = ?")
      .bind(runId)
      .first<any>();
    const attemptNumber = Number(countRow?.cnt ?? 0) + 1;
    const attemptId = raw.attemptId ? requireNonEmptyString(raw.attemptId, "attemptId", 128) : `att_${crypto.randomUUID()}`;
    const finishedAt = status === "running" ? null : now;
    const nextRetryCount = status === "failed" || status === "partial" ? Number(run.retry_count) + 1 : Number(run.retry_count);
    const nextCursor = raw.cursor ?? run.cursor ?? null;

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO ms_attempts (attempt_id, run_id, tenant_id, attempt_number, status, cursor, error_class, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(attemptId, runId, tenantId, attemptNumber, status, nextCursor, raw.errorClass ?? null, now, finishedAt),
      this.db
        .prepare(
          `UPDATE ms_runs
           SET status = ?, cursor = COALESCE(?, cursor), retry_count = ?, error_class = ?, updated_at = ?
           WHERE run_id = ? AND tenant_id = ?`
        )
        .bind(status, raw.cursor ?? null, nextRetryCount, raw.errorClass ?? null, now, runId, tenantId),
      this.db
        .prepare(
          `INSERT INTO ms_events (tenant_id, resource_id, entity_urn, event_type, payload_json, created_at)
           VALUES (?, ?, ?, 'run.updated', ?, ?)`
        )
        .bind(
          tenantId,
          run.resource_id,
          resource?.entity_urn ?? `site:${tenantId}:${run.resource_id}`,
          JSON.stringify({ runId, attemptId, attemptNumber, source: run.source, status, cursor: nextCursor, errorClass: raw.errorClass ?? null }),
          now
        ),
    ]);

    return {
      attemptId,
      runId,
      tenantId,
      attemptNumber,
      status,
      cursor: raw.cursor ?? run.cursor ?? null,
      errorClass: raw.errorClass ?? null,
      startedAt: now,
      finishedAt,
    };
  }

  public async getRun(tenantId: string, runId: string): Promise<any> {
    const run = await this.db
      .prepare("SELECT * FROM ms_runs WHERE run_id = ? AND tenant_id = ?")
      .bind(runId, tenantId)
      .first<any>();
    if (!run) throw new NotFoundError(`Run '${runId}' not found`);

    const attemptsRes = await this.db
      .prepare("SELECT * FROM ms_attempts WHERE run_id = ? AND tenant_id = ? ORDER BY attempt_number ASC")
      .bind(runId, tenantId)
      .all<any>();

    return {
      ...this.mapRunRow(run),
      attempts: (attemptsRes.results || []).map((a) => ({
        attemptId: a.attempt_id,
        attemptNumber: a.attempt_number,
        status: a.status,
        cursor: a.cursor,
        errorClass: a.error_class,
        startedAt: a.started_at,
        finishedAt: a.finished_at,
      })),
    };
  }

  private async prefetchIngestState(
    tenantId: string,
    groups: Array<Record<string, any>>
  ): Promise<{
    defCache: Map<string, DefinitionRecord>;
    resourceMap: Map<string, any>;
    existingRunByIdMap: Map<string, any>;
    existingRunByIdemMap: Map<string, any>;
    existingEvMap: Map<string, any>;
    existingObsMap: Map<string, { obs_id: string; payload_digest: string }>;
    seenBatchKeys: Map<string, string>;
    seenEvidence: Map<string, { tenantId: string; resourceId: string; sha256: string; uriPointer: string; byteSize: number; mediaType: string }>;
    seenRuns: Map<string, { tenantId: string; resourceId: string; source: string; idempotencyKey: string; requestDigest: string }>;
    seenRunIdemKeys: Map<string, { runId: string; requestDigest: string }>;
    seenBatchDigests: Set<string>;
    statements: any[];
  }> {
    const defCache = new Map<string, DefinitionRecord>();
    const resourceMap = new Map<string, any>();
    const existingRunByIdMap = new Map<string, any>();
    const existingRunByIdemMap = new Map<string, any>();
    const existingEvMap = new Map<string, any>();
    const existingObsMap = new Map<string, { obs_id: string; payload_digest: string }>();

    const resourceIds = new Set<string>();
    const runIds = new Set<string>();
    const runIdemKeys = new Set<string>();
    const evidenceIds = new Set<string>();
    const obsIdemKeys = new Set<string>();

    for (const grp of groups) {
      if (!grp || typeof grp !== "object" || Array.isArray(grp)) continue;
      if (typeof grp.resourceId === "string" && grp.resourceId.trim()) resourceIds.add(grp.resourceId.trim());
      if (typeof grp.runId === "string" && grp.runId.trim()) runIds.add(grp.runId.trim());
      if (typeof grp.runIdempotencyKey === "string" && grp.runIdempotencyKey.trim()) {
        runIdemKeys.add(grp.runIdempotencyKey.trim());
      }
      if (grp.evidence && typeof grp.evidence === "object" && typeof grp.evidence.evidenceId === "string" && grp.evidence.evidenceId.trim()) {
        evidenceIds.add(grp.evidence.evidenceId.trim());
      }
      if (Array.isArray(grp.observations)) {
        for (const obs of grp.observations) {
          if (obs && typeof obs === "object" && typeof obs.idempotencyKey === "string" && obs.idempotencyKey.trim()) {
            obsIdemKeys.add(obs.idempotencyKey.trim());
          }
        }
      }
    }

    const defRows = await this.db
      .prepare("SELECT * FROM ms_definitions WHERE tenant_id = ?")
      .bind(tenantId)
      .all<any>();
    for (const defRow of defRows.results || []) {
      const defKey = JSON.stringify([tenantId, defRow.metric_id, defRow.version]);
      defCache.set(defKey, {
        tenantId: defRow.tenant_id,
        metricId: defRow.metric_id,
        version: defRow.version,
        family: defRow.family,
        unit: defRow.unit,
        valueType: defRow.value_type,
        grain: defRow.grain,
        windowTz: defRow.window_tz,
        dimensionsSchema: JSON.parse(defRow.dimensions_schema_json),
        numeratorRule: defRow.numerator_rule,
        denominatorRule: defRow.denominator_rule,
        exclusionsRule: defRow.exclusions_rule,
        aggregationRule: defRow.aggregation_rule,
        comparabilityKey: defRow.comparability_key,
        createdAt: defRow.created_at,
      });
    }

    const rids = [...resourceIds];
    for (let i = 0; i < rids.length; i += MAX_IN_CLAUSE_ITEMS) {
      const chunk = rids.slice(i, i + MAX_IN_CLAUSE_ITEMS);
      const placeholders = chunk.map(() => "?").join(", ");
      const res = await this.db
        .prepare(`SELECT resource_id, entity_urn, source_resource_id FROM ms_resources WHERE tenant_id = ? AND resource_id IN (${placeholders})`)
        .bind(tenantId, ...chunk)
        .all<any>();
      for (const row of res.results || []) {
        resourceMap.set(row.resource_id, row);
      }
    }

    const rIds = [...runIds];
    for (let i = 0; i < rIds.length; i += MAX_IN_CLAUSE_ITEMS) {
      const chunk = rIds.slice(i, i + MAX_IN_CLAUSE_ITEMS);
      const placeholders = chunk.map(() => "?").join(", ");
      const res = await this.db
        .prepare(`SELECT * FROM ms_runs WHERE run_id IN (${placeholders})`)
        .bind(...chunk)
        .all<any>();
      for (const row of res.results || []) {
        existingRunByIdMap.set(row.run_id, row);
      }
    }

    const rIdems = [...runIdemKeys];
    for (let i = 0; i < rIdems.length; i += MAX_IN_CLAUSE_ITEMS) {
      const chunk = rIdems.slice(i, i + MAX_IN_CLAUSE_ITEMS);
      const placeholders = chunk.map(() => "?").join(", ");
      const res = await this.db
        .prepare(`SELECT run_id, idempotency_key, request_digest FROM ms_runs WHERE tenant_id = ? AND idempotency_key IN (${placeholders})`)
        .bind(tenantId, ...chunk)
        .all<any>();
      for (const row of res.results || []) {
        existingRunByIdemMap.set(row.idempotency_key, row);
      }
    }

    const evIds = [...evidenceIds];
    for (let i = 0; i < evIds.length; i += MAX_IN_CLAUSE_ITEMS) {
      const chunk = evIds.slice(i, i + MAX_IN_CLAUSE_ITEMS);
      const placeholders = chunk.map(() => "?").join(", ");
      const res = await this.db
        .prepare(`SELECT * FROM ms_evidence WHERE evidence_id IN (${placeholders})`)
        .bind(...chunk)
        .all<any>();
      for (const row of res.results || []) {
        existingEvMap.set(row.evidence_id, row);
      }
    }

    const oKeys = [...obsIdemKeys];
    for (let i = 0; i < oKeys.length; i += MAX_IN_CLAUSE_ITEMS) {
      const chunk = oKeys.slice(i, i + MAX_IN_CLAUSE_ITEMS);
      const placeholders = chunk.map(() => "?").join(", ");
      const res = await this.db
        .prepare(`SELECT obs_id, idempotency_key, payload_digest FROM ms_observations WHERE tenant_id = ? AND idempotency_key IN (${placeholders})`)
        .bind(tenantId, ...chunk)
        .all<any>();
      for (const row of res.results || []) {
        existingObsMap.set(row.idempotency_key, { obs_id: row.obs_id, payload_digest: row.payload_digest });
      }
    }

    return {
      defCache,
      resourceMap,
      existingRunByIdMap,
      existingRunByIdemMap,
      existingEvMap,
      existingObsMap,
      seenBatchKeys: new Map<string, string>(),
      seenEvidence: new Map(),
      seenRuns: new Map(),
      seenRunIdemKeys: new Map(),
      seenBatchDigests: new Set<string>(),
      statements: [] as any[],
    };
  }

  public async ingestBatch(raw: IngestBatchInput, now = Date.now()): Promise<{
    runId: string;
    evidenceId: string;
    inserted: number;
    replayedNoop: number;
    coverageStatus: string | null;
  }> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ValidationError("Ingest payload must be a JSON object");
    }
    const tenantId = requireNonEmptyString(raw.tenantId, "tenantId", 128);
    if (!Array.isArray(raw.observations)) {
      throw new ValidationError("Field 'observations' must be an array");
    }
    if (raw.observations.length > MAX_BATCH_OBSERVATIONS) {
      throw new ValidationError(`Batch exceeds maximum size (${MAX_BATCH_OBSERVATIONS} observations)`);
    }
    const shared = await this.prefetchIngestState(tenantId, [raw as any]);
    const res = await this.prepareIngestGroup(
      raw as any,
      { maxObservations: MAX_BATCH_OBSERVATIONS, allowInlineRunCreate: false },
      shared,
      now
    );
    if (shared.statements.length > 0) {
      await this.db.batch(shared.statements);
    }
    return res;
  }

  public async ingestAtomicBatch(raw: IngestAtomicBatchInput, now = Date.now()): Promise<{
    inserted: number;
    replayedNoop: number;
    groups: Array<{
      runId: string;
      evidenceId: string;
      inserted: number;
      replayedNoop: number;
      coverageStatus: string | null;
    }>;
  }> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ValidationError("Atomic ingest payload must be a JSON object");
    }
    assertAllowedKeys(raw as any, new Set(["tenantId", "groups"]), "ingestAtomic");
    const tenantId = requireNonEmptyString(raw.tenantId, "tenantId", 128);
    if (!Array.isArray(raw.groups) || raw.groups.length === 0 || raw.groups.length > MAX_ATOMIC_GROUPS) {
      throw new ValidationError(`Field 'groups' must contain 1 to ${MAX_ATOMIC_GROUPS} groups`);
    }

    let totalObservations = 0;
    for (let gIdx = 0; gIdx < raw.groups.length; gIdx++) {
      const grp = raw.groups[gIdx];
      if (!grp || typeof grp !== "object" || Array.isArray(grp)) {
        throw new ValidationError(`groups[${gIdx}] must be a JSON object`);
      }
      if (!Array.isArray(grp.observations)) {
        throw new ValidationError(`groups[${gIdx}].observations must be an array`);
      }
      totalObservations += grp.observations.length;
    }
    if (totalObservations > MAX_ATOMIC_OBSERVATIONS) {
      throw new ValidationError(`Atomic batch exceeds maximum size (${MAX_ATOMIC_OBSERVATIONS} observations)`);
    }

    const shared = await this.prefetchIngestState(tenantId, raw.groups as any);

    const groupResults: Array<{
      runId: string;
      evidenceId: string;
      inserted: number;
      replayedNoop: number;
      coverageStatus: string | null;
    }> = [];
    let totalInserted = 0;
    let totalReplayedNoop = 0;

    for (const grp of raw.groups) {
      const res = await this.prepareIngestGroup(
        { ...grp, tenantId } as any,
        { maxObservations: MAX_ATOMIC_OBSERVATIONS, allowInlineRunCreate: true },
        shared,
        now
      );
      groupResults.push(res);
      totalInserted += res.inserted;
      totalReplayedNoop += res.replayedNoop;
    }

    if (shared.statements.length > 0) {
      await this.db.batch(shared.statements);
    }

    return {
      inserted: totalInserted,
      replayedNoop: totalReplayedNoop,
      groups: groupResults,
    };
  }

  private async prepareIngestGroup(
    raw: IngestBatchInput & { runIdempotencyKey?: string; sourceResourceId?: string },
    opts: { maxObservations: number; allowInlineRunCreate: boolean },
    shared: {
      defCache: Map<string, DefinitionRecord>;
      resourceMap: Map<string, any>;
      existingRunByIdMap: Map<string, any>;
      existingRunByIdemMap: Map<string, any>;
      existingEvMap: Map<string, any>;
      existingObsMap: Map<string, { obs_id: string; payload_digest: string }>;
      seenBatchKeys: Map<string, string>;
      seenEvidence: Map<string, { tenantId: string; resourceId: string; sha256: string; uriPointer: string; byteSize: number; mediaType: string }>;
      seenRuns: Map<string, { tenantId: string; resourceId: string; source: string; idempotencyKey: string; requestDigest: string }>;
      seenRunIdemKeys: Map<string, { runId: string; requestDigest: string }>;
      seenBatchDigests: Set<string>;
      statements: any[];
    },
    now: number
  ): Promise<{
    runId: string;
    evidenceId: string;
    inserted: number;
    replayedNoop: number;
    coverageStatus: string | null;
  }> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ValidationError("Ingest payload must be a JSON object");
    }
    const allowedKeys = new Set([
      "tenantId",
      "resourceId",
      "source",
      "runId",
      "windowStart",
      "windowEnd",
      "cursor",
      "runStatus",
      "evidence",
      "observations",
      "coverage",
    ]);
    if (opts.allowInlineRunCreate) {
      allowedKeys.add("runIdempotencyKey");
      allowedKeys.add("sourceResourceId");
    }
    assertAllowedKeys(raw as any, allowedKeys, "ingest");

    const tenantId = requireNonEmptyString(raw.tenantId, "tenantId", 128);
    const resourceId = requireNonEmptyString(raw.resourceId, "resourceId", 128);
    const source = requireNonEmptyString(raw.source, "source", 128);
    const runId = requireNonEmptyString(raw.runId, "runId", 128);
    const windowStart = requireNonEmptyString(raw.windowStart, "windowStart", 64);
    const windowEnd = requireNonEmptyString(raw.windowEnd, "windowEnd", 64);

    if (!Array.isArray(raw.observations)) {
      throw new ValidationError("Field 'observations' must be an array");
    }
    if (raw.observations.length > opts.maxObservations) {
      throw new ValidationError(`Batch exceeds maximum size (${opts.maxObservations} observations)`);
    }

    // Validate resource belongs to tenant (using prefetched state)
    const resource = shared.resourceMap.get(resourceId);
    if (!resource) throw new NotFoundError(`Resource '${resourceId}' not found for tenant '${tenantId}'`);

    // Validate or stage run creation atomically inside the same batch transaction
    let needsRunInsert = false;
    let runInsertParams: { sourceResourceId: string; idempotencyKey: string; requestDigest: string } | null = null;
    const existingRun = shared.existingRunByIdMap.get(runId);
    if (existingRun) {
      if (existingRun.tenant_id !== tenantId || existingRun.resource_id !== resourceId || existingRun.source !== source) {
        if (!opts.allowInlineRunCreate) {
          throw new NotFoundError(`Run '${runId}' not found for tenant '${tenantId}' / resource '${resourceId}'`);
        }
        throw new ConflictError(`Run '${runId}' already exists with different tenant, resource, or source`);
      }
      if (opts.allowInlineRunCreate && raw.runIdempotencyKey !== undefined) {
        const runIdem = requireNonEmptyString(raw.runIdempotencyKey, "runIdempotencyKey", 256);
        const srcRid = raw.sourceResourceId
          ? requireNonEmptyString(raw.sourceResourceId, "sourceResourceId", 256)
          : String(resource.source_resource_id);
        const reqDigest = await sha256Hex(
          canonicalJson({ tenantId, resourceId, source, sourceResourceId: srcRid, windowStart, windowEnd, scheduleId: null })
        );
        if (existingRun.idempotency_key !== runIdem || existingRun.request_digest !== reqDigest) {
          throw new ConflictError(`Run '${runId}' conflicts with existing run parameters`);
        }
      }
    } else if (!opts.allowInlineRunCreate) {
      throw new NotFoundError(`Run '${runId}' not found for tenant '${tenantId}' / resource '${resourceId}'`);
    } else {
      const runIdem = requireNonEmptyString(raw.runIdempotencyKey, "runIdempotencyKey", 256);
      const srcRid = raw.sourceResourceId
        ? requireNonEmptyString(raw.sourceResourceId, "sourceResourceId", 256)
        : String(resource.source_resource_id);
      const reqDigest = await sha256Hex(
        canonicalJson({ tenantId, resourceId, source, sourceResourceId: srcRid, windowStart, windowEnd, scheduleId: null })
      );
      const existingByIdem = shared.existingRunByIdemMap.get(runIdem);
      if (existingByIdem) {
        if (existingByIdem.run_id !== runId || existingByIdem.request_digest !== reqDigest) {
          throw new ConflictError(`Run idempotencyKey '${runIdem}' reused with different parameters`);
        }
      }
      const stagedRun = shared.seenRuns.get(runId);
      if (stagedRun) {
        if (
          stagedRun.tenantId !== tenantId ||
          stagedRun.resourceId !== resourceId ||
          stagedRun.source !== source ||
          stagedRun.idempotencyKey !== runIdem ||
          stagedRun.requestDigest !== reqDigest
        ) {
          throw new ConflictError(`Run '${runId}' conflicts with another group in the atomic batch`);
        }
      } else {
        const stagedIdem = shared.seenRunIdemKeys.get(runIdem);
        if (stagedIdem && (stagedIdem.runId !== runId || stagedIdem.requestDigest !== reqDigest)) {
          throw new ConflictError(`Run idempotencyKey '${runIdem}' conflicts inside atomic batch`);
        }
        shared.seenRuns.set(runId, { tenantId, resourceId, source, idempotencyKey: runIdem, requestDigest: reqDigest });
        shared.seenRunIdemKeys.set(runIdem, { runId, requestDigest: reqDigest });
        needsRunInsert = true;
        runInsertParams = { sourceResourceId: srcRid, idempotencyKey: runIdem, requestDigest: reqDigest };
      }
    }

    // Validate immutable evidence handle
    const ev = raw.evidence;
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
      throw new ValidationError("Field 'evidence' must be an object");
    }
    assertAllowedKeys(
      ev as any,
      new Set([
        "evidenceId",
        "uriPointer",
        "sha256",
        "byteSize",
        "mediaType",
        "privacyClass",
        "retentionClass",
        "collectedAt",
        "sourceAsOf",
        "adapterName",
        "adapterVersion",
      ]),
      "evidence"
    );
    const evidenceId = requireNonEmptyString(ev.evidenceId, "evidence.evidenceId", 128);
    const uriPointer = validateEvidencePointer(ev.uriPointer);
    const sha256 = requireNonEmptyString(ev.sha256, "evidence.sha256", 64).toLowerCase();
    if (!SHA256_RE.test(sha256)) {
      throw new ValidationError("evidence.sha256 must be a 64-char hex digest");
    }
    if (typeof ev.byteSize !== "number" || !Number.isInteger(ev.byteSize) || ev.byteSize < 0) {
      throw new ValidationError("evidence.byteSize must be a non-negative integer");
    }
    const mediaType = requireNonEmptyString(ev.mediaType, "evidence.mediaType", 128);
    const privacyClass = requireNonEmptyString(ev.privacyClass, "evidence.privacyClass", 32);
    if (!PRIVACY_CLASSES.has(privacyClass)) {
      throw new ValidationError(`Invalid evidence.privacyClass '${privacyClass}'`);
    }
    const retentionClass = requireNonEmptyString(ev.retentionClass, "evidence.retentionClass", 64);
    const collectedAt = requireNonEmptyString(ev.collectedAt, "evidence.collectedAt", 64);
    const sourceAsOf = requireNonEmptyString(ev.sourceAsOf, "evidence.sourceAsOf", 64);
    const adapterName = requireNonEmptyString(ev.adapterName, "evidence.adapterName", 128);
    const adapterVersion = requireNonEmptyString(ev.adapterVersion, "evidence.adapterVersion", 64);

    // Check existing evidence immutability (both in-batch and DB)
    const stagedEv = shared.seenEvidence.get(evidenceId);
    if (stagedEv) {
      if (
        stagedEv.tenantId !== tenantId ||
        stagedEv.resourceId !== resourceId ||
        stagedEv.sha256 !== sha256 ||
        stagedEv.uriPointer !== uriPointer ||
        stagedEv.byteSize !== ev.byteSize ||
        stagedEv.mediaType !== mediaType
      ) {
        throw new ConflictError(`Evidence '${evidenceId}' conflicts within atomic batch`);
      }
    }
    const existingEv = shared.existingEvMap.get(evidenceId);
    if (existingEv) {
      if (
        existingEv.tenant_id !== tenantId ||
        existingEv.resource_id !== resourceId ||
        existingEv.sha256 !== sha256 ||
        existingEv.uri_pointer !== uriPointer ||
        existingEv.byte_size !== ev.byteSize
      ) {
        throw new ConflictError(`Evidence '${evidenceId}' already exists with conflicting digest or scope`);
      }
    }

    // Validate coverage if present
    let coverage: CoverageInput | null = null;
    if (raw.coverage !== undefined) {
      if (!raw.coverage || typeof raw.coverage !== "object" || Array.isArray(raw.coverage)) {
        throw new ValidationError("Field 'coverage' must be an object");
      }
      assertAllowedKeys(
        raw.coverage as any,
        new Set([
          "status",
          "expectedCadenceSec",
          "expectedLagSec",
          "sourceTotalText",
          "interpretedTotalText",
          "discrepancyText",
          "reconciliationStatus",
          "freshnessAt",
        ]),
        "coverage"
      );
      if (!COVERAGE_STATUSES.has(raw.coverage.status)) {
        throw new ValidationError(`Invalid coverage.status '${raw.coverage.status}'`);
      }
      if (raw.coverage.reconciliationStatus && !RECONCILIATION_STATUSES.has(raw.coverage.reconciliationStatus)) {
        throw new ValidationError(`Invalid coverage.reconciliationStatus '${raw.coverage.reconciliationStatus}'`);
      }
      coverage = raw.coverage;
    }

    // Never synthesize zero on failed/blocked/not-collected/stale
    if (
      coverage &&
      ["failed", "blocked", "not-collected", "stale"].includes(coverage.status) &&
      raw.observations.length > 0
    ) {
      throw new ValidationError(`Cannot ingest observations under coverage status '${coverage.status}' (missing must never synthesize zero)`);
    }

    // Pre-validate every observation and check definitions + idempotency conflicts BEFORE writing anything (atomic rollback)
    const defCache = shared.defCache;
    const preparedObs: Array<{
      obsId: string;
      def: DefinitionRecord;
      obs: ObservationInput;
      dimensionsJson: string;
      dimensionsHash: string;
      valueNum: number | null;
      valueText: string | null;
      payloadDigest: string;
      replayedNoop: boolean;
    }> = [];
    const seenBatchKeys = shared.seenBatchKeys;

    const obsAllowedKeys = new Set([
      "obsId",
      "metricId",
      "definitionVersion",
      "windowStart",
      "windowEnd",
      "windowTz",
      "grain",
      "dimensions",
      "valueNum",
      "valueText",
      "currency",
      "billingDate",
      "grossOrNet",
      "refundText",
      "creditText",
      "taxText",
      "collectionRequestBudget",
      "numerator",
      "denominator",
      "exclusions",
      "sampleTime",
      "gaugeReducer",
      "counterStart",
      "counterEnd",
      "counterReset",
      "interpretationVersion",
      "sourceRevision",
      "sourceAsOf",
      "idempotencyKey",
    ]);

    for (let i = 0; i < raw.observations.length; i++) {
      const obs = raw.observations[i];
      if (!obs || typeof obs !== "object" || Array.isArray(obs)) {
        throw new ValidationError(`observations[${i}] must be a JSON object`);
      }
      assertAllowedKeys(obs as any, obsAllowedKeys, `observations[${i}]`);

      const metricId = requireNonEmptyString(obs.metricId, `observations[${i}].metricId`, 128);
      const defVer = requireNonEmptyString(obs.definitionVersion, `observations[${i}].definitionVersion`, 64);
      const defKey = JSON.stringify([tenantId, metricId, defVer]);
      let def = defCache.get(defKey);
      if (!def) {
        const defRow = await this.db
          .prepare("SELECT * FROM ms_definitions WHERE tenant_id = ? AND metric_id = ? AND version = ?")
          .bind(tenantId, metricId, defVer)
          .first<any>();
        if (!defRow) {
          throw new ValidationError(`Unknown metric definition '${metricId}@${defVer}' for tenant '${tenantId}'`);
        }
        def = {
          tenantId: defRow.tenant_id,
          metricId: defRow.metric_id,
          version: defRow.version,
          family: defRow.family,
          unit: defRow.unit,
          valueType: defRow.value_type,
          grain: defRow.grain,
          windowTz: defRow.window_tz,
          dimensionsSchema: JSON.parse(defRow.dimensions_schema_json),
          numeratorRule: defRow.numerator_rule,
          denominatorRule: defRow.denominator_rule,
          exclusionsRule: defRow.exclusions_rule,
          aggregationRule: defRow.aggregation_rule,
          comparabilityKey: defRow.comparability_key,
          createdAt: defRow.created_at,
        };
        defCache.set(defKey, def);
      }

      const obsWindowStart = requireNonEmptyString(obs.windowStart, `observations[${i}].windowStart`, 64);
      const obsWindowEnd = requireNonEmptyString(obs.windowEnd, `observations[${i}].windowEnd`, 64);
      const obsWindowTz = requireNonEmptyString(obs.windowTz, `observations[${i}].windowTz`, 64);
      const obsGrain = requireNonEmptyString(obs.grain, `observations[${i}].grain`, 64);
      if (obsWindowTz !== def.windowTz) {
        throw new ValidationError(`observations[${i}].windowTz '${obsWindowTz}' does not match definition '${def.windowTz}'`);
      }
      if (obsGrain !== def.grain) {
        throw new ValidationError(`observations[${i}].grain '${obsGrain}' does not match definition '${def.grain}'`);
      }

      const normalizedDims = validateDimensions(obs.dimensions, def.dimensionsSchema);
      const dimensionsJson = canonicalJson(normalizedDims);
      const dimensionsHash = await sha256Hex(dimensionsJson);

      let valueNum: number | null = null;
      let valueText: string | null = null;

      if (def.valueType === "decimal_string") {
        if (obs.valueNum !== undefined && obs.valueNum !== null) {
          throw new ValidationError(`observations[${i}] must use 'valueText' decimal string, not binary float 'valueNum'`);
        }
        valueText = assertValidDecimalString(obs.valueText, `observations[${i}].valueText`);
      } else if (def.valueType === "integer") {
        if (typeof obs.valueNum !== "number" || !Number.isInteger(obs.valueNum)) {
          throw new ValidationError(`observations[${i}].valueNum must be an integer`);
        }
        valueNum = obs.valueNum;
      } else if (def.valueType === "gauge") {
        if (typeof obs.valueNum !== "number" || !Number.isFinite(obs.valueNum)) {
          throw new ValidationError(`observations[${i}].valueNum must be a finite number for gauge`);
        }
        if (!obs.sampleTime || typeof obs.sampleTime !== "string") {
          throw new ValidationError(`observations[${i}].sampleTime is required for gauge metrics`);
        }
        if (!obs.gaugeReducer || !GAUGE_REDUCERS.has(obs.gaugeReducer)) {
          throw new ValidationError(`observations[${i}].gaugeReducer must be one of last|min|max|mean`);
        }
        if (obs.gaugeReducer !== def.aggregationRule) {
          throw new ValidationError(
            `observations[${i}].gaugeReducer '${obs.gaugeReducer}' contradicts metric definition aggregationRule '${def.aggregationRule}'`
          );
        }
        valueNum = obs.valueNum;
      } else if (def.valueType === "counter") {
        if (typeof obs.counterStart !== "number" || !Number.isFinite(obs.counterStart) || typeof obs.counterEnd !== "number" || !Number.isFinite(obs.counterEnd)) {
          throw new ValidationError(`observations[${i}] counter metrics require numeric counterStart and counterEnd`);
        }
        const reset = Boolean(obs.counterReset);
        if (!reset && obs.counterEnd < obs.counterStart) {
          throw new ValidationError(`observations[${i}] counterEnd < counterStart requires explicit counterReset=true`);
        }
        valueNum = reset ? obs.counterEnd : obs.counterEnd - obs.counterStart;
      }

      if (def.family === "spend") {
        if (!obs.currency || !CURRENCY_RE.test(obs.currency)) {
          throw new ValidationError(`observations[${i}].currency must be a 3-letter ISO currency code`);
        }
        requireNonEmptyString(obs.billingDate, `observations[${i}].billingDate`, 32);
        if (obs.grossOrNet && !["gross", "net"].includes(obs.grossOrNet)) {
          throw new ValidationError(`observations[${i}].grossOrNet must be 'gross' or 'net'`);
        }
        if (obs.refundText != null) assertValidDecimalString(obs.refundText, `observations[${i}].refundText`);
        if (obs.creditText != null) assertValidDecimalString(obs.creditText, `observations[${i}].creditText`);
        if (obs.taxText != null) assertValidDecimalString(obs.taxText, `observations[${i}].taxText`);
      }

      const interpretationVersion = requireNonEmptyString(obs.interpretationVersion, `observations[${i}].interpretationVersion`, 64);
      const obsSourceAsOf = requireNonEmptyString(obs.sourceAsOf, `observations[${i}].sourceAsOf`, 64);
      const idempotencyKey = requireNonEmptyString(obs.idempotencyKey, `observations[${i}].idempotencyKey`, 256);
      const sourceRevision = obs.sourceRevision ?? 1;
      if (!Number.isInteger(sourceRevision) || sourceRevision < 1) {
        throw new ValidationError(`observations[${i}].sourceRevision must be a positive integer`);
      }

      const payloadDigest = await sha256Hex(
        canonicalJson({
          tenantId,
          resourceId,
          source,
          evidenceSha256: sha256,
          metricId,
          definitionVersion: defVer,
          windowStart: obsWindowStart,
          windowEnd: obsWindowEnd,
          windowTz: obsWindowTz,
          grain: obsGrain,
          dimensions: normalizedDims,
          valueNum,
          valueText,
          currency: obs.currency ?? null,
          billingDate: obs.billingDate ?? null,
          grossOrNet: obs.grossOrNet ?? null,
          refundText: obs.refundText ?? null,
          creditText: obs.creditText ?? null,
          taxText: obs.taxText ?? null,
          collectionRequestBudget: obs.collectionRequestBudget ?? null,
          numerator: obs.numerator ?? null,
          denominator: obs.denominator ?? null,
          exclusions: obs.exclusions ?? null,
          sampleTime: obs.sampleTime ?? null,
          gaugeReducer: obs.gaugeReducer ?? null,
          counterStart: obs.counterStart ?? null,
          counterEnd: obs.counterEnd ?? null,
          counterReset: Boolean(obs.counterReset),
          interpretationVersion,
          sourceRevision,
          sourceAsOf: obsSourceAsOf,
        })
      );

      const priorBatchDigest = seenBatchKeys.get(idempotencyKey);
      if (priorBatchDigest !== undefined) {
        if (priorBatchDigest !== payloadDigest) {
          throw new ConflictError(`Duplicate idempotencyKey '${idempotencyKey}' inside batch with conflicting payload`);
        }
        preparedObs.push({
          obsId: obs.obsId || `obs_${crypto.randomUUID()}`,
          def,
          obs: { ...obs, sourceRevision },
          dimensionsJson,
          dimensionsHash,
          valueNum,
          valueText,
          payloadDigest,
          replayedNoop: true,
        });
        continue;
      }
      seenBatchKeys.set(idempotencyKey, payloadDigest);

      const existingObs = shared.existingObsMap.get(idempotencyKey);

      if (existingObs) {
        if (existingObs.payload_digest !== payloadDigest) {
          throw new ConflictError(`Observation idempotencyKey '${idempotencyKey}' conflicts with existing digest`);
        }
        preparedObs.push({
          obsId: existingObs.obs_id,
          def,
          obs: { ...obs, sourceRevision },
          dimensionsJson,
          dimensionsHash,
          valueNum,
          valueText,
          payloadDigest,
          replayedNoop: true,
        });
      } else {
        preparedObs.push({
          obsId: obs.obsId ? requireNonEmptyString(obs.obsId, `observations[${i}].obsId`, 128) : `obs_${crypto.randomUUID()}`,
          def,
          obs: { ...obs, sourceRevision },
          dimensionsJson,
          dimensionsHash,
          valueNum,
          valueText,
          payloadDigest,
          replayedNoop: false,
        });
      }
    }

    // Full-batch replay deduplication: if this exact ingest batch was already committed, return a true zero-mutation no-op
    // so replaying an older partial page never regresses run status, rewinds cursor, overwrites coverage, or emits duplicate events.
    const batchDigest = await sha256Hex(
      canonicalJson({
        tenantId,
        resourceId,
        source,
        runId,
        windowStart,
        windowEnd,
        cursor: raw.cursor ?? null,
        runStatus: raw.runStatus ?? null,
        evidenceId,
        evidenceSha256: sha256,
        coverage: coverage ?? null,
        observationDigests: preparedObs.map((p) => ({
          idempotencyKey: p.obs.idempotencyKey,
          payloadDigest: p.payloadDigest,
        })),
      })
    );

    const existingBatch = await this.db
      .prepare("SELECT * FROM ms_ingest_batches WHERE tenant_id = ? AND batch_digest = ?")
      .bind(tenantId, batchDigest)
      .first<any>();

    if (existingBatch || shared.seenBatchDigests.has(batchDigest)) {
      return {
        runId,
        evidenceId,
        inserted: 0,
        replayedNoop: preparedObs.length,
        coverageStatus: existingBatch?.coverage_status ?? coverage?.status ?? null,
      };
    }
    shared.seenBatchDigests.add(batchDigest);

    // Append statements into the shared atomic batch transaction (runs + evidence + observations + coverage + batch receipt + projection events)
    const statements = shared.statements;

    const nextRunStatus: RunStatus =
      raw.runStatus && RUN_STATUSES.has(raw.runStatus)
        ? raw.runStatus
        : coverage?.status === "partial"
          ? "partial"
          : coverage?.status === "failed"
            ? "failed"
            : coverage?.status === "blocked"
              ? "blocked"
              : "succeeded";

    if (needsRunInsert && runInsertParams) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO ms_runs (
               run_id, tenant_id, resource_id, source, source_resource_id, schedule_id,
               idempotency_key, request_digest, window_start, window_end, cursor, status,
               retry_count, max_retries, error_class, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, 3, NULL, ?, ?)`
          )
          .bind(
            runId,
            tenantId,
            resourceId,
            source,
            runInsertParams.sourceResourceId,
            runInsertParams.idempotencyKey,
            runInsertParams.requestDigest,
            windowStart,
            windowEnd,
            raw.cursor ?? null,
            nextRunStatus,
            now,
            now
          )
      );
      statements.push(
        this.db
          .prepare(
            `INSERT INTO ms_events (tenant_id, resource_id, entity_urn, event_type, payload_json, created_at)
             VALUES (?, ?, ?, 'run.updated', ?, ?)`
          )
          .bind(tenantId, resourceId, resource.entity_urn, JSON.stringify({ runId, source, status: nextRunStatus }), now)
      );
    }

    statements.push(
      this.db
        .prepare(
          `INSERT INTO ms_ingest_batches (tenant_id, batch_digest, run_id, evidence_id, observation_count, coverage_status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(tenantId, batchDigest, runId, evidenceId, preparedObs.length, coverage?.status ?? null, now)
    );

    if (!existingEv && !stagedEv) {
      shared.seenEvidence.set(evidenceId, {
        tenantId,
        resourceId,
        sha256,
        uriPointer,
        byteSize: ev.byteSize,
        mediaType,
      });
      statements.push(
        this.db
          .prepare(
            `INSERT INTO ms_evidence (
               evidence_id, tenant_id, resource_id, run_id, uri_pointer, sha256, byte_size,
               media_type, privacy_class, retention_class, collected_at, source_as_of,
               adapter_name, adapter_version, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            evidenceId,
            tenantId,
            resourceId,
            runId,
            uriPointer,
            sha256,
            ev.byteSize,
            mediaType,
            privacyClass,
            retentionClass,
            collectedAt,
            sourceAsOf,
            adapterName,
            adapterVersion,
            now
          )
      );
    }

    let inserted = 0;
    let replayedNoop = 0;
    for (const item of preparedObs) {
      if (item.replayedNoop) {
        replayedNoop += 1;
        continue;
      }
      inserted += 1;
      const o = item.obs;
      statements.push(
        this.db
          .prepare(
            `INSERT INTO ms_observations (
               obs_id, tenant_id, resource_id, source, run_id, evidence_id,
               metric_id, definition_version, comparability_key,
               window_start, window_end, window_tz, grain,
               dimensions_json, dimensions_hash,
               value_type, value_num, value_text,
               currency, billing_date, gross_or_net, refund_text, credit_text, tax_text, collection_request_budget,
               numerator, denominator, exclusions_json,
               sample_time, gauge_reducer, counter_start, counter_end, counter_reset,
               interpretation_version, source_revision, source_as_of,
               idempotency_key, payload_digest, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            item.obsId,
            tenantId,
            resourceId,
            source,
            runId,
            evidenceId,
            item.def.metricId,
            item.def.version,
            item.def.comparabilityKey,
            o.windowStart,
            o.windowEnd,
            o.windowTz,
            o.grain,
            item.dimensionsJson,
            item.dimensionsHash,
            item.def.valueType,
            item.valueNum,
            item.valueText,
            o.currency ?? null,
            o.billingDate ?? null,
            o.grossOrNet ?? null,
            o.refundText ?? null,
            o.creditText ?? null,
            o.taxText ?? null,
            o.collectionRequestBudget ?? null,
            o.numerator ?? null,
            o.denominator ?? null,
            o.exclusions ? canonicalJson(o.exclusions) : null,
            o.sampleTime ?? null,
            o.gaugeReducer ?? null,
            o.counterStart ?? null,
            o.counterEnd ?? null,
            o.counterReset ? 1 : 0,
            o.interpretationVersion,
            o.sourceRevision ?? 1,
            o.sourceAsOf,
            o.idempotencyKey,
            item.payloadDigest,
            now
          )
      );
    }

    if (coverage) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO ms_coverage (
               tenant_id, resource_id, source, window_start, window_end, status,
               expected_cadence_sec, expected_lag_sec, source_total_text, interpreted_total_text,
               discrepancy_text, reconciliation_status, last_run_id, freshness_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (tenant_id, resource_id, source, window_start, window_end) DO UPDATE SET
               status = excluded.status,
               expected_cadence_sec = COALESCE(excluded.expected_cadence_sec, ms_coverage.expected_cadence_sec),
               expected_lag_sec = COALESCE(excluded.expected_lag_sec, ms_coverage.expected_lag_sec),
               source_total_text = excluded.source_total_text,
               interpreted_total_text = excluded.interpreted_total_text,
               discrepancy_text = excluded.discrepancy_text,
               reconciliation_status = excluded.reconciliation_status,
               last_run_id = excluded.last_run_id,
               freshness_at = excluded.freshness_at,
               updated_at = excluded.updated_at`
          )
          .bind(
            tenantId,
            resourceId,
            source,
            windowStart,
            windowEnd,
            coverage.status,
            coverage.expectedCadenceSec ?? null,
            coverage.expectedLagSec ?? null,
            coverage.sourceTotalText ?? null,
            coverage.interpretedTotalText ?? null,
            coverage.discrepancyText ?? null,
            coverage.reconciliationStatus ?? "unknown",
            runId,
            coverage.freshnessAt ?? collectedAt,
            now
          )
      );
    }

    if (!needsRunInsert) {
      statements.push(
        this.db
          .prepare("UPDATE ms_runs SET status = ?, cursor = COALESCE(?, cursor), updated_at = ? WHERE run_id = ? AND tenant_id = ?")
          .bind(nextRunStatus, raw.cursor ?? null, now, runId, tenantId)
      );
    }

    if (inserted > 0) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO ms_events (tenant_id, resource_id, entity_urn, event_type, payload_json, created_at)
             VALUES (?, ?, ?, 'observation.recorded', ?, ?)`
          )
          .bind(
            tenantId,
            resourceId,
            resource.entity_urn,
            JSON.stringify({ runId, evidenceId, source, inserted, windowStart, windowEnd }),
            now
          )
      );
    }

    if (coverage) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO ms_events (tenant_id, resource_id, entity_urn, event_type, payload_json, created_at)
             VALUES (?, ?, ?, 'coverage.updated', ?, ?)`
          )
          .bind(
            tenantId,
            resourceId,
            resource.entity_urn,
            JSON.stringify({
              runId,
              source,
              windowStart,
              windowEnd,
              status: coverage.status,
              reconciliationStatus: coverage.reconciliationStatus ?? "unknown",
            }),
            now
          )
      );
    }

    return {
      runId,
      evidenceId,
      inserted,
      replayedNoop,
      coverageStatus: coverage?.status ?? null,
    };
  }

  public async querySeries(raw: SeriesQueryInput): Promise<{
    tenantId: string;
    resourceId: string;
    metricId: string;
    comparable: boolean;
    comparabilityKeys: string[];
    incompatibilityReason?: string;
    points: any[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const tenantId = requireNonEmptyString(raw.tenantId, "tenantId", 128);
    const resourceId = requireNonEmptyString(raw.resourceId, "resourceId", 128);
    const metricId = requireNonEmptyString(raw.metricId, "metricId", 128);
    const limit = clampLimit(raw.limit, 100);
    const offset = clampOffset(raw.offset);

    const where: string[] = ["tenant_id = ?", "resource_id = ?", "metric_id = ?"];
    const binds: unknown[] = [tenantId, resourceId, metricId];

    if (raw.definitionVersion) {
      where.push("definition_version = ?");
      binds.push(raw.definitionVersion);
    }
    if (raw.windowStart) {
      where.push("window_start >= ?");
      binds.push(raw.windowStart);
    }
    if (raw.windowEnd) {
      where.push("window_end <= ?");
      binds.push(raw.windowEnd);
    }
    if (raw.dimensions && Object.keys(raw.dimensions).length > 0) {
      const dimHash = await sha256Hex(canonicalJson(raw.dimensions));
      where.push("dimensions_hash = ?");
      binds.push(dimHash);
    }

    const rowsRes = await this.db
      .prepare(
        `SELECT * FROM ms_observations
         WHERE ${where.join(" AND ")}
         ORDER BY window_start ASC, window_end ASC, dimensions_hash ASC, source_revision DESC, created_at DESC`
      )
      .bind(...binds)
      .all<any>();

    const allRows = rowsRes.results || [];
    const effectiveComparabilityKeys = [
      ...new Set(
        allRows.map((r) => `${String(r.comparability_key)}|source=${String(r.source)}|currency=${String(r.currency ?? "")}`)
      ),
    ].sort();
    const comparable = effectiveComparabilityKeys.length <= 1;

    // Group by (window_start, window_end, source, currency, comparability_key, dimensions_hash)
    // so independent sources (e.g. GSC vs Bing) or currencies (USD vs EUR) never collapse into a false correction lineage.
    const grouped = new Map<string, any[]>();
    for (const r of allRows) {
      const key = `${r.window_start}|${r.window_end}|${r.source}|${r.currency ?? ""}|${r.comparability_key}|${r.dimensions_hash}`;
      const list = grouped.get(key) || [];
      list.push(r);
      grouped.set(key, list);
    }

    const mapped: any[] = [];
    for (const revisions of grouped.values()) {
      const latest = revisions[0];
      const lineage = revisions.map((rev) => ({
        obsId: rev.obs_id,
        sourceRevision: rev.source_revision,
        sourceAsOf: rev.source_as_of,
        evidenceId: rev.evidence_id,
        valueNum: rev.value_num,
        valueText: rev.value_text,
      }));
      if (raw.includeSuperseded) {
        for (const rev of revisions) {
          mapped.push(this.mapObservationRow(rev, lineage));
        }
      } else {
        mapped.push(this.mapObservationRow(latest, lineage));
      }
    }

    const paged = mapped.slice(offset, offset + limit);
    return {
      tenantId,
      resourceId,
      metricId,
      comparable,
      comparabilityKeys: effectiveComparabilityKeys,
      ...(comparable ? {} : { incompatibilityReason: "Multiple incompatible metric definition versions, sources, currencies, units, windows, or grains present; narrow filter to compare" }),
      points: paged,
      total: mapped.length,
      limit,
      offset,
    };
  }

  public async queryCoverage(raw: CoverageQueryInput): Promise<{ items: any[]; limit: number; offset: number }> {
    const tenantId = requireNonEmptyString(raw.tenantId, "tenantId", 128);
    const limit = clampLimit(raw.limit, 100);
    const offset = clampOffset(raw.offset);

    const where: string[] = ["tenant_id = ?"];
    const binds: unknown[] = [tenantId];

    if (raw.resourceId) {
      where.push("resource_id = ?");
      binds.push(raw.resourceId);
    }
    if (raw.source) {
      where.push("source = ?");
      binds.push(raw.source);
    }

    const res = await this.db
      .prepare(
        `SELECT * FROM ms_coverage
         WHERE ${where.join(" AND ")}
         ORDER BY window_start DESC, resource_id ASC, source ASC
         LIMIT ? OFFSET ?`
      )
      .bind(...binds, limit, offset)
      .all<any>();

    return {
      items: (res.results || []).map((r) => ({
        tenantId: r.tenant_id,
        resourceId: r.resource_id,
        source: r.source,
        windowStart: r.window_start,
        windowEnd: r.window_end,
        status: r.status,
        expectedCadenceSec: r.expected_cadence_sec,
        expectedLagSec: r.expected_lag_sec,
        sourceTotalText: r.source_total_text,
        interpretedTotalText: r.interpreted_total_text,
        discrepancyText: r.discrepancy_text,
        reconciliationStatus: r.reconciliation_status,
        lastRunId: r.last_run_id,
        freshnessAt: r.freshness_at,
        updatedAt: r.updated_at,
      })),
      limit,
      offset,
    };
  }

  /**
   * Returns safe immutable evidence metadata ONLY — never arbitrary file bytes or credentials.
   */
  public async getEvidenceMetadata(tenantId: string, evidenceId: string): Promise<any> {
    const row = await this.db
      .prepare("SELECT * FROM ms_evidence WHERE evidence_id = ? AND tenant_id = ?")
      .bind(evidenceId, tenantId)
      .first<any>();
    if (!row) throw new NotFoundError(`Evidence '${evidenceId}' not found`);
    return {
      evidenceId: row.evidence_id,
      tenantId: row.tenant_id,
      resourceId: row.resource_id,
      runId: row.run_id,
      uriPointer: row.uri_pointer,
      sha256: row.sha256,
      byteSize: row.byte_size,
      mediaType: row.media_type,
      privacyClass: row.privacy_class,
      retentionClass: row.retention_class,
      collectedAt: row.collected_at,
      sourceAsOf: row.source_as_of,
      adapterName: row.adapter_name,
      adapterVersion: row.adapter_version,
      createdAt: row.created_at,
    };
  }

  public async annotateWork(raw: AnnotationInput, now = Date.now()): Promise<any> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ValidationError("Annotation payload must be a JSON object");
    }
    assertAllowedKeys(
      raw as any,
      new Set(["annotationId", "tenantId", "resourceId", "podId", "kind", "commitSha", "prUrl", "summary", "occurredAt"]),
      "annotation"
    );

    const tenantId = requireNonEmptyString(raw.tenantId, "tenantId", 128);
    const resourceId = requireNonEmptyString(raw.resourceId, "resourceId", 128);
    const podId = requireNonEmptyString(raw.podId, "podId", 128);
    const kind = requireNonEmptyString(raw.kind, "kind", 32);
    if (!ANNOTATION_KINDS.has(kind)) {
      throw new ValidationError(`Invalid annotation kind '${kind}'`);
    }
    const summary = requireNonEmptyString(raw.summary, "summary", 512);
    const occurredAt = requireNonEmptyString(raw.occurredAt, "occurredAt", 64);

    const resource = await this.db
      .prepare("SELECT entity_urn FROM ms_resources WHERE tenant_id = ? AND resource_id = ?")
      .bind(tenantId, resourceId)
      .first<any>();
    if (!resource) throw new NotFoundError(`Resource '${resourceId}' not found for tenant '${tenantId}'`);

    const annotationId = raw.annotationId ? requireNonEmptyString(raw.annotationId, "annotationId", 128) : `ann_${crypto.randomUUID()}`;

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO ms_annotations (annotation_id, tenant_id, resource_id, entity_urn, pod_id, kind, commit_sha, pr_url, summary, occurred_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(annotationId, tenantId, resourceId, resource.entity_urn, podId, kind, raw.commitSha ?? null, raw.prUrl ?? null, summary, occurredAt, now),
      this.db
        .prepare(
          `INSERT INTO ms_events (tenant_id, resource_id, entity_urn, event_type, payload_json, created_at)
           VALUES (?, ?, ?, 'annotation.recorded', ?, ?)`
        )
        .bind(
          tenantId,
          resourceId,
          resource.entity_urn,
          JSON.stringify({ annotationId, podId, kind, commitSha: raw.commitSha ?? null, occurredAt, causal: false }),
          now
        ),
    ]);

    return {
      annotationId,
      tenantId,
      resourceId,
      entityUrn: resource.entity_urn,
      podId,
      kind,
      commitSha: raw.commitSha ?? null,
      prUrl: raw.prUrl ?? null,
      summary,
      occurredAt,
      causal: false,
      createdAt: now,
    };
  }

  /**
   * Worldview-ready ordered snapshot/delta projection feed.
   */
  public async queryEvents(raw: EventsQueryInput): Promise<{
    tenantId: string;
    sinceCursor: number;
    nextCursor: number;
    events: any[];
  }> {
    const tenantId = requireNonEmptyString(raw.tenantId, "tenantId", 128);
    const sinceCursor = typeof raw.sinceCursor === "number" && Number.isFinite(raw.sinceCursor) && raw.sinceCursor >= 0 ? Math.floor(raw.sinceCursor) : 0;
    const limit = clampLimit(raw.limit, 100);

    const where = ["tenant_id = ?", "cursor_id > ?"];
    const binds: unknown[] = [tenantId, sinceCursor];
    if (raw.resourceId) {
      where.push("resource_id = ?");
      binds.push(raw.resourceId);
    }

    const res = await this.db
      .prepare(
        `SELECT * FROM ms_events
         WHERE ${where.join(" AND ")}
         ORDER BY cursor_id ASC
         LIMIT ?`
      )
      .bind(...binds, limit)
      .all<any>();

    const events = (res.results || []).map((r) => ({
      cursorId: r.cursor_id,
      tenantId: r.tenant_id,
      resourceId: r.resource_id,
      entityUrn: r.entity_urn,
      eventType: r.event_type,
      payload: JSON.parse(r.payload_json),
      createdAt: r.created_at,
    }));

    const nextCursor = events.length > 0 ? events[events.length - 1].cursorId : sinceCursor;
    return { tenantId, sinceCursor, nextCursor, events };
  }

  public async getCockpitSnapshot(): Promise<{
    resourceCount: number;
    definitionCount: number;
    observationCount: number;
    recentCoverage: any[];
    recentAnnotations: any[];
  }> {
    const [r1, r2, r3, cov, ann] = await Promise.all([
      this.db.prepare("SELECT COUNT(*) as c FROM ms_resources").first<any>(),
      this.db.prepare("SELECT COUNT(*) as c FROM ms_definitions").first<any>(),
      this.db.prepare("SELECT COUNT(*) as c FROM ms_observations").first<any>(),
      this.db.prepare("SELECT * FROM ms_coverage ORDER BY updated_at DESC LIMIT 20").all<any>(),
      this.db.prepare("SELECT * FROM ms_annotations ORDER BY created_at DESC LIMIT 15").all<any>(),
    ]);
    return {
      resourceCount: Number(r1?.c ?? 0),
      definitionCount: Number(r2?.c ?? 0),
      observationCount: Number(r3?.c ?? 0),
      recentCoverage: cov.results || [],
      recentAnnotations: ann.results || [],
    };
  }

  private mapRunRow(r: any) {
    return {
      runId: r.run_id,
      tenantId: r.tenant_id,
      resourceId: r.resource_id,
      source: r.source,
      sourceResourceId: r.source_resource_id,
      scheduleId: r.schedule_id,
      idempotencyKey: r.idempotency_key,
      windowStart: r.window_start,
      windowEnd: r.window_end,
      cursor: r.cursor,
      status: r.status,
      retryCount: r.retry_count,
      maxRetries: r.max_retries,
      errorClass: r.error_class,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private mapObservationRow(r: any, lineage: any[]) {
    return {
      obsId: r.obs_id,
      tenantId: r.tenant_id,
      resourceId: r.resource_id,
      source: r.source,
      runId: r.run_id,
      evidenceId: r.evidence_id,
      metricId: r.metric_id,
      definitionVersion: r.definition_version,
      comparabilityKey: r.comparability_key,
      windowStart: r.window_start,
      windowEnd: r.window_end,
      windowTz: r.window_tz,
      grain: r.grain,
      dimensions: JSON.parse(r.dimensions_json),
      valueType: r.value_type,
      valueNum: r.value_num,
      valueText: r.value_text,
      currency: r.currency,
      billingDate: r.billing_date,
      grossOrNet: r.gross_or_net,
      refundText: r.refund_text,
      creditText: r.credit_text,
      taxText: r.tax_text,
      collectionRequestBudget: r.collection_request_budget,
      numerator: r.numerator,
      denominator: r.denominator,
      exclusions: r.exclusions_json ? JSON.parse(r.exclusions_json) : null,
      sampleTime: r.sample_time,
      gaugeReducer: r.gauge_reducer,
      counterStart: r.counter_start,
      counterEnd: r.counter_end,
      counterReset: Boolean(r.counter_reset),
      interpretationVersion: r.interpretation_version,
      sourceRevision: r.source_revision,
      sourceAsOf: r.source_as_of,
      correctionLineage: lineage,
      createdAt: r.created_at,
    };
  }
}
