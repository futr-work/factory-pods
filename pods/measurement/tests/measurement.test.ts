import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteFileStorage } from "@futr-work/pod-kernel/storage/sqlite";
import { sha256Hex } from "@futr-work/pod-kernel/auth";
import worker, { type Env } from "../src/worker.js";
import { MeasurementService } from "../src/service.js";
import { startLocalMeasurementPod } from "../src/main.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

async function createTestHarness() {
  const dir = mkdtempSync(join(tmpdir(), "ms-pod-test-"));
  const dbPath = join(dir, "pod.sqlite");
  const db = new SqliteFileStorage(dbPath);
  db.exec(schemaSql);

  const hubToken = "test-hub-token-000";
  const tokenA = "scoped-token-tenant-alpha-111";
  const tokenB = "scoped-token-tenant-beta-222";

  const grants = [
    {
      callerId: "caller-alpha",
      tokenSha256: await sha256Hex(tokenA),
      grants: [{ tenantId: "tenant-alpha", resourceIds: ["*"], actions: ["read", "write"] }],
    },
    {
      callerId: "caller-beta",
      tokenSha256: await sha256Hex(tokenB),
      grants: [{ tenantId: "tenant-beta", resourceIds: ["*"], actions: ["read", "write"] }],
    },
  ];

  const env: Env = {
    DB: db,
    POD_ID: "measurement-pod",
    POD_NAME: "Measurement Pod",
    POD_ROLE: "measurement",
    POD_LOB: "measurement-evidence",
    FACTORY_HUB_TOKEN: hubToken,
    SCOPED_CALLER_GRANTS: JSON.stringify(grants),
  };

  const call = (method: string, path: string, token?: string, body?: any, extraHeaders: Record<string, string> = {}) =>
    worker.fetch(
      new Request(`https://measurement.test${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...extraHeaders,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
      env
    );

  return {
    dir,
    dbPath,
    db,
    env,
    hubToken,
    tokenA,
    tokenB,
    call,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("Measurement Pod — Typed 4-Family Vertical Slice, Isolation, MCP v2 + Code Mode & Worldview Projection", () => {
  test("domain-real SEO, Analytics, Paid-Ad Spend, and Server Telemetry fixtures + replay/conflict/partial/correction semantics", async () => {
    const h = await createTestHarness();
    try {
      // 1. Register 4 resources across the 4 resource types
      const resources = [
        { tenantId: "tenant-alpha", resourceId: "site-alpha", resourceType: "site", sourceResourceId: "sc-domain:alpha.test", displayName: "Alpha Test Site", activeFrom: "2026-01-01" },
        { tenantId: "tenant-alpha", resourceId: "ga4-alpha", resourceType: "analytics_property", sourceResourceId: "properties/100001", displayName: "Alpha GA4", activeFrom: "2026-01-01" },
        { tenantId: "tenant-alpha", resourceId: "ads-alpha", resourceType: "ad_account", sourceResourceId: "customers/999001", displayName: "Alpha Paid Ads", activeFrom: "2026-01-01" },
        { tenantId: "tenant-alpha", resourceId: "svc-alpha", resourceType: "server_service", sourceResourceId: "edge-api-prod", displayName: "Alpha Edge API", activeFrom: "2026-01-01" },
      ];
      for (const r of resources) {
        const res = await h.call("POST", "/api/measurement/resources", h.tokenA, r);
        assert.equal(res.status, 201);
        const body = (await res.json()) as any;
        assert.equal(body.entityUrn, `${r.resourceType}:${r.tenantId}:${r.resourceId}`);
      }

      // 2. Define 5 typed metrics (SEO impressions, Analytics qualified conversion, Paid spend, CPU gauge, Request counter)
      const defs = [
        {
          tenantId: "tenant-alpha",
          metricId: "gsc.impressions",
          version: "v1",
          family: "seo",
          unit: "impressions",
          valueType: "integer",
          grain: "daily",
          windowTz: "UTC",
          dimensionsSchema: {
            page: { type: "string", required: true },
            query: { type: "string", required: true },
            country: { type: "string", required: true },
            device: { type: "string", enum: ["DESKTOP", "MOBILE", "TABLET"], required: true },
            searchType: { type: "string", enum: ["WEB", "IMAGE", "VIDEO"], required: true },
          },
          aggregationRule: "sum",
        },
        {
          tenantId: "tenant-alpha",
          metricId: "ga4.qualified_conversion_rate",
          version: "v1",
          family: "analytics",
          unit: "ratio",
          valueType: "decimal_string",
          grain: "daily",
          windowTz: "America/Los_Angeles",
          dimensionsSchema: {
            channel: { type: "string", required: true },
          },
          numeratorRule: "qualified_leads",
          denominatorRule: "eligible_consented_sessions",
          exclusionsRule: "exclude_bots_and_unconsented",
          aggregationRule: "ratio_from_totals",
        },
        {
          tenantId: "tenant-alpha",
          metricId: "ads.observed_spend",
          version: "v1",
          family: "spend",
          unit: "currency",
          valueType: "decimal_string",
          grain: "daily",
          windowTz: "America/New_York",
          dimensionsSchema: {
            campaignId: { type: "string", required: true },
          },
          aggregationRule: "exact_decimal_sum",
        },
        {
          tenantId: "tenant-alpha",
          metricId: "server.cpu_utilization",
          version: "v1",
          family: "telemetry",
          unit: "percent",
          valueType: "gauge",
          grain: "5m_rollup",
          windowTz: "UTC",
          dimensionsSchema: { host: { type: "string", required: true } },
          aggregationRule: "last",
        },
        {
          tenantId: "tenant-alpha",
          metricId: "server.http_requests",
          version: "v1",
          family: "telemetry",
          unit: "requests",
          valueType: "counter",
          grain: "5m_rollup",
          windowTz: "UTC",
          dimensionsSchema: { host: { type: "string", required: true } },
          aggregationRule: "delta_counter",
        },
      ];
      for (const d of defs) {
        const res = await h.call("POST", "/api/measurement/definitions", h.tokenA, d);
        assert.equal(res.status, 201);
      }

      // 3. SEO fixture: partial run -> resumed run -> late source correction + reconciliation mismatch
      const runSeoRes = await h.call("POST", "/api/measurement/runs", h.tokenA, {
        runId: "run-seo-1",
        tenantId: "tenant-alpha",
        resourceId: "site-alpha",
        source: "gsc",
        sourceResourceId: "sc-domain:alpha.test",
        idempotencyKey: "run-gsc-2026-11-18",
        windowStart: "2026-11-18T00:00:00Z",
        windowEnd: "2026-11-18T23:59:59Z",
      });
      assert.equal(runSeoRes.status, 201);

      // Idempotent run replay returns existing
      const runSeoReplay = await h.call("POST", "/api/measurement/runs", h.tokenA, {
        tenantId: "tenant-alpha",
        resourceId: "site-alpha",
        source: "gsc",
        sourceResourceId: "sc-domain:alpha.test",
        idempotencyKey: "run-gsc-2026-11-18",
        windowStart: "2026-11-18T00:00:00Z",
        windowEnd: "2026-11-18T23:59:59Z",
      });
      assert.equal(runSeoReplay.status, 200);
      assert.equal(((await runSeoReplay.json()) as any).existing, true);

      const seoFixtureSha = await sha256Hex("synthetic-gsc-page-1-bytes");
      const ingestPartial = await h.call("POST", "/api/measurement/ingest", h.tokenA, {
        tenantId: "tenant-alpha",
        resourceId: "site-alpha",
        source: "gsc",
        runId: "run-seo-1",
        windowStart: "2026-11-18T00:00:00Z",
        windowEnd: "2026-11-18T23:59:59Z",
        cursor: "page=2",
        evidence: {
          evidenceId: "ev-seo-1",
          uriPointer: "fixture://gsc/alpha.test/2026-11-18-p1.json",
          sha256: seoFixtureSha,
          byteSize: 26,
          mediaType: "application/json",
          privacyClass: "internal",
          retentionClass: "90d",
          collectedAt: "2026-11-20T01:00:00Z",
          sourceAsOf: "2026-11-19T00:00:00Z",
          adapterName: "gsc-fixture",
          adapterVersion: "1.0.0",
        },
        observations: [
          {
            metricId: "gsc.impressions",
            definitionVersion: "v1",
            windowStart: "2026-11-18T00:00:00Z",
            windowEnd: "2026-11-18T23:59:59Z",
            windowTz: "UTC",
            grain: "daily",
            dimensions: { page: "/guide", query: "best guide", country: "USA", device: "MOBILE", searchType: "WEB" },
            valueNum: 120,
            interpretationVersion: "interp-1",
            sourceRevision: 1,
            sourceAsOf: "2026-11-19T00:00:00Z",
            idempotencyKey: "seo-alpha-20261118-rev1-p1",
          },
        ],
        coverage: {
          status: "partial",
          expectedCadenceSec: 86400,
          expectedLagSec: 172800,
          sourceTotalText: "200",
          interpretedTotalText: "120",
          discrepancyText: "80",
          reconciliationStatus: "mismatch",
        },
      });
      assert.equal(ingestPartial.status, 200);
      assert.equal(((await ingestPartial.json()) as any).inserted, 1);

      // Exact replay is a no-op
      const replayRes = await h.call("POST", "/api/measurement/ingest", h.tokenA, {
        tenantId: "tenant-alpha",
        resourceId: "site-alpha",
        source: "gsc",
        runId: "run-seo-1",
        windowStart: "2026-11-18T00:00:00Z",
        windowEnd: "2026-11-18T23:59:59Z",
        evidence: {
          evidenceId: "ev-seo-1",
          uriPointer: "fixture://gsc/alpha.test/2026-11-18-p1.json",
          sha256: seoFixtureSha,
          byteSize: 26,
          mediaType: "application/json",
          privacyClass: "internal",
          retentionClass: "90d",
          collectedAt: "2026-11-20T01:00:00Z",
          sourceAsOf: "2026-11-19T00:00:00Z",
          adapterName: "gsc-fixture",
          adapterVersion: "1.0.0",
        },
        observations: [
          {
            metricId: "gsc.impressions",
            definitionVersion: "v1",
            windowStart: "2026-11-18T00:00:00Z",
            windowEnd: "2026-11-18T23:59:59Z",
            windowTz: "UTC",
            grain: "daily",
            dimensions: { page: "/guide", query: "best guide", country: "USA", device: "MOBILE", searchType: "WEB" },
            valueNum: 120,
            interpretationVersion: "interp-1",
            sourceRevision: 1,
            sourceAsOf: "2026-11-19T00:00:00Z",
            idempotencyKey: "seo-alpha-20261118-rev1-p1",
          },
        ],
      });
      assert.equal(replayRes.status, 200);
      assert.equal(((await replayRes.json()) as any).replayedNoop, 1);

      // Conflicting value on same idempotencyKey fails atomically (409) and inserts nothing
      const conflictRes = await h.call("POST", "/api/measurement/ingest", h.tokenA, {
        tenantId: "tenant-alpha",
        resourceId: "site-alpha",
        source: "gsc",
        runId: "run-seo-1",
        windowStart: "2026-11-18T00:00:00Z",
        windowEnd: "2026-11-18T23:59:59Z",
        evidence: {
          evidenceId: "ev-seo-1",
          uriPointer: "fixture://gsc/alpha.test/2026-11-18-p1.json",
          sha256: seoFixtureSha,
          byteSize: 26,
          mediaType: "application/json",
          privacyClass: "internal",
          retentionClass: "90d",
          collectedAt: "2026-11-20T01:00:00Z",
          sourceAsOf: "2026-11-19T00:00:00Z",
          adapterName: "gsc-fixture",
          adapterVersion: "1.0.0",
        },
        observations: [
          {
            metricId: "gsc.impressions",
            definitionVersion: "v1",
            windowStart: "2026-11-18T00:00:00Z",
            windowEnd: "2026-11-18T23:59:59Z",
            windowTz: "UTC",
            grain: "daily",
            dimensions: { page: "/guide", query: "best guide", country: "USA", device: "MOBILE", searchType: "WEB" },
            valueNum: 999, // conflict!
            interpretationVersion: "interp-1",
            sourceRevision: 1,
            sourceAsOf: "2026-11-19T00:00:00Z",
            idempotencyKey: "seo-alpha-20261118-rev1-p1",
          },
        ],
      });
      assert.equal(conflictRes.status, 409);

      // Late source correction appends revision 2 without overwriting revision 1
      const seoRev2Sha = await sha256Hex("synthetic-gsc-rev2-bytes");
      const rev2Res = await h.call("POST", "/api/measurement/ingest", h.tokenA, {
        tenantId: "tenant-alpha",
        resourceId: "site-alpha",
        source: "gsc",
        runId: "run-seo-1",
        windowStart: "2026-11-18T00:00:00Z",
        windowEnd: "2026-11-18T23:59:59Z",
        evidence: {
          evidenceId: "ev-seo-2",
          uriPointer: "fixture://gsc/alpha.test/2026-11-18-rev2.json",
          sha256: seoRev2Sha,
          byteSize: 24,
          mediaType: "application/json",
          privacyClass: "internal",
          retentionClass: "90d",
          collectedAt: "2026-11-21T01:00:00Z",
          sourceAsOf: "2026-11-20T00:00:00Z",
          adapterName: "gsc-fixture",
          adapterVersion: "1.0.0",
        },
        observations: [
          {
            metricId: "gsc.impressions",
            definitionVersion: "v1",
            windowStart: "2026-11-18T00:00:00Z",
            windowEnd: "2026-11-18T23:59:59Z",
            windowTz: "UTC",
            grain: "daily",
            dimensions: { page: "/guide", query: "best guide", country: "USA", device: "MOBILE", searchType: "WEB" },
            valueNum: 145,
            interpretationVersion: "interp-1",
            sourceRevision: 2,
            sourceAsOf: "2026-11-20T00:00:00Z",
            idempotencyKey: "seo-alpha-20261118-rev2-p1",
          },
        ],
        coverage: {
          status: "successful",
          sourceTotalText: "145",
          interpretedTotalText: "145",
          discrepancyText: "0",
          reconciliationStatus: "matched",
        },
      });
      assert.equal(rev2Res.status, 200);

      const seoSeries = (await (await h.call("GET", "/api/measurement/series?tenantId=tenant-alpha&resourceId=site-alpha&metricId=gsc.impressions", h.tokenA)).json()) as any;
      assert.equal(seoSeries.comparable, true);
      assert.equal(seoSeries.points.length, 1);
      assert.equal(seoSeries.points[0].valueNum, 145);
      assert.equal(seoSeries.points[0].sourceRevision, 2);
      assert.equal(seoSeries.points[0].correctionLineage.length, 2);

      // 4. Paid-ad spend exact decimal round-trip (rejects binary float valueNum, keeps exact decimal string + request budget separate)
      await h.call("POST", "/api/measurement/runs", h.tokenA, {
        runId: "run-ads-1",
        tenantId: "tenant-alpha",
        resourceId: "ads-alpha",
        source: "google-ads-readonly",
        sourceResourceId: "customers/999001",
        idempotencyKey: "run-ads-2026-11-18",
        windowStart: "2026-11-18T00:00:00-05:00",
        windowEnd: "2026-11-18T23:59:59-05:00",
      });
      const adsSha = await sha256Hex("synthetic-ads-spend");
      const adsRes = await h.call("POST", "/api/measurement/ingest", h.tokenA, {
        tenantId: "tenant-alpha",
        resourceId: "ads-alpha",
        source: "google-ads-readonly",
        runId: "run-ads-1",
        windowStart: "2026-11-18T00:00:00-05:00",
        windowEnd: "2026-11-18T23:59:59-05:00",
        evidence: {
          evidenceId: "ev-ads-1",
          uriPointer: "fixture://ads/2026-11-18.json",
          sha256: adsSha,
          byteSize: 19,
          mediaType: "application/json",
          privacyClass: "restricted",
          retentionClass: "365d",
          collectedAt: "2026-11-19T06:00:00Z",
          sourceAsOf: "2026-11-19T05:00:00Z",
          adapterName: "ads-fixture",
          adapterVersion: "1.0.0",
        },
        observations: [
          {
            metricId: "ads.observed_spend",
            definitionVersion: "v1",
            windowStart: "2026-11-18T00:00:00-05:00",
            windowEnd: "2026-11-18T23:59:59-05:00",
            windowTz: "America/New_York",
            grain: "daily",
            dimensions: { campaignId: "cmp-01" },
            valueText: "1234.560000",
            currency: "USD",
            billingDate: "2026-11-18",
            grossOrNet: "net",
            refundText: "12.340000",
            creditText: "0.000000",
            taxText: "98.760000",
            collectionRequestBudget: 500,
            interpretationVersion: "interp-1",
            sourceRevision: 1,
            sourceAsOf: "2026-11-19T05:00:00Z",
            idempotencyKey: "ads-alpha-cmp01-20261118",
          },
        ],
        coverage: { status: "successful", reconciliationStatus: "matched" },
      });
      assert.equal(adsRes.status, 200);
      const adsSeries = (await (await h.call("GET", "/api/measurement/series?tenantId=tenant-alpha&resourceId=ads-alpha&metricId=ads.observed_spend", h.tokenA)).json()) as any;
      assert.equal(adsSeries.points[0].valueText, "1234.560000");
      assert.equal(adsSeries.points[0].currency, "USD");
      assert.equal(adsSeries.points[0].collectionRequestBudget, 500);

      // 5. Analytics numerator/denominator/exclusions + Server Telemetry gauge reducer & counter reset
      await h.call("POST", "/api/measurement/runs", h.tokenA, {
        runId: "run-ga4-1",
        tenantId: "tenant-alpha",
        resourceId: "ga4-alpha",
        source: "ga4",
        sourceResourceId: "properties/100001",
        idempotencyKey: "run-ga4-2026-11-18",
        windowStart: "2026-11-18T00:00:00-08:00",
        windowEnd: "2026-11-18T23:59:59-08:00",
      });
      const ga4Res = await h.call("POST", "/api/measurement/ingest", h.tokenA, {
        tenantId: "tenant-alpha",
        resourceId: "ga4-alpha",
        source: "ga4",
        runId: "run-ga4-1",
        windowStart: "2026-11-18T00:00:00-08:00",
        windowEnd: "2026-11-18T23:59:59-08:00",
        evidence: {
          evidenceId: "ev-ga4-1",
          uriPointer: "fixture://ga4/2026-11-18.json",
          sha256: await sha256Hex("synthetic-ga4"),
          byteSize: 13,
          mediaType: "application/json",
          privacyClass: "pii_minimized",
          retentionClass: "180d",
          collectedAt: "2026-11-19T08:00:00Z",
          sourceAsOf: "2026-11-19T07:00:00Z",
          adapterName: "ga4-fixture",
          adapterVersion: "1.0.0",
        },
        observations: [
          {
            metricId: "ga4.qualified_conversion_rate",
            definitionVersion: "v1",
            windowStart: "2026-11-18T00:00:00-08:00",
            windowEnd: "2026-11-18T23:59:59-08:00",
            windowTz: "America/Los_Angeles",
            grain: "daily",
            dimensions: { channel: "organic_search" },
            valueText: "0.0450",
            numerator: 9,
            denominator: 200,
            exclusions: { botSessionsExcluded: 14, unconsentedExcluded: 22 },
            interpretationVersion: "interp-1",
            sourceRevision: 1,
            sourceAsOf: "2026-11-19T07:00:00Z",
            idempotencyKey: "ga4-alpha-organic-20261118",
          },
        ],
        coverage: { status: "successful", reconciliationStatus: "matched" },
      });
      assert.equal(ga4Res.status, 200);

      await h.call("POST", "/api/measurement/runs", h.tokenA, {
        runId: "run-tel-1",
        tenantId: "tenant-alpha",
        resourceId: "svc-alpha",
        source: "prometheus-rollup",
        sourceResourceId: "edge-api-prod",
        idempotencyKey: "run-tel-2026-11-18T00:00Z",
        windowStart: "2026-11-18T00:00:00Z",
        windowEnd: "2026-11-18T00:05:00Z",
      });
      const telRes = await h.call("POST", "/api/measurement/ingest", h.tokenA, {
        tenantId: "tenant-alpha",
        resourceId: "svc-alpha",
        source: "prometheus-rollup",
        runId: "run-tel-1",
        windowStart: "2026-11-18T00:00:00Z",
        windowEnd: "2026-11-18T00:05:00Z",
        evidence: {
          evidenceId: "ev-tel-1",
          uriPointer: "fixture://prom/2026-11-18T00-05Z.json",
          sha256: await sha256Hex("synthetic-prom"),
          byteSize: 14,
          mediaType: "application/json",
          privacyClass: "internal",
          retentionClass: "30d",
          collectedAt: "2026-11-18T00:05:10Z",
          sourceAsOf: "2026-11-18T00:05:00Z",
          adapterName: "prom-rollup-fixture",
          adapterVersion: "1.0.0",
        },
        observations: [
          {
            metricId: "server.cpu_utilization",
            definitionVersion: "v1",
            windowStart: "2026-11-18T00:00:00Z",
            windowEnd: "2026-11-18T00:05:00Z",
            windowTz: "UTC",
            grain: "5m_rollup",
            dimensions: { host: "edge-01" },
            valueNum: 37.5,
            sampleTime: "2026-11-18T00:05:00Z",
            gaugeReducer: "last",
            interpretationVersion: "interp-1",
            sourceRevision: 1,
            sourceAsOf: "2026-11-18T00:05:00Z",
            idempotencyKey: "tel-cpu-edge01-0005",
          },
          {
            metricId: "server.http_requests",
            definitionVersion: "v1",
            windowStart: "2026-11-18T00:00:00Z",
            windowEnd: "2026-11-18T00:05:00Z",
            windowTz: "UTC",
            grain: "5m_rollup",
            dimensions: { host: "edge-01" },
            counterStart: 5000,
            counterEnd: 320,
            counterReset: true,
            interpretationVersion: "interp-1",
            sourceRevision: 1,
            sourceAsOf: "2026-11-18T00:05:00Z",
            idempotencyKey: "tel-req-edge01-0005",
          },
        ],
        coverage: { status: "successful", reconciliationStatus: "matched" },
      });
      assert.equal(telRes.status, 200);
      const reqSeries = (await (await h.call("GET", "/api/measurement/series?tenantId=tenant-alpha&resourceId=svc-alpha&metricId=server.http_requests", h.tokenA)).json()) as any;
      assert.equal(reqSeries.points[0].counterReset, true);
      assert.equal(reqSeries.points[0].valueNum, 320); // delta after reset

      // 6. Missing/failed/blocked/stale never synthesize zero
      const failedZeroRes = await h.call("POST", "/api/measurement/ingest", h.tokenA, {
        tenantId: "tenant-alpha",
        resourceId: "site-alpha",
        source: "gsc",
        runId: "run-seo-1",
        windowStart: "2026-11-19T00:00:00Z",
        windowEnd: "2026-11-19T23:59:59Z",
        evidence: {
          evidenceId: "ev-seo-1",
          uriPointer: "fixture://gsc/alpha.test/2026-11-18-p1.json",
          sha256: seoFixtureSha,
          byteSize: 26,
          mediaType: "application/json",
          privacyClass: "internal",
          retentionClass: "90d",
          collectedAt: "2026-11-20T01:00:00Z",
          sourceAsOf: "2026-11-19T00:00:00Z",
          adapterName: "gsc-fixture",
          adapterVersion: "1.0.0",
        },
        observations: [
          {
            metricId: "gsc.impressions",
            definitionVersion: "v1",
            windowStart: "2026-11-19T00:00:00Z",
            windowEnd: "2026-11-19T23:59:59Z",
            windowTz: "UTC",
            grain: "daily",
            dimensions: { page: "/guide", query: "best guide", country: "USA", device: "MOBILE", searchType: "WEB" },
            valueNum: 0,
            interpretationVersion: "interp-1",
            sourceRevision: 1,
            sourceAsOf: "2026-11-19T00:00:00Z",
            idempotencyKey: "seo-alpha-failed-zero-forbidden",
          },
        ],
        coverage: { status: "failed" },
      });
      assert.equal(failedZeroRes.status, 400);

      // 7. Work annotation + Worldview monotonic cursor projection feed
      const annRes = await h.call("POST", "/api/measurement/annotations", h.tokenA, {
        tenantId: "tenant-alpha",
        resourceId: "site-alpha",
        podId: "authority-seo-pod",
        kind: "fixpack",
        commitSha: "abcdef1234567890",
        summary: "Updated AI robots.txt and JSON-LD schema",
        occurredAt: "2026-11-19T12:00:00Z",
      });
      assert.equal(annRes.status, 201);
      const annBody = (await annRes.json()) as any;
      assert.equal(annBody.causal, false);
      assert.equal(annBody.entityUrn, "site:tenant-alpha:site-alpha");

      const eventsPage1 = (await (await h.call("GET", "/api/measurement/events?tenantId=tenant-alpha&since_cursor=0&limit=5", h.tokenA)).json()) as any;
      assert.equal(eventsPage1.events.length, 5);
      assert.ok(eventsPage1.nextCursor >= 5);
      const eventsPage2 = (await (await h.call("GET", `/api/measurement/events?tenantId=tenant-alpha&since_cursor=${eventsPage1.nextCursor}&limit=50`, h.tokenA)).json()) as any;
      assert.ok(eventsPage2.events.some((e: any) => e.eventType === "annotation.recorded" && e.entityUrn === "site:tenant-alpha:site-alpha"));

      // 8. Regression checks for verifier findings:
      // 8a. Replaying an old partial page after successful completion is a true no-op (does not regress run status or cursor)
      const cursorBeforeReplay = (await (await h.call("GET", "/api/measurement/events?tenantId=tenant-alpha&since_cursor=0&limit=500", h.tokenA)).json() as any).nextCursor;
      const oldPartialReplay = await h.call("POST", "/api/measurement/ingest", h.tokenA, {
        tenantId: "tenant-alpha",
        resourceId: "site-alpha",
        source: "gsc",
        runId: "run-seo-1",
        windowStart: "2026-11-18T00:00:00Z",
        windowEnd: "2026-11-18T23:59:59Z",
        cursor: "page=2",
        evidence: {
          evidenceId: "ev-seo-1",
          uriPointer: "fixture://gsc/alpha.test/2026-11-18-p1.json",
          sha256: seoFixtureSha,
          byteSize: 26,
          mediaType: "application/json",
          privacyClass: "internal",
          retentionClass: "90d",
          collectedAt: "2026-11-20T01:00:00Z",
          sourceAsOf: "2026-11-19T00:00:00Z",
          adapterName: "gsc-fixture",
          adapterVersion: "1.0.0",
        },
        observations: [
          {
            metricId: "gsc.impressions",
            definitionVersion: "v1",
            windowStart: "2026-11-18T00:00:00Z",
            windowEnd: "2026-11-18T23:59:59Z",
            windowTz: "UTC",
            grain: "daily",
            dimensions: { page: "/guide", query: "best guide", country: "USA", device: "MOBILE", searchType: "WEB" },
            valueNum: 120,
            interpretationVersion: "interp-1",
            sourceRevision: 1,
            sourceAsOf: "2026-11-19T00:00:00Z",
            idempotencyKey: "seo-alpha-20261118-rev1-p1",
          },
        ],
        coverage: {
          status: "partial",
          expectedCadenceSec: 86400,
          expectedLagSec: 172800,
          sourceTotalText: "200",
          interpretedTotalText: "120",
          discrepancyText: "80",
          reconciliationStatus: "mismatch",
        },
      });
      assert.equal(oldPartialReplay.status, 200);
      assert.equal(((await oldPartialReplay.json()) as any).replayedNoop, 1);
      const runAfterReplay = (await (await h.call("GET", "/api/measurement/runs/run-seo-1?tenantId=tenant-alpha", h.tokenA)).json()) as any;
      assert.equal(runAfterReplay.status, "succeeded");
      const cursorAfterReplay = (await (await h.call("GET", "/api/measurement/events?tenantId=tenant-alpha&since_cursor=0&limit=500", h.tokenA)).json() as any).nextCursor;
      assert.equal(cursorAfterReplay, cursorBeforeReplay);

      // 8b. Recording a failed attempt emits a run.updated event to the delta feed
      assert.equal(
        (await h.call("POST", "/api/measurement/runs/run-seo-1/attempts", h.tokenA, {
          tenantId: "tenant-alpha",
          status: "failed",
          errorClass: "upstream_503",
        })).status,
        201
      );
      const deltaAfterAttempt = (await (await h.call("GET", `/api/measurement/events?tenantId=tenant-alpha&since_cursor=${cursorAfterReplay}`, h.tokenA)).json()) as any;
      assert.ok(deltaAfterAttempt.events.some((e: any) => e.eventType === "run.updated" && e.payload.status === "failed"));

      // 8c. Independent sources (GSC vs Bing) and currencies (USD vs EUR) never collapse into one revision/lineage and mark comparable=false
      const bingRun = await h.call("POST", "/api/measurement/runs", h.tokenA, {
        runId: "run-bing-1",
        tenantId: "tenant-alpha",
        resourceId: "site-alpha",
        source: "bing",
        sourceResourceId: "bing:alpha.test",
        idempotencyKey: "run-bing-2026-11-18",
        windowStart: "2026-11-18T00:00:00Z",
        windowEnd: "2026-11-18T23:59:59Z",
      });
      assert.equal(bingRun.status, 201);
      assert.equal(
        (await h.call("POST", "/api/measurement/ingest", h.tokenA, {
          tenantId: "tenant-alpha",
          resourceId: "site-alpha",
          source: "bing",
          runId: "run-bing-1",
          windowStart: "2026-11-18T00:00:00Z",
          windowEnd: "2026-11-18T23:59:59Z",
          evidence: {
            evidenceId: "ev-bing-1",
            uriPointer: "fixture://bing/alpha.test/2026-11-18.json",
            sha256: await sha256Hex("synthetic-bing-bytes"),
            byteSize: 20,
            mediaType: "application/json",
            privacyClass: "internal",
            retentionClass: "90d",
            collectedAt: "2026-11-20T02:00:00Z",
            sourceAsOf: "2026-11-19T00:00:00Z",
            adapterName: "bing-fixture",
            adapterVersion: "1.0.0",
          },
          observations: [
            {
              metricId: "gsc.impressions",
              definitionVersion: "v1",
              windowStart: "2026-11-18T00:00:00Z",
              windowEnd: "2026-11-18T23:59:59Z",
              windowTz: "UTC",
              grain: "daily",
              dimensions: { page: "/guide", query: "best guide", country: "USA", device: "MOBILE", searchType: "WEB" },
              valueNum: 33,
              interpretationVersion: "interp-1",
              sourceRevision: 1,
              sourceAsOf: "2026-11-19T00:00:00Z",
              idempotencyKey: "bing-alpha-20261118-rev1",
            },
          ],
          coverage: { status: "successful", reconciliationStatus: "matched" },
        })).status,
        200
      );
      const multiSourceSeries = (await (await h.call("GET", "/api/measurement/series?tenantId=tenant-alpha&resourceId=site-alpha&metricId=gsc.impressions", h.tokenA)).json()) as any;
      assert.equal(multiSourceSeries.points.length, 2);
      assert.equal(multiSourceSeries.comparable, false);

      // 8d. Rejects embedded data: URI evidence pointers, contradicting gaugeReducer, and altered analytics numeratorRule
      assert.equal(
        (await h.call("POST", "/api/measurement/ingest", h.tokenA, {
          tenantId: "tenant-alpha",
          resourceId: "site-alpha",
          source: "gsc",
          runId: "run-seo-1",
          windowStart: "2026-11-18T00:00:00Z",
          windowEnd: "2026-11-18T23:59:59Z",
          evidence: {
            evidenceId: "ev-data-uri",
            uriPointer: "data:text/plain,api_key=sk_test_12345",
            sha256: await sha256Hex("data-uri"),
            byteSize: 10,
            mediaType: "text/plain",
            privacyClass: "internal",
            retentionClass: "30d",
            collectedAt: "2026-11-20T00:00:00Z",
            sourceAsOf: "2026-11-19T00:00:00Z",
            adapterName: "gsc-fixture",
            adapterVersion: "1.0.0",
          },
          observations: [],
        })).status,
        400
      );

      assert.equal(
        (await h.call("POST", "/api/measurement/definitions", h.tokenA, {
          tenantId: "tenant-alpha",
          metricId: "ga4.qualified_conversion_rate",
          version: "v1",
          family: "analytics",
          unit: "ratio",
          valueType: "decimal_string",
          grain: "daily",
          windowTz: "America/Los_Angeles",
          dimensionsSchema: { channel: { type: "string", required: true } },
          numeratorRule: "changed_rule",
          denominatorRule: "eligible_consented_sessions",
          exclusionsRule: "exclude_bots_and_unconsented",
          aggregationRule: "ratio_from_totals",
        })).status,
        409
      );

      assert.equal(
        (await h.call("POST", "/api/measurement/ingest", h.tokenA, {
          tenantId: "tenant-alpha",
          resourceId: "svc-alpha",
          source: "prometheus-rollup",
          runId: "run-tel-1",
          windowStart: "2026-11-18T00:00:00Z",
          windowEnd: "2026-11-18T00:05:00Z",
          evidence: {
            evidenceId: "ev-tel-1",
            uriPointer: "fixture://prom/2026-11-18T00-05Z.json",
            sha256: await sha256Hex("synthetic-prom"),
            byteSize: 14,
            mediaType: "application/json",
            privacyClass: "internal",
            retentionClass: "30d",
            collectedAt: "2026-11-18T00:05:10Z",
            sourceAsOf: "2026-11-18T00:05:00Z",
            adapterName: "prom-rollup-fixture",
            adapterVersion: "1.0.0",
          },
          observations: [
            {
              metricId: "server.cpu_utilization",
              definitionVersion: "v1",
              windowStart: "2026-11-18T00:00:00Z",
              windowEnd: "2026-11-18T00:05:00Z",
              windowTz: "UTC",
              grain: "5m_rollup",
              dimensions: { host: "edge-01" },
              valueNum: 50,
              sampleTime: "2026-11-18T00:05:00Z",
              gaugeReducer: "mean", // contradicts definition 'last'
              interpretationVersion: "interp-1",
              sourceRevision: 1,
              sourceAsOf: "2026-11-18T00:05:00Z",
              idempotencyKey: "tel-cpu-bad-reducer",
            },
          ],
        })).status,
        400
      );
    } finally {
      h.cleanup();
    }
  });

  test("bidirectional cross-tenant isolation, ungranted shared hub token denial, and MCP v2 + Code Mode enforcement", async () => {
    const h = await createTestHarness();
    try {
      // Shared hub token has NO tenant grants -> 401
      const sharedDenied = await h.call("POST", "/api/measurement/resources", h.hubToken, {
        tenantId: "tenant-alpha",
        resourceId: "site-a",
        resourceType: "site",
        sourceResourceId: "sc-domain:a.test",
        activeFrom: "2026-01-01",
      });
      assert.equal(sharedDenied.status, 401);

      // Caller A creates tenant-alpha resource; Caller B creates tenant-beta resource
      assert.equal(
        (await h.call("POST", "/api/measurement/resources", h.tokenA, {
          tenantId: "tenant-alpha",
          resourceId: "site-a",
          resourceType: "site",
          sourceResourceId: "sc-domain:a.test",
          activeFrom: "2026-01-01",
        })).status,
        201
      );
      assert.equal(
        (await h.call("POST", "/api/measurement/resources", h.tokenB, {
          tenantId: "tenant-beta",
          resourceId: "site-b",
          resourceType: "site",
          sourceResourceId: "sc-domain:b.test",
          activeFrom: "2026-01-01",
        })).status,
        201
      );

      // Bidirectional cross-tenant denial (forged body/query tenantId)
      assert.equal(
        (await h.call("GET", "/api/measurement/coverage?tenantId=tenant-beta&resourceId=site-b", h.tokenA)).status,
        403
      );
      assert.equal(
        (await h.call("GET", "/api/measurement/coverage?tenantId=tenant-alpha&resourceId=site-a", h.tokenB)).status,
        403
      );
      assert.equal(
        (await h.call("POST", "/api/measurement/resources", h.tokenA, {
          tenantId: "tenant-beta",
          resourceId: "site-forged",
          resourceType: "site",
          sourceResourceId: "sc-domain:forged.test",
          activeFrom: "2026-01-01",
        })).status,
        403
      );

      // MCP v2 server/discover & tools/call + Code Mode search
      const discoverRes = await h.call(
        "POST",
        "/mcp",
        h.tokenA,
        { jsonrpc: "2.0", id: "d1", method: "server/discover" },
        { "MCP-Protocol-Version": "2026-07-28" }
      );
      assert.equal(discoverRes.status, 200);
      const discoverJson = (await discoverRes.json()) as any;
      assert.equal(discoverJson.result.protocolVersion, "2026-07-28");
      assert.equal(discoverJson.result.resultType, "complete");
      assert.equal(discoverJson.result.capabilities.experimental.codeMode.execute, true);

      // MCP cross-tenant denial via tool call
      const mcpCrossTenant = await h.call(
        "POST",
        "/mcp",
        h.tokenA,
        {
          jsonrpc: "2.0",
          id: "c1",
          method: "tools/call",
          params: { name: "ms_check_coverage", arguments: { tenantId: "tenant-beta", resourceId: "site-b" } },
        },
        { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "ms_check_coverage" }
      );
      assert.equal(mcpCrossTenant.status, 500);
      const mcpErr = (await mcpCrossTenant.json()) as any;
      assert.match(mcpErr.error.message, /Forbidden/);

      // Code Mode search works across all Node versions
      const cmSearch = await h.call(
        "POST",
        "/mcp",
        h.tokenA,
        { jsonrpc: "2.0", id: "s1", method: "tools/call", params: { name: "search", arguments: { query: "events" } } },
        { "MCP-Protocol-Version": "2026-07-28" }
      );
      assert.equal(cmSearch.status, 200);
      const cmSearchJson = (await cmSearch.json()) as any;
      const parsedSearch = JSON.parse(cmSearchJson.result.content[0].text);
      assert.equal(parsedSearch.entries[0].name, "queryEvents");

      // Ungranted hub token cannot bypass tenant grants via /api/task
      const hubTaskBypass = await h.call("POST", "/api/task", h.hubToken, {
        topic: "measurement.register",
        spec: {
          tenantId: "tenant-beta",
          resourceId: "site-hub-bypass",
          resourceType: "site",
          sourceResourceId: "sc-domain:bypass.test",
          activeFrom: "2026-01-01",
        },
      });
      assert.equal(hubTaskBypass.status, 401);

      // Valid scoped caller CAN submit /api/task with spec.payload and gets ONLY its own scoped coverage (never global snapshot)
      const scopedTaskOk = await h.call("POST", "/api/task", h.tokenA, {
        topic: "measurement.coverage",
        spec: { payload: { tenantId: "tenant-alpha", resourceId: "site-a" } },
      });
      assert.equal(scopedTaskOk.status, 200);
      const scopedTaskJson = (await scopedTaskOk.json()) as any;
      assert.equal(scopedTaskJson.status, "completed");
      assert.ok(Array.isArray(scopedTaskJson.result.result.items));
      assert.equal(scopedTaskJson.result.result.recentAnnotations, undefined);

      // Cross-tenant /api/task by valid scoped caller A targeting tenant-beta fails closed with 403
      const scopedTaskCross = await h.call("POST", "/api/task", h.tokenA, {
        topic: "measurement.coverage",
        spec: { payload: { tenantId: "tenant-beta", resourceId: "site-b" } },
      });
      assert.equal(scopedTaskCross.status, 403);

      // Tenant-scoped definitions do not leak across tenants (tenant-b can define same metricId independently)
      assert.equal(
        (await h.call("POST", "/api/measurement/definitions", h.tokenA, {
          tenantId: "tenant-alpha",
          metricId: "shared.name",
          version: "v1",
          family: "seo",
          unit: "clicks",
          valueType: "integer",
          grain: "daily",
          windowTz: "UTC",
          dimensionsSchema: {},
          aggregationRule: "sum",
        })).status,
        201
      );
      assert.equal(
        (await h.call("POST", "/api/measurement/definitions", h.tokenB, {
          tenantId: "tenant-beta",
          metricId: "shared.name",
          version: "v1",
          family: "analytics",
          unit: "sessions",
          valueType: "integer",
          grain: "daily",
          windowTz: "UTC",
          dimensionsSchema: {},
          aggregationRule: "sum",
        })).status,
        201
      );

      // MCP task isolation: caller B submits a task; caller A cannot list, get, cancel, or fetch receipt for it
      const subB = await h.call(
        "POST",
        "/mcp",
        h.tokenB,
        {
          jsonrpc: "2.0",
          id: "sub-b",
          method: "tools/call",
          params: { name: "submit_task", arguments: { repo: "org/b", issue: 1, requestId: "req-b-1" } },
        },
        { "MCP-Protocol-Version": "2026-07-28" }
      );
      assert.equal(subB.status, 200);
      const taskIdB = JSON.parse(((await subB.json()) as any).result.content[0].text).taskId;

      const listA = (await (
        await h.call("POST", "/mcp", h.tokenA, { jsonrpc: "2.0", id: "la", method: "tasks/list" }, { "MCP-Protocol-Version": "2026-07-28" })
      ).json()) as any;
      assert.equal(listA.result.tasks.some((t: any) => t.taskId === taskIdB), false);

      const cancelCross = await h.call(
        "POST",
        "/mcp",
        h.tokenA,
        { jsonrpc: "2.0", id: "ca", method: "tasks/cancel", params: { taskId: taskIdB } },
        { "MCP-Protocol-Version": "2026-07-28" }
      );
      assert.equal(cancelCross.status, 500);

      // get_receipt for nonexistent or unfinished task fails rather than fabricating PASS checks
      const fakeReceipt = await h.call(
        "POST",
        "/mcp",
        h.tokenB,
        { jsonrpc: "2.0", id: "rc1", method: "tools/call", params: { name: "get_receipt", arguments: { taskId: "nonexistent-task" } } },
        { "MCP-Protocol-Version": "2026-07-28" }
      );
      assert.equal(fakeReceipt.status, 500);
      assert.match(((await fakeReceipt.json()) as any).error.message, /not found/i);
    } finally {
      h.cleanup();
    }
  });

  test("capacity floor: >= 7,976 observations across 115 resources and 8 sources with recorded duration and DB bytes", async () => {
    const h = await createTestHarness();
    try {
      const svc = new MeasurementService(h.db);
      const t0 = Date.now();

      await svc.defineMetric({
        tenantId: "tenant-cap",
        metricId: "portfolio.impressions",
        version: "v1",
        family: "seo",
        unit: "impressions",
        valueType: "integer",
        grain: "daily",
        windowTz: "UTC",
        dimensionsSchema: { page: { type: "string", required: true } },
        aggregationRule: "sum",
      });

      const resourceCount = 115;
      const sources = ["gsc", "bing", "ga4", "posthog", "serp", "aio", "edge-logs", "ads"];
      for (let r = 0; r < resourceCount; r++) {
        await svc.registerResource({
          tenantId: "tenant-cap",
          resourceId: `res-${String(r + 1).padStart(3, "0")}`,
          resourceType: "site",
          sourceResourceId: `sc-domain:site-${r + 1}.test`,
          activeFrom: "2026-01-01",
        });
      }

      const evSha = await sha256Hex("deterministic-capacity-fixture");
      let totalInserted = 0;

      // 115 resources * 70 observations = 8,050 observations (>= 7,976 floor) spread across 8 sources
      for (let r = 0; r < resourceCount; r++) {
        const resourceId = `res-${String(r + 1).padStart(3, "0")}`;
        const source = sources[r % sources.length];
        const runId = `run-cap-${r + 1}`;
        await svc.createRun({
          runId,
          tenantId: "tenant-cap",
          resourceId,
          source,
          sourceResourceId: `sc-domain:site-${r + 1}.test`,
          idempotencyKey: `cap-run-${r + 1}`,
          windowStart: "2026-11-01T00:00:00Z",
          windowEnd: "2026-11-30T23:59:59Z",
        });

        const obs = [];
        for (let k = 0; k < 70; k++) {
          const day = String((k % 28) + 1).padStart(2, "0");
          obs.push({
            metricId: "portfolio.impressions",
            definitionVersion: "v1",
            windowStart: `2026-11-${day}T00:00:00Z`,
            windowEnd: `2026-11-${day}T23:59:59Z`,
            windowTz: "UTC",
            grain: "daily",
            dimensions: { page: `/p-${k}` },
            valueNum: (r + 1) * 10 + k,
            interpretationVersion: "interp-1",
            sourceRevision: 1,
            sourceAsOf: "2026-11-30T23:59:59Z",
            idempotencyKey: `cap-${r}-${k}`,
          });
        }
        const res = await svc.ingestBatch({
          tenantId: "tenant-cap",
          resourceId,
          source,
          runId,
          windowStart: "2026-11-01T00:00:00Z",
          windowEnd: "2026-11-30T23:59:59Z",
          evidence: {
            evidenceId: `ev-cap-${r + 1}`,
            uriPointer: `fixture://cap/${resourceId}.json`,
            sha256: evSha,
            byteSize: 1024,
            mediaType: "application/json",
            privacyClass: "internal",
            retentionClass: "90d",
            collectedAt: "2026-12-01T00:00:00Z",
            sourceAsOf: "2026-11-30T23:59:59Z",
            adapterName: "cap-fixture",
            adapterVersion: "1.0.0",
          },
          observations: obs,
          coverage: { status: "successful", reconciliationStatus: "matched" },
        });
        totalInserted += res.inserted;
      }

      const ingestMs = Date.now() - t0;
      const q0 = Date.now();
      const series = await svc.querySeries({
        tenantId: "tenant-cap",
        resourceId: "res-050",
        metricId: "portfolio.impressions",
        limit: 100,
      });
      const queryMs = Date.now() - q0;
      const dbBytes = statSync(h.dbPath).size;

      assert.ok(totalInserted >= 7976, `Expected >= 7976 observations, got ${totalInserted}`);
      assert.equal(series.points.length, 70);
      console.log(
        `[capacity-floor] observations=${totalInserted} resources=${resourceCount} sources=${sources.length} ingestMs=${ingestMs} queryMs=${queryMs} dbBytes=${dbBytes}`
      );
    } finally {
      h.cleanup();
    }
  });

  test("local loopback server starts on 127.0.0.1, serves /health + cockpit + /api/measurement/*, and shuts down cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-pod-loopback-"));
    const tokenA = "loopback-token-a";
    const pod = await startLocalMeasurementPod({
      host: "127.0.0.1",
      port: 0,
      dbPath: join(dir, "loopback.sqlite"),
      env: {
        FACTORY_HUB_TOKEN: "loopback-hub",
        SCOPED_CALLER_GRANTS: JSON.stringify([
          {
            callerId: "loopback-a",
            tokenSha256: await sha256Hex(tokenA),
            grants: [{ tenantId: "t1", resourceIds: ["*"], actions: ["read", "write"] }],
          },
        ]),
      },
    });
    const reqLoopback = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: pod.port, path, method, headers },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (c) => { text += c; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
          }
        );
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
      });
    try {
      const healthRes = await reqLoopback("GET", "/health");
      assert.equal(healthRes.status, 200);
      const health = JSON.parse(healthRes.text);
      assert.equal(health.status, "healthy");
      assert.equal(health.podId, "measurement-pod");

      const reg = await reqLoopback(
        "POST",
        "/api/measurement/resources",
        { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
        JSON.stringify({
          tenantId: "t1",
          resourceId: "site-1",
          resourceType: "site",
          sourceResourceId: "sc-domain:t1.test",
          activeFrom: "2026-01-01",
        })
      );
      assert.equal(reg.status, 201);

      const cockpit = await reqLoopback("GET", "/", { Authorization: "Bearer loopback-hub" });
      assert.equal(cockpit.status, 200);
      assert.match(cockpit.text, /Measurement Pod/);
    } finally {
      await pod.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("POST /api/measurement/ingest-atomic commits multi-group and 501..1000 batches atomically and rolls back all-or-nothing on conflict or auth denial", async () => {
    const h = await createTestHarness();
    try {
      // Register two resources and two metric definitions
      for (const r of [
        { tenantId: "tenant-alpha", resourceId: "site-alpha", resourceType: "site", sourceResourceId: "sc-domain:alpha.test", activeFrom: "2026-01-01" },
        { tenantId: "tenant-alpha", resourceId: "site-beta", resourceType: "site", sourceResourceId: "sc-domain:beta.test", activeFrom: "2026-01-01" },
      ]) {
        assert.equal((await h.call("POST", "/api/measurement/resources", h.tokenA, r)).status, 201);
      }
      for (const d of [
        {
          tenantId: "tenant-alpha", metricId: "gsc.clicks", version: "v1", family: "seo",
          unit: "count", valueType: "integer", grain: "daily", windowTz: "UTC",
          dimensionsSchema: { page: { type: "string", required: true } }, aggregationRule: "sum",
        },
        {
          tenantId: "tenant-alpha", metricId: "signup.rate", version: "v1", family: "analytics",
          unit: "ratio", valueType: "decimal_string", grain: "daily", windowTz: "UTC",
          dimensionsSchema: { cta: { type: "string", required: true } }, aggregationRule: "ratio",
        },
      ]) {
        assert.equal((await h.call("POST", "/api/measurement/definitions", h.tokenA, d)).status, 201);
      }

      const sha1 = await sha256Hex("ev-1");
      const sha2 = await sha256Hex("ev-2");
      const mkEv = (id: string, sha: string) => ({
        evidenceId: id,
        uriPointer: `evidence://orrery/${sha}`,
        sha256: sha,
        byteSize: 12,
        mediaType: "application/json",
        privacyClass: "internal" as const,
        retentionClass: "90d",
        collectedAt: "2026-11-20T00:00:00Z",
        sourceAsOf: "2026-11-19T00:00:00Z",
        adapterName: "orrery",
        adapterVersion: "1.0.0",
      });

      // 1. Atomic multi-group commit (2 resources, 2 source families, 2 evidence handles, inline run creation)
      const atomicPayload = {
        tenantId: "tenant-alpha",
        groups: [
          {
            resourceId: "site-alpha",
            source: "gsc_export",
            runId: "run-atomic-g1",
            runIdempotencyKey: "idem-run-atomic-g1",
            sourceResourceId: "sc-domain:alpha.test",
            windowStart: "2026-11-19",
            windowEnd: "2026-11-19",
            runStatus: "succeeded",
            evidence: mkEv("ev-atomic-1", sha1),
            observations: [
              {
                metricId: "gsc.clicks", definitionVersion: "v1",
                windowStart: "2026-11-19", windowEnd: "2026-11-19", windowTz: "UTC", grain: "daily",
                dimensions: { page: "/home" }, valueNum: 42,
                interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-11-19T00:00:00Z",
                idempotencyKey: "obs-atomic-g1-1",
              },
            ],
            coverage: { status: "successful", reconciliationStatus: "matched" },
          },
          {
            resourceId: "site-beta",
            source: "analytics",
            runId: "run-atomic-g2",
            runIdempotencyKey: "idem-run-atomic-g2",
            sourceResourceId: "sc-domain:beta.test",
            windowStart: "2026-11-19",
            windowEnd: "2026-11-19",
            runStatus: "succeeded",
            evidence: mkEv("ev-atomic-2", sha2),
            observations: [
              {
                metricId: "signup.rate", definitionVersion: "v1",
                windowStart: "2026-11-19", windowEnd: "2026-11-19", windowTz: "UTC", grain: "daily",
                dimensions: { cta: "hero" }, valueText: "0.25", numerator: 1, denominator: 4,
                interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-11-19T00:00:00Z",
                idempotencyKey: "obs-atomic-g2-1",
              },
            ],
            coverage: { status: "successful", reconciliationStatus: "matched" },
          },
        ],
      };

      const res1 = await h.call("POST", "/api/measurement/ingest-atomic", h.tokenA, atomicPayload);
      assert.equal(res1.status, 200);
      const body1 = (await res1.json()) as any;
      assert.equal(body1.inserted, 2);
      assert.equal(body1.replayedNoop, 0);

      // Replay is idempotent no-op
      const replayRes = await h.call("POST", "/api/measurement/ingest-atomic", h.tokenA, atomicPayload);
      assert.equal(replayRes.status, 200);
      const replayBody = (await replayRes.json()) as any;
      assert.equal(replayBody.inserted, 0);
      assert.equal(replayBody.replayedNoop, 2);

      // 2. All-or-nothing rollback: group 1 is brand-new, group 2 conflicts with existing obs-atomic-g2-1 -> 409 and ZERO rows from group 1!
      const conflictRes = await h.call("POST", "/api/measurement/ingest-atomic", h.tokenA, {
        tenantId: "tenant-alpha",
        groups: [
          {
            resourceId: "site-alpha",
            source: "gsc_export",
            runId: "run-should-rollback",
            runIdempotencyKey: "idem-run-should-rollback",
            sourceResourceId: "sc-domain:alpha.test",
            windowStart: "2026-11-20",
            windowEnd: "2026-11-20",
            evidence: mkEv("ev-should-rollback", await sha256Hex("ev-rb")),
            observations: [
              {
                metricId: "gsc.clicks", definitionVersion: "v1",
                windowStart: "2026-11-20", windowEnd: "2026-11-20", windowTz: "UTC", grain: "daily",
                dimensions: { page: "/rollback" }, valueNum: 99,
                interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-11-20T00:00:00Z",
                idempotencyKey: "obs-should-rollback",
              },
            ],
          },
          {
            resourceId: "site-beta",
            source: "analytics",
            runId: "run-atomic-g2",
            runIdempotencyKey: "idem-run-atomic-g2",
            sourceResourceId: "sc-domain:beta.test",
            windowStart: "2026-11-19",
            windowEnd: "2026-11-19",
            evidence: mkEv("ev-atomic-2", sha2),
            observations: [
              {
                metricId: "signup.rate", definitionVersion: "v1",
                windowStart: "2026-11-19", windowEnd: "2026-11-19", windowTz: "UTC", grain: "daily",
                dimensions: { cta: "hero" }, valueText: "0.5", numerator: 2, denominator: 4,
                interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-11-19T00:00:00Z",
                idempotencyKey: "obs-atomic-g2-1",
              },
            ],
          },
        ],
      });
      assert.equal(conflictRes.status, 409);
      const runCheck = await h.call("GET", "/api/measurement/runs/run-should-rollback?tenantId=tenant-alpha", h.tokenA);
      assert.equal(runCheck.status, 404);
      const evCheck = await h.call("GET", "/api/measurement/evidence/ev-should-rollback?tenantId=tenant-alpha", h.tokenA);
      assert.equal(evCheck.status, 404);

      // 3. 600-observation single-group atomic batch (>500, <=1000) succeeds; 1001 rejected with 400
      const obs600 = Array.from({ length: 600 }, (_, i) => ({
        metricId: "gsc.clicks", definitionVersion: "v1",
        windowStart: "2026-11-21", windowEnd: "2026-11-21", windowTz: "UTC", grain: "daily",
        dimensions: { page: `/p/${i}` }, valueNum: i,
        interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-11-21T00:00:00Z",
        idempotencyKey: `obs-600-${i}`,
      }));
      const res600 = await h.call("POST", "/api/measurement/ingest-atomic", h.tokenA, {
        tenantId: "tenant-alpha",
        groups: [{
          resourceId: "site-alpha",
          source: "gsc_export",
          runId: "run-atomic-600",
          runIdempotencyKey: "idem-run-atomic-600",
          sourceResourceId: "sc-domain:alpha.test",
          windowStart: "2026-11-21",
          windowEnd: "2026-11-21",
          evidence: mkEv("ev-atomic-600", await sha256Hex("ev-600")),
          observations: obs600,
        }],
      });
      assert.equal(res600.status, 200);
      assert.equal(((await res600.json()) as any).inserted, 600);

      const obs1001 = Array.from({ length: 1001 }, (_, i) => ({
        metricId: "gsc.clicks", definitionVersion: "v1",
        windowStart: "2026-11-22", windowEnd: "2026-11-22", windowTz: "UTC", grain: "daily",
        dimensions: { page: `/over/${i}` }, valueNum: i,
        interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-11-22T00:00:00Z",
        idempotencyKey: `obs-over-${i}`,
      }));
      const res1001 = await h.call("POST", "/api/measurement/ingest-atomic", h.tokenA, {
        tenantId: "tenant-alpha",
        groups: [{
          resourceId: "site-alpha",
          source: "gsc_export",
          runId: "run-atomic-1001",
          runIdempotencyKey: "idem-run-atomic-1001",
          sourceResourceId: "sc-domain:alpha.test",
          windowStart: "2026-11-22",
          windowEnd: "2026-11-22",
          evidence: mkEv("ev-atomic-1001", await sha256Hex("ev-1001")),
          observations: obs1001,
        }],
      });
      assert.equal(res1001.status, 400);

      // 4. Resource-scoped auth fail-closed: token granted only site-alpha MUST get 403 when group 2 targets site-beta
      const narrowToken = "narrow-site-alpha-only-token";
      const narrowGrants = [
        ...JSON.parse(h.env.SCOPED_CALLER_GRANTS!),
        {
          callerId: "narrow-alpha",
          tokenSha256: await sha256Hex(narrowToken),
          grants: [{ tenantId: "tenant-alpha", resourceIds: ["site-alpha"], actions: ["read", "write"] }],
        },
      ];
      h.env.SCOPED_CALLER_GRANTS = JSON.stringify(narrowGrants);
      const deniedRes = await h.call("POST", "/api/measurement/ingest-atomic", narrowToken, {
        tenantId: "tenant-alpha",
        groups: [
          {
            resourceId: "site-alpha",
            source: "gsc_export",
            runId: "run-narrow-deny",
            runIdempotencyKey: "idem-narrow-deny",
            sourceResourceId: "sc-domain:alpha.test",
            windowStart: "2026-11-23",
            windowEnd: "2026-11-23",
            evidence: mkEv("ev-narrow-deny", await sha256Hex("ev-narrow")),
            observations: [{
              metricId: "gsc.clicks", definitionVersion: "v1",
              windowStart: "2026-11-23", windowEnd: "2026-11-23", windowTz: "UTC", grain: "daily",
              dimensions: { page: "/narrow" }, valueNum: 1,
              interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-11-23T00:00:00Z",
              idempotencyKey: "obs-narrow-deny",
            }],
          },
          {
            resourceId: "site-beta",
            source: "gsc_export",
            runId: "run-narrow-deny-2",
            runIdempotencyKey: "idem-narrow-deny-2",
            sourceResourceId: "sc-domain:beta.test",
            windowStart: "2026-11-23",
            windowEnd: "2026-11-23",
            evidence: mkEv("ev-narrow-deny-2", await sha256Hex("ev-narrow-2")),
            observations: [{
              metricId: "gsc.clicks", definitionVersion: "v1",
              windowStart: "2026-11-23", windowEnd: "2026-11-23", windowTz: "UTC", grain: "daily",
              dimensions: { page: "/narrow-beta" }, valueNum: 1,
              interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-11-23T00:00:00Z",
              idempotencyKey: "obs-narrow-deny-2",
            }],
          },
        ],
      });
      assert.equal(deniedRes.status, 403);
      assert.equal((await h.call("GET", "/api/measurement/runs/run-narrow-deny?tenantId=tenant-alpha", h.tokenA)).status, 404);

      // 5. Conflicting runIdempotencyKey for the same new runId inside one atomic batch MUST fail with 409
      const dupRunKeyRes = await h.call("POST", "/api/measurement/ingest-atomic", h.tokenA, {
        tenantId: "tenant-alpha",
        groups: [
          {
            resourceId: "site-alpha",
            source: "gsc_export",
            runId: "run-same-new-id",
            runIdempotencyKey: "key-A",
            sourceResourceId: "sc-domain:alpha.test",
            windowStart: "2026-11-24",
            windowEnd: "2026-11-24",
            evidence: mkEv("ev-same-run-1", await sha256Hex("ev-same-run-1")),
            observations: [{
              metricId: "gsc.clicks", definitionVersion: "v1",
              windowStart: "2026-11-24", windowEnd: "2026-11-24", windowTz: "UTC", grain: "daily",
              dimensions: { page: "/same-run-a" }, valueNum: 1,
              interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-11-24T00:00:00Z",
              idempotencyKey: "obs-same-run-a",
            }],
          },
          {
            resourceId: "site-alpha",
            source: "gsc_export",
            runId: "run-same-new-id",
            runIdempotencyKey: "key-B",
            sourceResourceId: "sc-domain:alpha.test",
            windowStart: "2026-11-24",
            windowEnd: "2026-11-24",
            evidence: mkEv("ev-same-run-2", await sha256Hex("ev-same-run-2")),
            observations: [{
              metricId: "gsc.clicks", definitionVersion: "v1",
              windowStart: "2026-11-24", windowEnd: "2026-11-24", windowTz: "UTC", grain: "daily",
              dimensions: { page: "/same-run-b" }, valueNum: 2,
              interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-11-24T00:00:00Z",
              idempotencyKey: "obs-same-run-b",
            }],
          },
        ],
      });
      assert.equal(dupRunKeyRes.status, 409);
      assert.equal((await h.call("GET", "/api/measurement/runs/run-same-new-id?tenantId=tenant-alpha", h.tokenA)).status, 404);

      // 6. Query budget check: a 1,000-observation atomic batch MUST execute well below D1's 1,000-query/invocation limit
      let dbQueries = 0;
      const origPrepare = h.db.prepare.bind(h.db);
      const origBatch = h.db.batch.bind(h.db);
      const countedDb = {
        prepare(sql: string) {
          const stmt = origPrepare(sql);
          return {
            bind(...params: any[]) {
              const bound = stmt.bind(...params);
              return {
                first: (...a: any[]) => { dbQueries += 1; return (bound.first as any)(...a); },
                all: (...a: any[]) => { dbQueries += 1; return (bound.all as any)(...a); },
                run: (...a: any[]) => { dbQueries += 1; return (bound.run as any)(...a); },
                _raw: bound,
              };
            },
            first: (...a: any[]) => { dbQueries += 1; return (stmt.first as any)(...a); },
            all: (...a: any[]) => { dbQueries += 1; return (stmt.all as any)(...a); },
            run: (...a: any[]) => { dbQueries += 1; return (stmt.run as any)(...a); },
          };
        },
        batch(stmts: any[]) {
          dbQueries += 1;
          return origBatch(stmts.map((s) => s._raw ?? s));
        },
      };
      const countedSvc = new MeasurementService(countedDb as any);
      const obs1000 = Array.from({ length: 1000 }, (_, i) => ({
        metricId: "gsc.clicks", definitionVersion: "v1",
        windowStart: "2026-11-25", windowEnd: "2026-11-25", windowTz: "UTC", grain: "daily",
        dimensions: { page: `/q1000/${i}` }, valueNum: i,
        interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-11-25T00:00:00Z",
        idempotencyKey: `obs-q1000-${i}`,
      }));
      const res1000 = await countedSvc.ingestAtomicBatch({
        tenantId: "tenant-alpha",
        groups: [{
          resourceId: "site-alpha",
          source: "gsc_export",
          runId: "run-atomic-1000-qbudget",
          runIdempotencyKey: "idem-run-atomic-1000-qbudget",
          sourceResourceId: "sc-domain:alpha.test",
          windowStart: "2026-11-25",
          windowEnd: "2026-11-25",
          evidence: mkEv("ev-atomic-1000-qbudget", await sha256Hex("ev-1000-qb")),
          observations: obs1000,
        }],
      });
      assert.equal(res1000.inserted, 1000);
      assert.ok(dbQueries < 30, `Expected < 30 DB queries for 1,000-obs atomic batch, got ${dbQueries}`);

      // 7. Delimiter collision regression: registering metric 'clicks@v1' version 'blue' must NOT match 'clicks' version 'v1@blue'
      assert.equal(
        (await h.call("POST", "/api/measurement/definitions", h.tokenA, {
          tenantId: "tenant-alpha",
          metricId: "clicks@v1",
          version: "blue",
          family: "seo",
          unit: "count",
          valueType: "integer",
          grain: "daily",
          windowTz: "UTC",
          dimensionsSchema: { page: { type: "string", required: true } },
          aggregationRule: "sum",
        })).status,
        201
      );
      const delimRes = await h.call("POST", "/api/measurement/ingest-atomic", h.tokenA, {
        tenantId: "tenant-alpha",
        groups: [{
          resourceId: "site-alpha",
          source: "gsc_export",
          runId: "run-delim-check",
          runIdempotencyKey: "idem-delim-check",
          sourceResourceId: "sc-domain:alpha.test",
          windowStart: "2026-11-26",
          windowEnd: "2026-11-26",
          evidence: mkEv("ev-delim-check", await sha256Hex("ev-delim-check")),
          observations: [{
            metricId: "clicks",
            definitionVersion: "v1@blue",
            windowStart: "2026-11-26",
            windowEnd: "2026-11-26",
            windowTz: "UTC",
            grain: "daily",
            dimensions: { page: "/delim" },
            valueNum: 5,
            interpretationVersion: "v1",
            sourceRevision: 1,
            sourceAsOf: "2026-11-26T00:00:00Z",
            idempotencyKey: "obs-delim-check",
          }],
        }],
      });
      assert.equal(delimRes.status, 400);

      // 8. 150-group atomic batch (>100, <=1000 groups) commits atomically with bounded DB queries (<80)
      const groups150 = await Promise.all(
        Array.from({ length: 150 }, async (_, i) => ({
          resourceId: "site-alpha",
          source: "gsc_export",
          runId: `run-g150-${i}`,
          runIdempotencyKey: `idem-g150-${i}`,
          sourceResourceId: "sc-domain:alpha.test",
          windowStart: "2026-11-27",
          windowEnd: "2026-11-27",
          evidence: mkEv(`ev-g150-${i}`, await sha256Hex(`ev-g150-${i}`)),
          observations: [{
            metricId: "gsc.clicks", definitionVersion: "v1",
            windowStart: "2026-11-27", windowEnd: "2026-11-27", windowTz: "UTC", grain: "daily",
            dimensions: { page: `/g150/${i}` }, valueNum: i,
            interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-11-27T00:00:00Z",
            idempotencyKey: `obs-g150-${i}`,
          }],
        }))
      );
      dbQueries = 0;
      const res150 = await countedSvc.ingestAtomicBatch({ tenantId: "tenant-alpha", groups: groups150 });
      assert.equal(res150.inserted, 150);
      assert.ok(dbQueries < 30, `Expected < 30 DB queries for 150-group atomic batch, got ${dbQueries}`);

      // 9. Staged multi-chunk import (>1,000 observations): invisible until commit, atomic 409 rollback, cross-tenant isolated
      const mkChunkObs = (prefix: string, start: number, count: number) =>
        Array.from({ length: count }, (_, idx) => ({
          metricId: "gsc.clicks", definitionVersion: "v1",
          windowStart: "2026-11-28", windowEnd: "2026-11-28", windowTz: "UTC", grain: "daily",
          dimensions: { page: `/${prefix}/${start + idx}` }, valueNum: start + idx,
          interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-11-28T00:00:00Z",
          idempotencyKey: `obs-${prefix}-${start + idx}`,
        }));

      const stageEvSha = await sha256Hex("ev-staged-1200");
      const stageEv = mkEv("ev-staged-1200", stageEvSha);
      const st0 = await h.call("POST", "/api/measurement/imports/stage", h.tokenA, {
        tenantId: "tenant-alpha",
        importId: "imp-1200",
        chunkIndex: 0,
        groups: [{
          resourceId: "site-alpha", source: "gsc_export",
          runId: "run-staged-1200", runIdempotencyKey: "idem-staged-1200",
          sourceResourceId: "sc-domain:alpha.test",
          windowStart: "2026-11-28", windowEnd: "2026-11-28",
          evidence: stageEv, observations: mkChunkObs("st1200", 0, 600),
        }],
      });
      assert.equal(st0.status, 201);
      // Before commit, ZERO observations from imp-1200 are visible in querySeries!
      const preCommit = (await (await h.call("GET", "/api/measurement/series?tenantId=tenant-alpha&resourceId=site-alpha&metricId=gsc.clicks&windowStart=2026-11-28&windowEnd=2026-11-28", h.tokenA)).json()) as any;
      assert.equal(preCommit.total, 0);

      // Cross-tenant commit and abort attempts with tenant-beta token MUST fail closed with uniform 403 (zero resource ID or existence disclosure)
      const crossCommitExisting = await h.call("POST", "/api/measurement/imports/imp-1200/commit", h.tokenB, {
        tenantId: "tenant-alpha", expectedChunks: 1,
      });
      const crossCommitMissing = await h.call("POST", "/api/measurement/imports/imp-does-not-exist/commit", h.tokenB, {
        tenantId: "tenant-alpha", expectedChunks: 1,
      });
      const crossAbortExisting = await h.call("POST", "/api/measurement/imports/imp-1200/abort", h.tokenB, {
        tenantId: "tenant-alpha",
      });
      const crossAbortMissing = await h.call("POST", "/api/measurement/imports/imp-does-not-exist/abort", h.tokenB, {
        tenantId: "tenant-alpha",
      });
      assert.equal(crossCommitExisting.status, 403);
      assert.equal(crossCommitMissing.status, 403);
      assert.equal(crossAbortExisting.status, 403);
      assert.equal(crossAbortMissing.status, 403);
      const crossCommitExistingBody = await crossCommitExisting.text();
      assert.equal(crossCommitExistingBody, JSON.stringify({ error: "forbidden" }));
      assert.equal(await crossCommitMissing.text(), crossCommitExistingBody);
      assert.equal(await crossAbortExisting.text(), crossCommitExistingBody);
      assert.equal(await crossAbortMissing.text(), crossCommitExistingBody);
      assert.doesNotMatch(crossCommitExistingBody, /site-alpha/);

      // Stage chunk 1 with remaining 600 observations, then commit atomically -> all 1,200 visible at once!
      const st1 = await h.call("POST", "/api/measurement/imports/stage", h.tokenA, {
        tenantId: "tenant-alpha",
        importId: "imp-1200",
        chunkIndex: 1,
        groups: [{
          resourceId: "site-alpha", source: "gsc_export",
          runId: "run-staged-1200", runIdempotencyKey: "idem-staged-1200",
          sourceResourceId: "sc-domain:alpha.test",
          windowStart: "2026-11-28", windowEnd: "2026-11-28",
          evidence: stageEv, observations: mkChunkObs("st1200", 600, 600),
        }],
      });
      assert.equal(st1.status, 201);
      const commitRes = await h.call("POST", "/api/measurement/imports/imp-1200/commit", h.tokenA, {
        tenantId: "tenant-alpha", expectedChunks: 2,
      });
      assert.equal(commitRes.status, 200);
      assert.equal(((await commitRes.json()) as any).inserted, 1200);
      const postCommit = (await (await h.call("GET", "/api/measurement/series?tenantId=tenant-alpha&resourceId=site-alpha&metricId=gsc.clicks&windowStart=2026-11-28&windowEnd=2026-11-28&limit=500", h.tokenA)).json()) as any;
      assert.equal(postCommit.total, 1200);
      // Verify monotonic positive recordSeq unconditionally on known points
      const pt0 = (await (await h.call(
        "GET",
        `/api/measurement/series?tenantId=tenant-alpha&resourceId=site-alpha&metricId=gsc.clicks&windowStart=2026-11-28&windowEnd=2026-11-28&dimensions=${encodeURIComponent(JSON.stringify({ page: "/st1200/0" }))}`,
        h.tokenA
      )).json()) as any;
      const pt1 = (await (await h.call(
        "GET",
        `/api/measurement/series?tenantId=tenant-alpha&resourceId=site-alpha&metricId=gsc.clicks&windowStart=2026-11-28&windowEnd=2026-11-28&dimensions=${encodeURIComponent(JSON.stringify({ page: "/st1200/1" }))}`,
        h.tokenA
      )).json()) as any;
      assert.equal(pt0.points.length, 1);
      assert.equal(pt1.points.length, 1);
      assert.ok(typeof pt0.points[0].recordSeq === "number" && pt0.points[0].recordSeq > 0);
      assert.ok(pt0.points[0].recordSeq < pt1.points[0].recordSeq);

      // Durable completion receipt: sequential retry after commit succeeds idempotently (200, not 404); mismatched expectedChunks fails with 409; re-staging fails with 409
      const commitRetryRes = await h.call("POST", "/api/measurement/imports/imp-1200/commit", h.tokenA, {
        tenantId: "tenant-alpha", expectedChunks: 2,
      });
      assert.equal(commitRetryRes.status, 200);
      const commitRetryBody = (await commitRetryRes.json()) as any;
      assert.equal(commitRetryBody.inserted, 0);
      assert.equal(commitRetryBody.replayedNoop, 1200);
      const commitMismatchRes = await h.call("POST", "/api/measurement/imports/imp-1200/commit", h.tokenA, {
        tenantId: "tenant-alpha", expectedChunks: 1,
      });
      assert.equal(commitMismatchRes.status, 409);
      const restageAfterCommit = await h.call("POST", "/api/measurement/imports/stage", h.tokenA, {
        tenantId: "tenant-alpha",
        importId: "imp-1200",
        chunkIndex: 0,
        groups: [{
          resourceId: "site-alpha", source: "gsc_export",
          runId: "run-staged-1200", runIdempotencyKey: "idem-staged-1200",
          sourceResourceId: "sc-domain:alpha.test",
          windowStart: "2026-11-28", windowEnd: "2026-11-28",
          evidence: stageEv, observations: mkChunkObs("st1200", 0, 1),
        }],
      });
      assert.equal(restageAfterCommit.status, 409);

      // Staged import with conflict in chunk 1 commits ZERO rows from chunk 0 on commit!
      const badEv = mkEv("ev-staged-bad", await sha256Hex("ev-staged-bad"));
      assert.equal((await h.call("POST", "/api/measurement/imports/stage", h.tokenA, {
        tenantId: "tenant-alpha", importId: "imp-bad", chunkIndex: 0,
        groups: [{
          resourceId: "site-alpha", source: "gsc_export",
          runId: "run-staged-bad", runIdempotencyKey: "idem-staged-bad",
          sourceResourceId: "sc-domain:alpha.test",
          windowStart: "2026-11-29", windowEnd: "2026-11-29",
          evidence: badEv, observations: mkChunkObs("stbad", 0, 5),
        }],
      })).status, 201);
      assert.equal((await h.call("POST", "/api/measurement/imports/stage", h.tokenA, {
        tenantId: "tenant-alpha", importId: "imp-bad", chunkIndex: 1,
        groups: [{
          resourceId: "site-alpha", source: "gsc_export",
          runId: "run-staged-bad", runIdempotencyKey: "idem-staged-bad",
          sourceResourceId: "sc-domain:alpha.test",
          windowStart: "2026-11-29", windowEnd: "2026-11-29",
          evidence: stageEv,
          observations: [{
            metricId: "gsc.clicks", definitionVersion: "v1",
            windowStart: "2026-11-28", windowEnd: "2026-11-28", windowTz: "UTC", grain: "daily",
            dimensions: { page: "/st1200/0" }, valueNum: 99999,
            interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-11-28T00:00:00Z",
            idempotencyKey: "obs-st1200-0",
          }],
        }],
      })).status, 201);
      const badCommit = await h.call("POST", "/api/measurement/imports/imp-bad/commit", h.tokenA, {
        tenantId: "tenant-alpha", expectedChunks: 2,
      });
      assert.equal(badCommit.status, 409);
      const afterBad = (await (await h.call("GET", "/api/measurement/series?tenantId=tenant-alpha&resourceId=site-alpha&metricId=gsc.clicks&windowStart=2026-11-29&windowEnd=2026-11-29", h.tokenA)).json()) as any;
      assert.equal(afterBad.total, 0);
      assert.equal((await h.call("POST", "/api/measurement/imports/imp-bad/abort", h.tokenA, { tenantId: "tenant-alpha" })).status, 200);

      // 10. Regression checks for staged-import races, TOCTOU isolation, and batched read query budget:
      // 10a. Batched prefetch reads keep a multi-chunk staged import with 1,200 single-observation groups to <= 4 DB calls!
      const singleObsGroups = await Promise.all(
        Array.from({ length: 1200 }, async (_, i) => ({
          resourceId: "site-alpha",
          source: "gsc_export",
          runId: `run-q4-${i}`,
          runIdempotencyKey: `idem-q4-${i}`,
          sourceResourceId: "sc-domain:alpha.test",
          windowStart: "2026-11-30",
          windowEnd: "2026-11-30",
          evidence: mkEv(`ev-q4-${i}`, await sha256Hex(`ev-q4-${i}`)),
          observations: [{
            metricId: "gsc.clicks", definitionVersion: "v1",
            windowStart: "2026-11-30", windowEnd: "2026-11-30", windowTz: "UTC", grain: "daily",
            dimensions: { page: `/q4/${i}` }, valueNum: i,
            interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-11-30T00:00:00Z",
            idempotencyKey: `obs-q4-${i}`,
          }],
        }))
      );
      await countedSvc.stageImportChunk({ tenantId: "tenant-alpha", importId: "imp-q4", chunkIndex: 0, groups: singleObsGroups.slice(0, 600) });
      await countedSvc.stageImportChunk({ tenantId: "tenant-alpha", importId: "imp-q4", chunkIndex: 1, groups: singleObsGroups.slice(600, 1200) });
      dbQueries = 0;
      const q4Commit = await countedSvc.commitStagedImport({ tenantId: "tenant-alpha", importId: "imp-q4", expectedChunks: 2 });
      assert.equal(q4Commit.inserted, 1200);
      assert.ok(dbQueries <= 4, `Expected <= 4 DB invocation calls (batched reads + write) for 1,200-group staged commit, got ${dbQueries}`);

      // 10b. Concurrent/duplicate staging returns 200 (identical) or 409 (conflicting), never 500
      const raceGroup = [{
        resourceId: "site-alpha", source: "gsc_export",
        runId: "run-race-stage", runIdempotencyKey: "idem-race-stage",
        sourceResourceId: "sc-domain:alpha.test",
        windowStart: "2026-12-01", windowEnd: "2026-12-01",
        evidence: mkEv("ev-race-stage", await sha256Hex("ev-race-stage")),
        observations: [{
          metricId: "gsc.clicks", definitionVersion: "v1",
          windowStart: "2026-12-01", windowEnd: "2026-12-01", windowTz: "UTC", grain: "daily",
          dimensions: { page: "/race-stage" }, valueNum: 1,
          interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-12-01T00:00:00Z",
          idempotencyKey: "obs-race-stage",
        }],
      }];
      const [rStage1, rStage2] = await Promise.all([
        h.call("POST", "/api/measurement/imports/stage", h.tokenA, { tenantId: "tenant-alpha", importId: "imp-race", chunkIndex: 0, groups: raceGroup }),
        h.call("POST", "/api/measurement/imports/stage", h.tokenA, { tenantId: "tenant-alpha", importId: "imp-race", chunkIndex: 0, groups: raceGroup }),
      ]);
      assert.deepEqual([rStage1.status, rStage2.status].sort(), [200, 201]);
      const diffStage = await h.call("POST", "/api/measurement/imports/stage", h.tokenA, {
        tenantId: "tenant-alpha", importId: "imp-race", chunkIndex: 0,
        groups: [{ ...raceGroup[0], observations: [{ ...raceGroup[0].observations[0], valueNum: 2 }] }],
      });
      assert.equal(diffStage.status, 409);

      // 10c. Concurrent unseen chunk arriving AFTER commit/abort snapshot read is NEVER committed without auth and NEVER deleted!
      let injectedAfterRead = false;
      const interceptDb = {
        prepare(sql: string) {
          const stmt = origPrepare(sql);
          return {
            bind(...params: any[]) {
              const bound = stmt.bind(...params);
              return {
                first: (...a: any[]) => (bound.first as any)(...a),
                all: (...a: any[]) => (bound.all as any)(...a),
                run: (...a: any[]) => (bound.run as any)(...a),
                _raw: bound,
                _sql: sql,
              };
            },
            first: (...a: any[]) => (stmt.first as any)(...a),
            all: (...a: any[]) => (stmt.all as any)(...a),
            run: (...a: any[]) => (stmt.run as any)(...a),
          };
        },
        async batch(stmts: any[]) {
          const res = await origBatch(stmts.map((s) => s._raw ?? s));
          if (
            !injectedAfterRead &&
            stmts.some((s) => typeof s._sql === "string" && s._sql.includes("FROM ms_staged_imports WHERE tenant_id = ? AND import_id = ?"))
          ) {
            injectedAfterRead = true;
            // Simulate chunk 1 for site-beta arriving right after snapshot read!
            await origPrepare(
              "INSERT INTO ms_staged_imports (tenant_id, import_id, chunk_index, generation_id, resource_ids_json, groups_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
            )
              .bind(
                "tenant-alpha",
                "imp-race",
                1,
                "gen-beta-unseen-1",
                JSON.stringify(["site-beta"]),
                JSON.stringify([{
                  resourceId: "site-beta", source: "gsc_export",
                  runId: "run-beta-unseen", runIdempotencyKey: "idem-beta-unseen",
                  sourceResourceId: "sc-domain:beta.test",
                  windowStart: "2026-12-01", windowEnd: "2026-12-01",
                  evidence: mkEv("ev-beta-unseen", await sha256Hex("ev-beta-unseen")),
                  observations: [{
                    metricId: "gsc.clicks", definitionVersion: "v1",
                    windowStart: "2026-12-01", windowEnd: "2026-12-01", windowTz: "UTC", grain: "daily",
                    dimensions: { page: "/beta-unseen" }, valueNum: 77,
                    interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-12-01T00:00:00Z",
                    idempotencyKey: "obs-beta-unseen",
                  }],
                }]),
                Date.now()
              )
              .run();
          }
          return res;
        },
      };
      const interceptSvc = new MeasurementService(interceptDb as any);
      const narrowCommit = await interceptSvc.commitStagedImport(
        { tenantId: "tenant-alpha", importId: "imp-race", expectedChunks: 1 },
        Date.now(),
        {
          authorizeResourceWrite: (rid: string) => {
            if (rid !== "site-alpha") throw new Error("forbidden");
          },
        }
      );
      assert.equal(narrowCommit.inserted, 1);
      // Chunk 1 (site-beta) MUST still remain intact in ms_staged_imports (NOT deleted!) and NOT committed!
      const remainingStaged = await h.db
        .prepare("SELECT chunk_index FROM ms_staged_imports WHERE tenant_id = ? AND import_id = ?")
        .bind("tenant-alpha", "imp-race")
        .all<any>();
      assert.deepEqual((remainingStaged.results || []).map((r: any) => Number(r.chunk_index)), [1]);
      assert.equal((await h.call("GET", "/api/measurement/runs/run-beta-unseen?tenantId=tenant-alpha", h.tokenA)).status, 404);
      // Narrow caller attempting to abort now sees site-beta chunk 1 and MUST receive uniform 403 (zero resource ID leak)!
      const narrowAbortDenied = await h.call("POST", "/api/measurement/imports/imp-race/abort", narrowToken, { tenantId: "tenant-alpha" });
      assert.equal(narrowAbortDenied.status, 403);
      assert.equal(await narrowAbortDenied.text(), JSON.stringify({ error: "forbidden" }));
      // Authorized full caller can abort cleanly
      assert.equal(
        (await h.call("POST", "/api/measurement/imports/imp-race/abort", h.tokenA, { tenantId: "tenant-alpha" })).status,
        200
      );

      // 10d. Oversized serialized chunk (> 1,500,000 UTF-8 bytes) MUST fail with actionable 400 (never D1 row-size 500)
      const pad = "x".repeat(2000);
      const oversizedObs = Array.from({ length: 800 }, (_, i) => ({
        metricId: "gsc.clicks", definitionVersion: "v1",
        windowStart: "2026-12-02", windowEnd: "2026-12-02", windowTz: "UTC", grain: "daily",
        dimensions: { page: `/big/${i}/${pad}` }, valueNum: i,
        interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-12-02T00:00:00Z",
        idempotencyKey: `obs-big-${i}`,
      }));
      const oversizedRes = await h.call("POST", "/api/measurement/imports/stage", h.tokenA, {
        tenantId: "tenant-alpha",
        importId: "imp-oversized",
        chunkIndex: 0,
        groups: [{
          resourceId: "site-alpha", source: "gsc_export",
          runId: "run-oversized", runIdempotencyKey: "idem-oversized",
          sourceResourceId: "sc-domain:alpha.test",
          windowStart: "2026-12-02", windowEnd: "2026-12-02",
          evidence: mkEv("ev-oversized", await sha256Hex("ev-oversized")),
          observations: oversizedObs,
        }],
      });
      assert.equal(oversizedRes.status, 400);
      assert.match(((await oversizedRes.json()) as any).error, /split into smaller chunks/);

      // 10e. Lifecycle fencing: commit suspended across abort MUST fail with ConflictError (409) and publish ZERO rows!
      const fenceGroup = [{
        resourceId: "site-alpha", source: "gsc_export",
        runId: "run-fence-abort", runIdempotencyKey: "idem-fence-abort",
        sourceResourceId: "sc-domain:alpha.test",
        windowStart: "2026-12-03", windowEnd: "2026-12-03",
        evidence: mkEv("ev-fence-abort", await sha256Hex("ev-fence-abort")),
        observations: [{
          metricId: "gsc.clicks", definitionVersion: "v1",
          windowStart: "2026-12-03", windowEnd: "2026-12-03", windowTz: "UTC", grain: "daily",
          dimensions: { page: "/fence-abort" }, valueNum: 11,
          interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-12-03T00:00:00Z",
          idempotencyKey: "obs-fence-abort",
        }],
      }];
      assert.equal(
        (await h.call("POST", "/api/measurement/imports/stage", h.tokenA, {
          tenantId: "tenant-alpha", importId: "imp-fence-abort", chunkIndex: 0, groups: fenceGroup,
        })).status,
        201
      );
      let abortBeforeCommitBatch = false;
      const makePausedBatchDb = (onBeforeWriteBatch: () => Promise<void>) => ({
        prepare(sql: string) {
          const stmt = origPrepare(sql);
          return {
            bind(...params: any[]) {
              const bound = stmt.bind(...params);
              return {
                first: (...a: any[]) => (bound.first as any)(...a),
                all: (...a: any[]) => (bound.all as any)(...a),
                run: (...a: any[]) => (bound.run as any)(...a),
                _raw: bound,
                _sql: sql,
              };
            },
            first: (...a: any[]) => (stmt.first as any)(...a),
            all: (...a: any[]) => (stmt.all as any)(...a),
            run: (...a: any[]) => (stmt.run as any)(...a),
          };
        },
        async batch(stmts: any[]) {
          if (stmts.some((s) => typeof s._sql === "string" && s._sql.includes("INSERT INTO ms_staged_import_receipts"))) {
            await onBeforeWriteBatch();
          }
          return origBatch(stmts.map((s) => s._raw ?? s));
        },
      });
      const abortRaceSvc = new MeasurementService(
        makePausedBatchDb(async () => {
          if (!abortBeforeCommitBatch) {
            abortBeforeCommitBatch = true;
            const ab = await new MeasurementService(h.db).abortStagedImport("tenant-alpha", "imp-fence-abort");
            assert.equal(ab.discardedChunks, 1);
          }
        }) as any
      );
      await assert.rejects(
        () => abortRaceSvc.commitStagedImport({ tenantId: "tenant-alpha", importId: "imp-fence-abort", expectedChunks: 1 }),
        (err: any) => err?.status === 409
      );
      assert.equal((await h.call("GET", "/api/measurement/runs/run-fence-abort?tenantId=tenant-alpha", h.tokenA)).status, 404);

      // 10f. ABA replacement race: abort and commit with stale generation_id MUST NOT delete or consume replacement chunk!
      const abaGroup = [{
        resourceId: "site-alpha", source: "gsc_export",
        runId: "run-aba", runIdempotencyKey: "idem-aba",
        sourceResourceId: "sc-domain:alpha.test",
        windowStart: "2026-12-04", windowEnd: "2026-12-04",
        evidence: mkEv("ev-aba", await sha256Hex("ev-aba")),
        observations: [{
          metricId: "gsc.clicks", definitionVersion: "v1",
          windowStart: "2026-12-04", windowEnd: "2026-12-04", windowTz: "UTC", grain: "daily",
          dimensions: { page: "/aba" }, valueNum: 22,
          interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-12-04T00:00:00Z",
          idempotencyKey: "obs-aba",
        }],
      }];
      const baseSvc = new MeasurementService(h.db);
      await baseSvc.stageImportChunk({ tenantId: "tenant-alpha", importId: "imp-aba", chunkIndex: 0, groups: abaGroup });
      let abaReplacedForAbort = false;
      const abaAbortDb = {
        prepare(sql: string) {
          const stmt = origPrepare(sql);
          return {
            bind(...params: any[]) {
              const bound = stmt.bind(...params);
              return {
                first: (...a: any[]) => (bound.first as any)(...a),
                all: async (...a: any[]) => {
                  const res = await (bound.all as any)(...a);
                  if (!abaReplacedForAbort && sql.includes("FROM ms_staged_imports WHERE tenant_id = ? AND import_id = ?")) {
                    abaReplacedForAbort = true;
                    // Delete original generation and re-stage identical groups_json with a brand-new generation_id!
                    await baseSvc.abortStagedImport("tenant-alpha", "imp-aba");
                    await baseSvc.stageImportChunk({ tenantId: "tenant-alpha", importId: "imp-aba", chunkIndex: 0, groups: abaGroup });
                  }
                  return res;
                },
                run: (...a: any[]) => (bound.run as any)(...a),
                _raw: bound,
                _sql: sql,
              };
            },
            first: (...a: any[]) => (stmt.first as any)(...a),
            all: (...a: any[]) => (stmt.all as any)(...a),
            run: (...a: any[]) => (stmt.run as any)(...a),
          };
        },
        batch(stmts: any[]) {
          return origBatch(stmts.map((s) => s._raw ?? s));
        },
      };
      const staleAbortRes = await new MeasurementService(abaAbortDb as any).abortStagedImport("tenant-alpha", "imp-aba");
      assert.equal(staleAbortRes.discardedChunks, 0);
      const abaRemaining = await h.db
        .prepare("SELECT generation_id FROM ms_staged_imports WHERE tenant_id = ? AND import_id = ?")
        .bind("tenant-alpha", "imp-aba")
        .all<any>();
      assert.equal((abaRemaining.results || []).length, 1);

      let abaReplacedForCommit = false;
      const abaCommitSvc = new MeasurementService(
        makePausedBatchDb(async () => {
          if (!abaReplacedForCommit) {
            abaReplacedForCommit = true;
            await baseSvc.abortStagedImport("tenant-alpha", "imp-aba");
            await baseSvc.stageImportChunk({ tenantId: "tenant-alpha", importId: "imp-aba", chunkIndex: 0, groups: abaGroup });
          }
        }) as any
      );
      await assert.rejects(
        () => abaCommitSvc.commitStagedImport({ tenantId: "tenant-alpha", importId: "imp-aba", expectedChunks: 1 }),
        (err: any) => err?.status === 409
      );
      assert.equal((await h.call("GET", "/api/measurement/runs/run-aba?tenantId=tenant-alpha", h.tokenA)).status, 404);
      // Fresh commit of replacement generation succeeds cleanly
      const abaFreshCommit = await baseSvc.commitStagedImport({ tenantId: "tenant-alpha", importId: "imp-aba", expectedChunks: 1 });
      assert.equal(abaFreshCommit.inserted, 1);

      // 10g. Concurrent identical commits both succeed (200 insert + 200 idempotent replay, NEVER 500 UNIQUE constraint failed!)
      const raceCommitGroup = [{
        resourceId: "site-alpha", source: "gsc_export",
        runId: "run-concurrent-commit", runIdempotencyKey: "idem-concurrent-commit",
        sourceResourceId: "sc-domain:alpha.test",
        windowStart: "2026-12-05", windowEnd: "2026-12-05",
        evidence: mkEv("ev-concurrent-commit", await sha256Hex("ev-concurrent-commit")),
        observations: [{
          metricId: "gsc.clicks", definitionVersion: "v1",
          windowStart: "2026-12-05", windowEnd: "2026-12-05", windowTz: "UTC", grain: "daily",
          dimensions: { page: "/concurrent-commit" }, valueNum: 33,
          interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-12-05T00:00:00Z",
          idempotencyKey: "obs-concurrent-commit",
        }],
      }];
      await baseSvc.stageImportChunk({ tenantId: "tenant-alpha", importId: "imp-conc", chunkIndex: 0, groups: raceCommitGroup });
      let releaseBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
      let arrived = 0;
      const barrierSvc = new MeasurementService(
        makePausedBatchDb(async () => {
          arrived += 1;
          if (arrived === 2) releaseBarrier();
          await barrier;
        }) as any
      );
      const [concA, concB] = await Promise.all([
        barrierSvc.commitStagedImport({ tenantId: "tenant-alpha", importId: "imp-conc", expectedChunks: 1 }),
        barrierSvc.commitStagedImport({ tenantId: "tenant-alpha", importId: "imp-conc", expectedChunks: 1 }),
      ]);
      assert.deepEqual([concA.inserted, concB.inserted].sort(), [0, 1]);
      assert.deepEqual([concA.replayedNoop, concB.replayedNoop].sort(), [0, 1]);
      // Unauthorized caller retrying committed receipt receives uniform 403 (zero disclosure)
      const unauthReceiptRetry = await h.call("POST", "/api/measurement/imports/imp-conc/commit", h.tokenB, {
        tenantId: "tenant-alpha", expectedChunks: 1,
      });
      assert.equal(unauthReceiptRetry.status, 403);
      assert.equal(await unauthReceiptRetry.text(), JSON.stringify({ error: "forbidden" }));

      // 10h. Durable monotonic recordSeq NEVER reuses deleted sequence numbers after cascading deletion!
      const beforeDelSeries = (await (await h.call(
        "GET",
        `/api/measurement/series?tenantId=tenant-alpha&resourceId=site-alpha&metricId=gsc.clicks&windowStart=2026-12-05&windowEnd=2026-12-05`,
        h.tokenA
      )).json()) as any;
      assert.equal(beforeDelSeries.points.length, 1);
      const maxSeqBeforeDelete = beforeDelSeries.points[0].recordSeq;
      assert.ok(maxSeqBeforeDelete > 0);
      await h.db.prepare("DELETE FROM ms_runs WHERE run_id = ?").bind("run-concurrent-commit").run();
      const postDelRes = await h.call("POST", "/api/measurement/ingest-atomic", h.tokenA, {
        tenantId: "tenant-alpha",
        groups: [{
          resourceId: "site-alpha", source: "gsc_export",
          runId: "run-after-cascade-del", runIdempotencyKey: "idem-after-cascade-del",
          sourceResourceId: "sc-domain:alpha.test",
          windowStart: "2026-12-06", windowEnd: "2026-12-06",
          evidence: mkEv("ev-after-cascade-del", await sha256Hex("ev-after-cascade-del")),
          observations: [{
            metricId: "gsc.clicks", definitionVersion: "v1",
            windowStart: "2026-12-06", windowEnd: "2026-12-06", windowTz: "UTC", grain: "daily",
            dimensions: { page: "/after-cascade-del" }, valueNum: 44,
            interpretationVersion: "v1", sourceRevision: 1, sourceAsOf: "2026-12-06T00:00:00Z",
            idempotencyKey: "obs-after-cascade-del",
          }],
        }],
      });
      assert.equal(postDelRes.status, 200);
      const afterDelSeries = (await (await h.call(
        "GET",
        `/api/measurement/series?tenantId=tenant-alpha&resourceId=site-alpha&metricId=gsc.clicks&windowStart=2026-12-06&windowEnd=2026-12-06`,
        h.tokenA
      )).json()) as any;
      assert.equal(afterDelSeries.points.length, 1);
      assert.ok(
        afterDelSeries.points[0].recordSeq > maxSeqBeforeDelete,
        `Expected strictly monotonic recordSeq > ${maxSeqBeforeDelete}, got ${afterDelSeries.points[0].recordSeq}`
      );
    } finally {
      h.cleanup();
    }
  });
});
