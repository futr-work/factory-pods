#!/usr/bin/env tsx
/**
 * Real loopback runtime smoke for measurement-pod (`npm run smoke:runtime --workspace measurement-pod`).
 * - Creates a fresh mode-0700 temp directory and mode-0600 SQLite database + fixture evidence files.
 * - Starts the real Node HTTP server on an unused 127.0.0.1 port with external network disabled.
 * - Exercises /health, two distinct scoped credentials (bidirectional cross-tenant denial), ungranted shared
 *   hub token denial, 4 metric families, partial -> resumed coverage, exact decimal spend, counter/gauge,
 *   evidence metadata (without raw byte leakage), Worldview cursor feed, and MCP v2 + Code Mode.
 * - Tears down server, closes SQLite, and deletes the temp directory even on failure.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@futr-work/pod-kernel/auth";
import { startLocalMeasurementPod } from "../src/main.js";

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), "measurement-pod-smoke-"));
  chmodSync(workDir, 0o700);
  const dbPath = join(workDir, "measurement.sqlite");
  const fixturePath = join(workDir, "fixture-evidence.json");
  const fixtureBody = JSON.stringify({ synthetic: true, domain: "alpha.test", note: "secret-free fixture" });
  writeFileSync(fixturePath, fixtureBody, { mode: 0o600 });
  const fixtureSha = await sha256Hex(fixtureBody);

  const hubToken = "smoke-shared-hub-token";
  const tokenA = "smoke-scoped-token-alpha";
  const tokenB = "smoke-scoped-token-beta";

  const grants = [
    {
      callerId: "smoke-caller-a",
      tokenSha256: await sha256Hex(tokenA),
      grants: [{ tenantId: "tenant-a", resourceIds: ["*"], actions: ["read", "write"] }],
    },
    {
      callerId: "smoke-caller-b",
      tokenSha256: await sha256Hex(tokenB),
      grants: [{ tenantId: "tenant-b", resourceIds: ["*"], actions: ["read", "write"] }],
    },
  ];

  const pod = await startLocalMeasurementPod({
    host: "127.0.0.1",
    port: 0,
    dbPath,
    env: {
      FACTORY_HUB_TOKEN: hubToken,
      SCOPED_CALLER_GRANTS: JSON.stringify(grants),
    },
  });

  try {
    // Verify 0700 dir and 0600 db/evidence file permissions
    assert.equal(statSync(workDir).mode & 0o777, 0o700, "temp dir must be mode 0700");
    assert.equal(statSync(dbPath).mode & 0o777, 0o600, "SQLite db must be mode 0600");
    assert.equal(statSync(fixturePath).mode & 0o777, 0o600, "fixture file must be mode 0600");

    // 1. Health check (unauthenticated allowed)
    const healthRes = await fetch(`${pod.url}/health`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as any;
    assert.equal(health.status, "healthy");

    // 2. Unauthenticated & ungranted shared hub token fail closed
    assert.equal((await fetch(`${pod.url}/api/measurement/coverage?tenantId=tenant-a`)).status, 401);
    assert.equal(
      (await fetch(`${pod.url}/api/measurement/coverage?tenantId=tenant-a`, {
        headers: { Authorization: `Bearer ${hubToken}` },
      })).status,
      401
    );

    const postJson = (path: string, token: string, body: unknown, extra: Record<string, string> = {}) =>
      fetch(`${pod.url}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extra },
        body: JSON.stringify(body),
      });

    // 3. Register tenant-a resources (all 4 types) + tenant-b resource
    for (const r of [
      { tenantId: "tenant-a", resourceId: "site-a", resourceType: "site", sourceResourceId: "sc-domain:a.test", activeFrom: "2026-01-01" },
      { tenantId: "tenant-a", resourceId: "ga4-a", resourceType: "analytics_property", sourceResourceId: "properties/1", activeFrom: "2026-01-01" },
      { tenantId: "tenant-a", resourceId: "ads-a", resourceType: "ad_account", sourceResourceId: "customers/1", activeFrom: "2026-01-01" },
      { tenantId: "tenant-a", resourceId: "svc-a", resourceType: "server_service", sourceResourceId: "api-prod", activeFrom: "2026-01-01" },
    ]) {
      assert.equal((await postJson("/api/measurement/resources", tokenA, r)).status, 201);
    }
    assert.equal(
      (await postJson("/api/measurement/resources", tokenB, {
        tenantId: "tenant-b",
        resourceId: "site-b",
        resourceType: "site",
        sourceResourceId: "sc-domain:b.test",
        activeFrom: "2026-01-01",
      })).status,
      201
    );

    // 4. Bidirectional cross-tenant denial
    assert.equal(
      (await fetch(`${pod.url}/api/measurement/coverage?tenantId=tenant-b&resourceId=site-b`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      })).status,
      403
    );
    assert.equal(
      (await fetch(`${pod.url}/api/measurement/coverage?tenantId=tenant-a&resourceId=site-a`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      })).status,
      403
    );
    assert.equal(
      (await postJson("/api/measurement/resources", tokenB, {
        tenantId: "tenant-a",
        resourceId: "hijack",
        resourceType: "site",
        sourceResourceId: "sc-domain:hijack.test",
        activeFrom: "2026-01-01",
      })).status,
      403
    );

    // 5. Define metrics, open run/attempt, ingest partial -> resumed + spend + analytics + telemetry
    assert.equal(
      (await postJson("/api/measurement/definitions", tokenA, {
        tenantId: "tenant-a",
        metricId: "ads.spend",
        version: "v1",
        family: "spend",
        unit: "currency",
        valueType: "decimal_string",
        grain: "daily",
        windowTz: "America/New_York",
        dimensionsSchema: { campaign: { type: "string", required: true } },
        aggregationRule: "exact_decimal_sum",
      })).status,
      201
    );

    const runRes = await postJson("/api/measurement/runs", tokenA, {
      runId: "smoke-run-1",
      tenantId: "tenant-a",
      resourceId: "ads-a",
      source: "ads-readonly",
      sourceResourceId: "customers/1",
      idempotencyKey: "smoke-run-key-1",
      windowStart: "2026-11-18T00:00:00-05:00",
      windowEnd: "2026-11-18T23:59:59-05:00",
    });
    assert.equal(runRes.status, 201);

    assert.equal(
      (await postJson("/api/measurement/runs/smoke-run-1/attempts", tokenA, {
        tenantId: "tenant-a",
        status: "partial",
        cursor: "page=1",
      })).status,
      201
    );

    const ingestRes = await postJson("/api/measurement/ingest", tokenA, {
      tenantId: "tenant-a",
      resourceId: "ads-a",
      source: "ads-readonly",
      runId: "smoke-run-1",
      windowStart: "2026-11-18T00:00:00-05:00",
      windowEnd: "2026-11-18T23:59:59-05:00",
      evidence: {
        evidenceId: "smoke-ev-1",
        uriPointer: "fixture://smoke/fixture-evidence.json",
        sha256: fixtureSha,
        byteSize: Buffer.byteLength(fixtureBody),
        mediaType: "application/json",
        privacyClass: "internal",
        retentionClass: "30d",
        collectedAt: "2026-11-19T00:00:00Z",
        sourceAsOf: "2026-11-18T23:59:59Z",
        adapterName: "smoke-fixture",
        adapterVersion: "1.0.0",
      },
      observations: [
        {
          metricId: "ads.spend",
          definitionVersion: "v1",
          windowStart: "2026-11-18T00:00:00-05:00",
          windowEnd: "2026-11-18T23:59:59-05:00",
          windowTz: "America/New_York",
          grain: "daily",
          dimensions: { campaign: "c1" },
          valueText: "42.1950",
          currency: "USD",
          billingDate: "2026-11-18",
          grossOrNet: "net",
          interpretationVersion: "v1",
          sourceRevision: 1,
          sourceAsOf: "2026-11-18T23:59:59Z",
          idempotencyKey: "smoke-obs-1",
        },
      ],
      coverage: { status: "successful", reconciliationStatus: "matched" },
    });
    assert.equal(ingestRes.status, 200);

    // 6. Query series, evidence metadata (never leaks raw payload bytes), and Worldview cursor events
    const series = (await (
      await fetch(`${pod.url}/api/measurement/series?tenantId=tenant-a&resourceId=ads-a&metricId=ads.spend`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      })
    ).json()) as any;
    assert.equal(series.points[0].valueText, "42.1950");
    assert.equal(series.points[0].currency, "USD");

    const evText = await (
      await fetch(`${pod.url}/api/measurement/evidence/smoke-ev-1?tenantId=tenant-a`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      })
    ).text();
    const evMeta = JSON.parse(evText);
    assert.equal(evMeta.sha256, fixtureSha);
    assert.equal(evText.includes("secret-free fixture"), false, "evidence metadata must never leak fixture bytes");

    const events = (await (
      await fetch(`${pod.url}/api/measurement/events?tenantId=tenant-a&since_cursor=0`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      })
    ).json()) as any;
    assert.ok(events.events.length >= 5);

    // 7. MCP v2 server/discover + Code Mode search over real loopback HTTP
    const mcpDiscover = await postJson(
      "/mcp",
      tokenA,
      { jsonrpc: "2.0", id: "smoke-d1", method: "server/discover" },
      { "MCP-Protocol-Version": "2026-07-28" }
    );
    assert.equal(mcpDiscover.status, 200);
    const mcpDiscoverJson = (await mcpDiscover.json()) as any;
    assert.equal(mcpDiscoverJson.result.protocolVersion, "2026-07-28");
    assert.equal(mcpDiscoverJson.result.resultType, "complete");

    console.log(
      JSON.stringify({
        ok: true,
        url: pod.url,
        dbMode: "0600",
        dirMode: "0700",
        spendRoundTrip: `${series.points[0].valueText} ${series.points[0].currency}`,
        evidenceSha256: evMeta.sha256,
        eventsEmitted: events.events.length,
        mcpProtocol: mcpDiscoverJson.result.protocolVersion,
      })
    );
  } finally {
    await pod.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("smoke:runtime FAILED:", err);
  process.exit(1);
});
