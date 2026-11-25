import type { PodStorage } from "@futr-work/pod-kernel/storage";

export type ResourceType = "site" | "analytics_property" | "ad_account" | "server_service";
export type MetricFamily = "seo" | "analytics" | "spend" | "telemetry";
export type ValueType = "integer" | "decimal_string" | "gauge" | "counter";
export type RunStatus = "planned" | "running" | "partial" | "succeeded" | "failed" | "blocked";
export type AttemptStatus = "running" | "partial" | "succeeded" | "failed" | "blocked";
export type PrivacyClass = "public" | "internal" | "restricted" | "pii_minimized";
export type CoverageStatus =
  | "planned"
  | "attempted"
  | "successful"
  | "zero"
  | "partial"
  | "failed"
  | "blocked"
  | "not-collected"
  | "stale";
export type ReconciliationStatus = "matched" | "mismatch" | "partial" | "unknown";
export type GaugeReducer = "last" | "min" | "max" | "mean";
export type AnnotationKind = "deploy" | "fixpack" | "config_change" | "incident" | "note";

export interface PodConfig {
  id: string;
  name: string;
  role: string;
  lob: string;
  hubUrl: string;
  hubToken: string;
  port: number;
  capabilities: string[];
}

export interface TaskRecord {
  id: number;
  taskId: string;
  topic: string;
  source: string;
  spec: Record<string, any>;
  status: "pending" | "running" | "completed" | "failed";
  result?: any;
  errorMessage?: string;
  leaseExpiresAt?: number | null;
  retryCount: number;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
}

export interface HandlerContext {
  podConfig: PodConfig;
  now: number;
  storage: PodStorage;
  publishEvent: (topic: string, toPod: string, payload: any) => Promise<void>;
}

export interface TaskHandler {
  name: string;
  canHandle(topic: string, spec: any): boolean;
  handle(task: TaskRecord, context: HandlerContext): Promise<any>;
}

export interface ResourceInput {
  tenantId: string;
  resourceId: string;
  resourceType: ResourceType;
  sourceResourceId: string;
  displayName?: string;
  activeFrom: string;
  activeTo?: string | null;
}

export interface ResourceRecord {
  tenantId: string;
  resourceId: string;
  entityUrn: string;
  resourceType: ResourceType;
  sourceResourceId: string;
  displayName: string | null;
  activeFrom: string;
  activeTo: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DimensionFieldSpec {
  type: "string" | "number" | "boolean";
  required?: boolean;
  enum?: string[];
}

export interface DefinitionInput {
  tenantId: string;
  metricId: string;
  version: string;
  family: MetricFamily;
  unit: string;
  valueType: ValueType;
  grain: string;
  windowTz: string;
  dimensionsSchema: Record<string, DimensionFieldSpec>;
  numeratorRule?: string | null;
  denominatorRule?: string | null;
  exclusionsRule?: string | null;
  aggregationRule: string;
  comparabilityKey?: string;
}

export interface DefinitionRecord {
  tenantId: string;
  metricId: string;
  version: string;
  family: MetricFamily;
  unit: string;
  valueType: ValueType;
  grain: string;
  windowTz: string;
  dimensionsSchema: Record<string, DimensionFieldSpec>;
  numeratorRule: string | null;
  denominatorRule: string | null;
  exclusionsRule: string | null;
  aggregationRule: string;
  comparabilityKey: string;
  createdAt: number;
}

export interface RunInput {
  runId?: string;
  tenantId: string;
  resourceId: string;
  source: string;
  sourceResourceId: string;
  scheduleId?: string | null;
  idempotencyKey: string;
  windowStart: string;
  windowEnd: string;
  cursor?: string | null;
  status?: RunStatus;
  maxRetries?: number;
  errorClass?: string | null;
}

export interface AttemptInput {
  attemptId?: string;
  tenantId: string;
  runId: string;
  status: AttemptStatus;
  cursor?: string | null;
  errorClass?: string | null;
}

export interface EvidenceInput {
  evidenceId: string;
  uriPointer: string;
  sha256: string;
  byteSize: number;
  mediaType: string;
  privacyClass: PrivacyClass;
  retentionClass: string;
  collectedAt: string;
  sourceAsOf: string;
  adapterName: string;
  adapterVersion: string;
}

export interface ObservationInput {
  obsId?: string;
  metricId: string;
  definitionVersion: string;
  windowStart: string;
  windowEnd: string;
  windowTz: string;
  grain: string;
  dimensions: Record<string, string | number | boolean>;
  valueNum?: number | null;
  valueText?: string | null;
  currency?: string | null;
  billingDate?: string | null;
  grossOrNet?: "gross" | "net" | null;
  refundText?: string | null;
  creditText?: string | null;
  taxText?: string | null;
  collectionRequestBudget?: number | null;
  numerator?: number | null;
  denominator?: number | null;
  exclusions?: Record<string, any> | null;
  sampleTime?: string | null;
  gaugeReducer?: GaugeReducer | null;
  counterStart?: number | null;
  counterEnd?: number | null;
  counterReset?: boolean;
  interpretationVersion: string;
  sourceRevision?: number;
  sourceAsOf: string;
  idempotencyKey: string;
}

export interface CoverageInput {
  status: CoverageStatus;
  expectedCadenceSec?: number | null;
  expectedLagSec?: number | null;
  sourceTotalText?: string | null;
  interpretedTotalText?: string | null;
  discrepancyText?: string | null;
  reconciliationStatus?: ReconciliationStatus;
  freshnessAt?: string | null;
}

export interface IngestBatchInput {
  tenantId: string;
  resourceId: string;
  source: string;
  runId: string;
  windowStart: string;
  windowEnd: string;
  cursor?: string | null;
  runStatus?: RunStatus;
  evidence: EvidenceInput;
  observations: ObservationInput[];
  coverage?: CoverageInput;
}

export interface AtomicIngestGroupInput extends Omit<IngestBatchInput, "tenantId"> {
  runIdempotencyKey?: string;
  sourceResourceId?: string;
}

export interface IngestAtomicBatchInput {
  tenantId: string;
  groups: AtomicIngestGroupInput[];
}

export interface StageImportChunkInput {
  tenantId: string;
  importId: string;
  chunkIndex: number;
  groups: AtomicIngestGroupInput[];
}

export interface CommitStagedImportInput {
  tenantId: string;
  importId: string;
  expectedChunks: number;
}

export interface AnnotationInput {
  annotationId?: string;
  tenantId: string;
  resourceId: string;
  podId: string;
  kind: AnnotationKind;
  commitSha?: string | null;
  prUrl?: string | null;
  summary: string;
  occurredAt: string;
}

export interface SeriesQueryInput {
  tenantId: string;
  resourceId: string;
  metricId: string;
  definitionVersion?: string;
  windowStart?: string;
  windowEnd?: string;
  dimensions?: Record<string, string | number | boolean>;
  includeSuperseded?: boolean;
  limit?: number;
  offset?: number;
}

export interface CoverageQueryInput {
  tenantId: string;
  resourceId?: string;
  source?: string;
  limit?: number;
  offset?: number;
}

export interface EventsQueryInput {
  tenantId: string;
  resourceId?: string;
  sinceCursor?: number;
  limit?: number;
}
