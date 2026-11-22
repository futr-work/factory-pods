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
});
