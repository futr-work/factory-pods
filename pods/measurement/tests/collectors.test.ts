import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@futr-work/pod-kernel/auth";
import { SqliteFileStorage } from "@futr-work/pod-kernel/storage/sqlite";
import worker, { type Env } from "../src/worker.js";
import { MeasurementService } from "../src/service.js";
import { MeasurementCollectorScheduler } from "../src/collectors/scheduler.js";
import { parseBingDateToUtc, BING_SOURCE } from "../src/collectors/bing.js";
import {
  fetchBoundedProviderText,
  GSC_SOURCE,
  ProviderResponseLimitError,
  type FetchLike,
} from "../src/collectors/gsc.js";
import { parseCollectorCredentials, redactCollectorSecrets } from "../src/collectors/credentials.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

function syntheticToken(label: string): string {
  return `stub-token-${label}`;
}

async function generateTestRsaPkcs8Pem(): Promise<string> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)) as ArrayBuffer);
  let bin = "";
  for (let i = 0; i < pkcs8.length; i++) bin += String.fromCharCode(pkcs8[i]);
  const b64 = btoa(bin).match(/.{1,64}/g)?.join("\n") || "";
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
}

async function createHarness(opts: {
  collectorCredentials?: Record<string, any>;
  fetchImpl?: FetchLike;
} = {}) {
  const db = new SqliteFileStorage(":memory:");
  db.exec(schemaSql);
  const service = new MeasurementService(db);

  const adminToken = "test-admin-collector-token";
  const alphaToken = "test-alpha-only-token";
  const grants = [
    {
      callerId: "tenant-admin",
      tokenSha256: await sha256Hex(adminToken),
      grants: [{ tenantId: "tenant-a", resourceIds: ["*"], actions: ["read", "write", "evidence:read"] }],
    },
    {
      callerId: "alpha-scoped",
      tokenSha256: await sha256Hex(alphaToken),
      grants: [{ tenantId: "tenant-a", resourceIds: ["site:alpha.example"], actions: ["read", "write"] }],
    },
  ];

  await service.registerResource({
    tenantId: "tenant-a",
    resourceId: "site:alpha.example",
    resourceType: "site",
    sourceResourceId: "sc-domain:alpha.example",
    displayName: "Alpha Example",
    activeFrom: "2025-01-01T00:00:00Z",
  });
  await service.registerResource({
    tenantId: "tenant-a",
    resourceId: "site:beta.example",
    resourceType: "site",
    sourceResourceId: "sc-domain:beta.example",
    displayName: "Beta Example",
    activeFrom: "2025-01-01T00:00:00Z",
  });

  const env: Env = {
    DB: db,
    POD_ID: "measurement-pod",
    POD_NAME: "Measurement Pod",
    POD_ROLE: "measurement",
    POD_LOB: "measurement-evidence",
    FACTORY_HUB_TOKEN: "test-hub-token",
    SCOPED_CALLER_GRANTS: JSON.stringify(grants),
    COLLECTOR_CREDENTIALS: JSON.stringify(opts.collectorCredentials || {}),
    COLLECTOR_FETCH: opts.fetchImpl,
  };

  const apiReq = async (path: string, init: { method?: string; token?: string; body?: any } = {}) => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await worker.fetch(
      new Request(`https://measurement-pod.example${path}`, {
        method: init.method || "GET",
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      }),
      env
    );
    const json = (await res.json()) as any;
    return { status: res.status, json };
  };

  return { db, service, env, adminToken, alphaToken, apiReq };
}

test("GSC service-account collector collects two comparable periods, detects truncation, handles 0/0 rates, and replays idempotently", async () => {
  const pem = await generateTestRsaPkcs8Pem();
  const providerCalls: Array<{ url: string; body?: any }> = [];
  let tokenMints = 0;

  const fakeFetch: FetchLike = async (input, init) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      tokenMints += 1;
      const bodyText = String(init?.body || "");
      assert.match(bodyText, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
      assert.match(bodyText, /assertion=/);
      return new Response(JSON.stringify({ access_token: syntheticToken("readonly"), expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const reqBody = JSON.parse(String(init?.body || "{}"));
    providerCalls.push({ url, body: reqBody });
    assert.equal((init?.headers as Record<string, string>)?.Authorization, `Bearer ${syntheticToken("readonly")}`);

    const day = reqBody.startDate;
    const isBreakdown = Array.isArray(reqBody.dimensions) && reqBody.dimensions.length > 1;
    if (day === "2026-11-10") {
      if (!isBreakdown) {
        return new Response(
          JSON.stringify({ rows: [{ keys: ["2026-11-10"], clicks: 15, impressions: 300, ctr: 0.05, position: 4.5 }] }),
          { status: 200 }
        );
      }
      // Return maxRowsPerWindow=2 rows to prove truncation detection
      return new Response(
        JSON.stringify({
          rows: [
            { keys: ["2026-11-10", "https://alpha.example/", "alpha query", "usa", "desktop"], clicks: 10, impressions: 200, ctr: 0.05, position: 4.0 },
            { keys: ["2026-11-10", "https://alpha.example/zero", "zero query", "usa", "mobile"], clicks: 0, impressions: 0, ctr: 0, position: 0 },
          ],
        }),
        { status: 200 }
      );
    }
    // 2026-11-11: clean non-truncated day
    if (!isBreakdown) {
      return new Response(
        JSON.stringify({ rows: [{ keys: ["2026-11-11"], clicks: 20, impressions: 400, ctr: 0.05, position: 3.5 }] }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({
        rows: [
          { keys: ["2026-11-11", "https://alpha.example/", "alpha query", "usa", "desktop"], clicks: 20, impressions: 400, ctr: 0.05, position: 3.5 },
        ],
      }),
      { status: 200 }
    );
  };

  const h = await createHarness({
    collectorCredentials: {
      "gsc:alpha": {
        kind: "gsc_service_account",
        tenantId: "tenant-a",
        allowedProperties: { "site:alpha.example": ["sc-domain:alpha.example"] },
        clientEmail: "collector@alpha-test.iam.gserviceaccount.com",
        privateKeyPem: pem,
      },
    },
    fetchImpl: fakeFetch,
  });

  const schedRes = await h.apiReq("/api/measurement/collectors/schedules", {
    method: "POST",
    token: h.alphaToken,
    body: {
      tenantId: "tenant-a",
      resourceId: "site:alpha.example",
      connector: "gsc",
      sourceResourceId: "sc-domain:alpha.example",
      credentialRef: "gsc:alpha",
      maxRowsPerWindow: 2,
      dailyRequestBudget: 20,
      zeroSpendConfirmed: true,
    },
  });
  assert.equal(schedRes.status, 201);
  const scheduleId = schedRes.json.scheduleId;

  // Backfill two comparable daily periods
  const run1 = await h.apiReq("/api/measurement/collectors/run", {
    method: "POST",
    token: h.alphaToken,
    body: {
      tenantId: "tenant-a",
      scheduleId,
      windowStart: "2026-11-10",
      windowEnd: "2026-11-11",
    },
  });
  assert.equal(run1.status, 200);
  const outcome1 = run1.json.outcomes[0];
  // Day 1 was truncated -> overall status MUST be "partial", NOT "succeeded"!
  assert.equal(outcome1.status, "partial");
  assert.equal(outcome1.windowsProcessed, 2);
  assert.equal(outcome1.cursorDate, "2026-11-11");
  assert.equal(outcome1.requestsUsed, 4);
  assert.equal(tokenMints, 2);
  assert.equal(outcome1.windows[0].status, "partial");
  assert.equal(outcome1.windows[0].truncated, true);
  assert.equal(outcome1.windows[0].coverageStatus, "partial");
  assert.equal(outcome1.windows[0].reconciliationStatus, "partial");
  assert.equal(outcome1.windows[1].status, "succeeded");
  assert.equal(outcome1.windows[1].truncated, false);
  assert.equal(outcome1.windows[1].coverageStatus, "successful");
  assert.equal(outcome1.windows[1].reconciliationStatus, "matched");

  // Verify zero-impression row preserved denominator=0 + value_status="unknown"
  const ctrSeries = await h.service.querySeries({
    tenantId: "tenant-a",
    resourceId: "site:alpha.example",
    metricId: "gsc_ctr",
    limit: 50,
  });
  assert.equal(ctrSeries.comparable, true);
  const zeroRow = ctrSeries.points.find((p: any) => p.dimensions?.query === "zero query");
  assert.ok(zeroRow, "Expected zero-impression dimensional row");
  assert.equal(zeroRow.denominator, 0);
  assert.equal(zeroRow.dimensions.value_status, "unknown");

  // Replay exact same two-day backfill -> 100% idempotent no-op!
  const run2 = await h.apiReq("/api/measurement/collectors/run", {
    method: "POST",
    token: h.alphaToken,
    body: {
      tenantId: "tenant-a",
      scheduleId,
      windowStart: "2026-11-10",
      windowEnd: "2026-11-11",
    },
  });
  assert.equal(run2.status, 200);
  assert.equal(run2.json.outcomes[0].inserted, 0);
  assert.equal(run2.json.outcomes[0].replayedNoop, outcome1.inserted);
});

test("Bing Webmaster collector separates metrics/source from GSC, parses strict dates, redacts API key, and handles missing dimensions", async () => {
  assert.equal(parseBingDateToUtc("/Date(1794268800000+0000)/"), "2026-11-10");
  assert.equal(parseBingDateToUtc("2026-11-10"), "2026-11-10");
  // Timezone normalization to UTC & invalid calendar date rejection (Finding 11)
  assert.equal(parseBingDateToUtc("2026-11-10T23:30:00-08:00"), "2026-11-11");
  assert.equal(parseBingDateToUtc("2026-11-11T01:00:00+05:30"), "2026-11-10");
  assert.equal(parseBingDateToUtc("2026-02-31"), null);
  assert.equal(parseBingDateToUtc("2026-02-31garbage"), null);
  assert.equal(parseBingDateToUtc("2026-11-10trailing"), null);

  const secretKey = syntheticToken("bing-fixture");

  const fakeFetch: FetchLike = async (input) => {
    const url = String(input);
    assert.ok(url.includes(`apikey=${secretKey}`));
    if (url.includes("GetRankAndTrafficStats")) {
      return new Response(
        JSON.stringify({
          d: [
            { Date: "/Date(1794268800000+0000)/", Clicks: 8, Impressions: 120, AvgImpressionPosition: 6.2 },
            { Date: "/Date(1794355200000+0000)/", Clicks: 0, Impressions: 0, AvgImpressionPosition: 0 },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.includes("GetQueryStats")) {
      return new Response(
        JSON.stringify({
          d: [{ Date: "2026-11-10", Query: "alpha bing query", Clicks: 5, Impressions: 80, AvgImpressionPosition: null }],
        }),
        { status: 200 }
      );
    }
    if (url.includes("GetPageStats")) {
      return new Response(
        JSON.stringify({
          d: [{ Date: "2026-11-10", Query: "https://alpha.example/", Clicks: 8, Impressions: 120, AvgImpressionPosition: 6.2 }],
        }),
        { status: 200 }
      );
    }
    return new Response("not found", { status: 404 });
  };

  const h = await createHarness({
    collectorCredentials: {
      "bing:alpha": {
        kind: "bing_api_key",
        tenantId: "tenant-a",
        allowedProperties: { "site:alpha.example": ["https://alpha.example/"] },
        apiKey: secretKey,
      },
    },
    fetchImpl: fakeFetch,
  });

  const schedRes = await h.apiReq("/api/measurement/collectors/schedules", {
    method: "POST",
    token: h.alphaToken,
    body: {
      tenantId: "tenant-a",
      resourceId: "site:alpha.example",
      connector: "bing_webmaster",
      sourceResourceId: "https://alpha.example/",
      credentialRef: "bing:alpha",
      dailyRequestBudget: 20,
      zeroSpendConfirmed: true,
    },
  });
  assert.equal(schedRes.status, 201);

  const runRes = await h.apiReq("/api/measurement/collectors/run", {
    method: "POST",
    token: h.alphaToken,
    body: {
      tenantId: "tenant-a",
      scheduleId: schedRes.json.scheduleId,
      windowStart: "2026-11-10",
      windowEnd: "2026-11-11",
    },
  });
  assert.equal(runRes.status, 200);
  const outcome = runRes.json.outcomes[0];
  assert.equal(outcome.windowsProcessed, 2);
  assert.equal(outcome.requestsUsed, 6);
  assert.ok(!JSON.stringify(outcome).includes(secretKey), "Bing API key must never appear in run outcome");

  const bingClicks = await h.service.querySeries({
    tenantId: "tenant-a",
    resourceId: "site:alpha.example",
    metricId: "bing_clicks",
    limit: 50,
  });
  assert.ok(bingClicks.points.length >= 3);
  assert.ok(bingClicks.points.every((p: any) => p.source === BING_SOURCE));
  const gscClicks = await h.service.querySeries({
    tenantId: "tenant-a",
    resourceId: "site:alpha.example",
    metricId: "gsc_clicks",
    limit: 50,
  });
  assert.equal(gscClicks.points.length, 0);

  const bingPos = await h.service.querySeries({
    tenantId: "tenant-a",
    resourceId: "site:alpha.example",
    metricId: "bing_position",
    limit: 50,
  });
  const qPos = bingPos.points.find((p: any) => p.dimensions?.query === "alpha bing query");
  assert.ok(qPos);
  assert.equal(qPos.denominator, 0);
  assert.equal(qPos.dimensions.value_status, "unknown");

  const evRow = await h.db.prepare("SELECT uri_pointer FROM ms_evidence LIMIT 1").first<any>();
  assert.ok(evRow?.uri_pointer && !String(evRow.uri_pointer).includes(secretKey));
  const statusRes = await h.apiReq("/api/measurement/collectors/status?tenantId=tenant-a", { token: h.alphaToken });
  assert.equal(statusRes.status, 200);
  assert.ok(!JSON.stringify(statusRes.json).includes(secretKey));
});

test("Authoritative provider-property isolation, zero-spend fail-closed guard, quota/retry exhaustion, and pre-DB auth", async () => {
  // Wildcard allowedProperties must be rejected fail-closed
  assert.deepEqual(
    parseCollectorCredentials(
      JSON.stringify({
        bad1: { kind: "bing_api_key", tenantId: "t", allowedProperties: { "*": ["https://a.example/"] }, apiKey: "k" },
        bad2: { kind: "bing_api_key", tenantId: "t", allowedProperties: { "site:a": ["*"] }, apiKey: "k" },
      })
    ),
    {}
  );

  let providerAttempts = 0;
  let forceProviderStatus = 429;
  const secretToken = syntheticToken("oauth-fixture");

  const fakeFetch: FetchLike = async (input) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: syntheticToken("retry") }), { status: 200 });
    }
    providerAttempts += 1;
    if (forceProviderStatus === 429) {
      return new Response(JSON.stringify({ error: `rate limited for ${secretToken}` }), { status: 429 });
    }
    if (forceProviderStatus === 400) {
      return new Response(JSON.stringify({ error: "bad request" }), { status: 400 });
    }
    if (forceProviderStatus === 302) {
      return new Response(null, { status: 302, headers: { Location: "https://evil.example/steal" } });
    }
    return new Response(
      JSON.stringify({ rows: [{ keys: ["2026-11-10"], clicks: 4, impressions: 50, ctr: 0.08, position: 5.0 }] }),
      { status: 200 }
    );
  };

  const h = await createHarness({
    collectorCredentials: {
      "gsc:alpha-only": {
        kind: "gsc_oauth_refresh",
        tenantId: "tenant-a",
        allowedProperties: { "site:alpha.example": ["sc-domain:alpha.example"] },
        clientId: "cid",
        clientSecret: secretToken,
        refreshToken: syntheticToken("rt"),
      },
    },
    fetchImpl: fakeFetch,
  });

  // 1. Finding 1: Alpha caller CANNOT bind alpha credential to an unauthorized provider property (403)!
  const propHijack = await h.apiReq("/api/measurement/collectors/schedules", {
    method: "POST",
    token: h.alphaToken,
    body: {
      tenantId: "tenant-a",
      resourceId: "site:alpha.example",
      connector: "gsc",
      sourceResourceId: "sc-domain:private-other-tenant.example",
      credentialRef: "gsc:alpha-only",
      zeroSpendConfirmed: true,
    },
  });
  assert.equal(propHijack.status, 403);
  assert.equal(providerAttempts, 0);

  // Unconfigured credentialRef MUST be rejected at registration time (403)
  const unconfSched = await h.apiReq("/api/measurement/collectors/schedules", {
    method: "POST",
    token: h.adminToken,
    body: {
      tenantId: "tenant-a",
      resourceId: "site:beta.example",
      connector: "gsc",
      sourceResourceId: "sc-domain:beta.example",
      credentialRef: "gsc:not-configured-yet",
      zeroSpendConfirmed: true,
    },
  });
  assert.equal(unconfSched.status, 403);
  assert.equal(providerAttempts, 0);

  // Even if credentials rotate AFTER registration revoking beta.example, execution STILL fails closed with 0 network calls!
  const betaCredsEnv = JSON.stringify({
    ...JSON.parse(h.env.COLLECTOR_CREDENTIALS || "{}"),
    "gsc:beta-temp": {
      kind: "gsc_oauth_refresh",
      tenantId: "tenant-a",
      allowedProperties: { "site:beta.example": ["sc-domain:beta.example"] },
      clientId: "cid",
      clientSecret: "csec_beta",
      refreshToken: "rt_beta",
    },
  });
  const tempSched = await new MeasurementCollectorScheduler(h.db, h.service, {
    collectorCredentialsRaw: betaCredsEnv,
    fetchImpl: fakeFetch,
  }).upsertSchedule({
    tenantId: "tenant-a",
    resourceId: "site:beta.example",
    connector: "gsc",
    sourceResourceId: "sc-domain:beta.example",
    credentialRef: "gsc:beta-temp",
    zeroSpendConfirmed: true,
  });
  // Now run via h.apiReq whose COLLECTOR_CREDENTIALS no longer contains gsc:beta-temp
  const betaRun = await h.apiReq("/api/measurement/collectors/run", {
    method: "POST",
    token: h.adminToken,
    body: { tenantId: "tenant-a", scheduleId: tempSched.scheduleId, windowStart: "2026-11-10", windowEnd: "2026-11-10" },
  });
  assert.equal(betaRun.status, 200);
  assert.equal(betaRun.json.outcomes[0].status, "blocked");
  assert.equal(betaRun.json.outcomes[0].errorClass, "credential_unconfigured");
  assert.equal(providerAttempts, 0);

  // 2. Finding 6: Zero-spend guard FAILS CLOSED when omitted, rejects string "false", and preserves existing value on update!
  const stringZeroSpend = await h.apiReq("/api/measurement/collectors/schedules", {
    method: "POST",
    token: h.alphaToken,
    body: {
      tenantId: "tenant-a",
      resourceId: "site:alpha.example",
      connector: "gsc",
      sourceResourceId: "sc-domain:alpha.example",
      credentialRef: "gsc:alpha-only",
      zeroSpendConfirmed: "false",
    },
  });
  assert.equal(stringZeroSpend.status, 400);

  const omittedZeroSpend = await h.apiReq("/api/measurement/collectors/schedules", {
    method: "POST",
    token: h.alphaToken,
    body: {
      tenantId: "tenant-a",
      resourceId: "site:alpha.example",
      connector: "gsc",
      sourceResourceId: "sc-domain:alpha.example",
      credentialRef: "gsc:alpha-only",
      dimensions: ["date"],
      dailyRequestBudget: 5,
      maxRetries: 1,
    },
  });
  assert.equal(omittedZeroSpend.status, 201);
  assert.equal(omittedZeroSpend.json.zeroSpendConfirmed, false);

  const blockedZeroSpend = await h.apiReq("/api/measurement/collectors/run", {
    method: "POST",
    token: h.alphaToken,
    body: { tenantId: "tenant-a", scheduleId: omittedZeroSpend.json.scheduleId, windowStart: "2026-11-10", windowEnd: "2026-11-10" },
  });
  assert.equal(blockedZeroSpend.json.outcomes[0].status, "blocked");
  assert.equal(blockedZeroSpend.json.outcomes[0].errorClass, "zero_spend_unconfirmed");
  assert.equal(providerAttempts, 0);

  // Confirm zeroSpendConfirmed: true, then update cadenceSec WITHOUT passing zeroSpendConfirmed -> preserves true!
  const confirmed = await h.apiReq("/api/measurement/collectors/schedules", {
    method: "POST",
    token: h.alphaToken,
    body: {
      tenantId: "tenant-a",
      resourceId: "site:alpha.example",
      connector: "gsc",
      sourceResourceId: "sc-domain:alpha.example",
      credentialRef: "gsc:alpha-only",
      dimensions: ["date"],
      dailyRequestBudget: 5,
      maxRetries: 1,
      zeroSpendConfirmed: true,
    },
  });
  assert.equal(confirmed.json.zeroSpendConfirmed, true);

  const updatePreserving = await h.apiReq("/api/measurement/collectors/schedules", {
    method: "POST",
    token: h.alphaToken,
    body: {
      tenantId: "tenant-a",
      resourceId: "site:alpha.example",
      connector: "gsc",
      sourceResourceId: "sc-domain:alpha.example",
      credentialRef: "gsc:alpha-only",
      dimensions: ["date"],
      dailyRequestBudget: 5,
      maxRetries: 1,
      cadenceSec: 3600,
    },
  });
  assert.equal(updatePreserving.json.zeroSpendConfirmed, true);

  // 3. Finding 7: Non-retryable HTTP 400 immediately transitions to durable blocked (0 automatic retries);
  //    retryable HTTP 429 retries up to maxRetries=1 then transitions to durable blocked (retry_limit_exhausted)!
  const scheduler = new MeasurementCollectorScheduler(h.db, h.service, {
    collectorCredentialsRaw: h.env.COLLECTOR_CREDENTIALS,
    fetchImpl: fakeFetch,
  });
  const t0 = Date.UTC(2026, 10, 14, 12, 0, 0);

  forceProviderStatus = 400;
  let schedObj = (await scheduler.getScheduleById("tenant-a", confirmed.json.scheduleId))!;
  const badReqOut = await scheduler.executeSchedule(schedObj, { windowStart: "2026-11-10", windowEnd: "2026-11-10", now: t0 });
  assert.equal(badReqOut.status, "blocked");
  assert.equal(badReqOut.errorClass, "provider_bad_request");
  const attemptsAfter400 = providerAttempts;
  // Automatic due runs MUST NOT retry a durable blocked schedule even after cadenceSec elapses!
  const cronAfter400 = await scheduler.runDueSchedules({ now: t0 + 10_000_000 });
  assert.equal(cronAfter400.length, 0);
  assert.equal(providerAttempts, attemptsAfter400);

  // Explicit recovery via upsertSchedule clears blocked state; test retryable 429 with maxRetries=1
  await scheduler.upsertSchedule(
    {
      tenantId: "tenant-a",
      resourceId: "site:alpha.example",
      connector: "gsc",
      sourceResourceId: "sc-domain:alpha.example",
      credentialRef: "gsc:alpha-only",
      dimensions: ["date"],
      dailyRequestBudget: 10,
      maxRetries: 1,
      zeroSpendConfirmed: true,
    },
    t0 + 10_000
  );
  forceProviderStatus = 429;
  schedObj = (await scheduler.getScheduleById("tenant-a", confirmed.json.scheduleId))!;
  // Attempt 1 (consecutiveFailures = 1 <= maxRetries=1) -> failed + 300s cooldown
  const fail1 = await scheduler.executeSchedule(schedObj, { windowStart: "2026-11-10", windowEnd: "2026-11-10", now: t0 + 20_000 });
  assert.equal(fail1.status, "failed");
  assert.equal(fail1.errorClass, "provider_rate_limited");
  assert.equal(fail1.cooldownUntil, t0 + 320_000);
  // Attempt 2 after cooldown (consecutiveFailures = 2 > maxRetries=1) -> durable blocked (retry_limit_exhausted)
  schedObj = (await scheduler.getScheduleById("tenant-a", confirmed.json.scheduleId))!;
  const fail2 = await scheduler.executeSchedule(schedObj, { windowStart: "2026-11-10", windowEnd: "2026-11-10", now: t0 + 400_000 });
  assert.equal(fail2.status, "blocked");
  assert.equal(fail2.errorClass, "retry_limit_exhausted");
  const attemptsAfterExhausted = providerAttempts;
  const cronAfterExhausted = await scheduler.runDueSchedules({ now: t0 + 20_000_000 });
  assert.equal(cronAfterExhausted.length, 0);
  assert.equal(providerAttempts, attemptsAfterExhausted);

  // 4. Finding 10: Pre-DB auth check returns 403 BEFORE touching a throwing DB on BOTH collector POST routes!
  const throwingDb = {
    prepare() {
      throw new Error("DB must not be touched for unauthorized caller");
    },
    batch() {
      throw new Error("DB must not be touched for unauthorized caller");
    },
  };
  const envWithThrowingDb: Env = { ...h.env, DB: throwingDb };
  for (const [path, body] of [
    ["/api/measurement/collectors/schedules", { tenantId: "tenant-other", resourceId: "site:other", connector: "gsc" }],
    ["/api/measurement/collectors/run", { tenantId: "tenant-other", resourceId: "site:other" }],
  ] as const) {
    const res = await worker.fetch(
      new Request(`https://measurement-pod.example${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${h.alphaToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      envWithThrowingDb
    );
    assert.equal(res.status, 403, `Expected pre-DB 403 for ${path}`);
  }

  // Secret redaction check (raw + URL-encoded)
  const redacted = redactCollectorSecrets(
    `Bearer abc.def.ghi ?apikey=${encodeURIComponent(secretToken)}&x=1 -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----`,
    [secretToken]
  );
  assert.ok(!redacted.includes(secretToken));
  assert.ok(!redacted.includes("abc.def.ghi"));
  assert.ok(redacted.includes("[REDACTED_PEM]"));
});

test("Concurrent runs respect atomic quota & lease, and budget-limited partial windows resume & complete via sourceRevision", async () => {
  let providerQueryCount = 0;
  let releaseFirstQuery: (() => void) | null = null;
  let holdFirstQuery = true;

  const fakeFetch: FetchLike = async (input, init) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: syntheticToken("concurrent") }), { status: 200 });
    }
    providerQueryCount += 1;
    if (holdFirstQuery) {
      holdFirstQuery = false;
      await new Promise<void>((resolve) => {
        releaseFirstQuery = resolve;
      });
    }
    const reqBody = JSON.parse(String(init?.body || "{}"));
    const isBreakdown = Array.isArray(reqBody.dimensions) && reqBody.dimensions.length > 1;
    if (!isBreakdown) {
      return new Response(
        JSON.stringify({ rows: [{ keys: ["2026-11-10"], clicks: 15, impressions: 300, ctr: 0.05, position: 4.5 }] }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({
        rows: [
          { keys: ["2026-11-10", "https://alpha.example/", "alpha query"], clicks: 15, impressions: 300, ctr: 0.05, position: 4.5 },
        ],
      }),
      { status: 200 }
    );
  };

  const h = await createHarness({
    collectorCredentials: {
      "gsc:alpha": {
        kind: "gsc_oauth_refresh",
        tenantId: "tenant-a",
        allowedProperties: { "site:alpha.example": ["sc-domain:alpha.example"] },
        clientId: "cid",
        clientSecret: "csec",
        refreshToken: "rt",
      },
    },
    fetchImpl: fakeFetch,
  });

  const scheduler = new MeasurementCollectorScheduler(h.db, h.service, {
    collectorCredentialsRaw: h.env.COLLECTOR_CREDENTIALS,
    fetchImpl: fakeFetch,
  });

  const t0 = Date.UTC(2026, 10, 13, 12, 0, 0); // latestEligibleDate = 2026-11-10 (3d lag)
  const sched = await scheduler.upsertSchedule(
    {
      tenantId: "tenant-a",
      resourceId: "site:alpha.example",
      connector: "gsc",
      sourceResourceId: "sc-domain:alpha.example",
      credentialRef: "gsc:alpha",
      dimensions: ["date", "page", "query"],
      dailyRequestBudget: 1, // Only enough for totals; breakdown will be budget-limited!
      zeroSpendConfirmed: true,
    },
    t0
  );

  // Finding 2: Fire TWO concurrent executions against budget=1
  const p1 = scheduler.executeSchedule(sched, { now: t0 });
  // Wait a microtask tick so p1 acquires lease & starts HTTP call
  await new Promise((r) => setTimeout(r, 15));
  const p2 = scheduler.executeSchedule(sched, { now: t0 });
  const out2 = await p2;
  assert.equal(out2.errorClass, "schedule_locked");
  assert.equal(out2.requestsUsed, 0);

  releaseFirstQuery!();
  const out1 = await p1;
  assert.equal(providerQueryCount, 1, "Budget=1 MUST issue at most 1 provider query under concurrency");

  // Finding 5: Budget-limited partial window MUST report overall status='partial',
  // MUST retain pendingWindowDate='2026-11-10', and MUST NOT advance cursorDate or lastSuccessAt!
  assert.equal(out1.status, "partial");
  assert.equal(out1.windows[0].status, "partial");
  assert.equal(out1.cursorDate, null);

  const afterPartial = (await scheduler.getScheduleById("tenant-a", sched.scheduleId))!;
  assert.equal(afterPartial.requestsUsedToday, 1);
  assert.equal(afterPartial.pendingWindowDate, "2026-11-10");
  assert.equal(afterPartial.cursorDate, null);
  assert.equal(afterPartial.lastSuccessAt, null);
  assert.equal(afterPartial.lastStatus, "partial");

  // Finding 3 & 5: Increase budget to 5 -> automatic runDueSchedules resumes pendingWindowDate='2026-11-10',
  // completes totals (sourceRevision=2) + breakdown (sourceRevision=1) with ZERO conflict!
  await scheduler.upsertSchedule(
    {
      tenantId: "tenant-a",
      resourceId: "site:alpha.example",
      connector: "gsc",
      sourceResourceId: "sc-domain:alpha.example",
      credentialRef: "gsc:alpha",
      dimensions: ["date", "page", "query"],
      dailyRequestBudget: 5,
    },
    t0 + 60_000
  );
  const resumed = await scheduler.runDueSchedules({ now: t0 + 60_000 });
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].status, "succeeded");
  assert.equal(resumed[0].cursorDate, "2026-11-10");
  assert.equal(resumed[0].inserted, 8); // 4 updated totals (r2) + 4 new breakdown rows (r1)

  const afterComplete = (await scheduler.getScheduleById("tenant-a", sched.scheduleId))!;
  assert.equal(afterComplete.pendingWindowDate, null);
  assert.equal(afterComplete.cursorDate, "2026-11-10");
  assert.equal(afterComplete.lastStatus, "succeeded");
  assert.equal(afterComplete.lastSuccessAt, t0 + 60_000);
  assert.equal(afterComplete.requestsUsedToday, 3); // 1 from partial + 2 from completion

  // Verify revision=2 exists for property totals and replay is now 100% replayedNoop!
  const replay = await scheduler.executeSchedule(afterComplete, {
    windowStart: "2026-11-10",
    windowEnd: "2026-11-10",
    force: true,
    now: t0 + 120_000,
  });
  assert.equal(replay.inserted, 0);
  assert.equal(replay.replayedNoop, 8);
});

test("Error isolation in cron, malformed response rejection, and streaming response-size cap enforcement", async () => {
  let healthyCalls = 0;
  let malformedMode: "gsc_bad_rows" | "bing_error_obj" | "healthy" = "healthy";

  const fakeFetch: FetchLike = async (input) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: syntheticToken("iso") }), { status: 200 });
    }
    if (malformedMode === "gsc_bad_rows") {
      return new Response(JSON.stringify({ rows: "invalid" }), { status: 200 });
    }
    if (malformedMode === "bing_error_obj") {
      return new Response(JSON.stringify({ d: { ErrorCode: 1, Message: "Bad" } }), { status: 200 });
    }
    healthyCalls += 1;
    return new Response(JSON.stringify({ rows: [{ keys: ["2026-11-10"], clicks: 3, impressions: 30, ctr: 0.1, position: 2.0 }] }), {
      status: 200,
    });
  };

  const h = await createHarness({
    collectorCredentials: {
      "bing:bad-url": {
        kind: "bing_api_key",
        tenantId: "tenant-a",
        allowedProperties: { "site:alpha.example": ["https://alpha.example/"] },
        apiKey: "bing_key_bad_url",
        apiBaseUrl: "http://insecure.example/api", // Invalid non-HTTPS base URL!
      },
      "bing:good": {
        kind: "bing_api_key",
        tenantId: "tenant-a",
        allowedProperties: { "site:beta.example": ["https://beta.example/"] },
        apiKey: "bing_key_good",
      },
      "gsc:good": {
        kind: "gsc_oauth_refresh",
        tenantId: "tenant-a",
        allowedProperties: { "site:beta.example": ["sc-domain:beta.example"] },
        clientId: "cid",
        clientSecret: "csec",
        refreshToken: "rt",
      },
    },
    fetchImpl: fakeFetch,
  });

  const scheduler = new MeasurementCollectorScheduler(h.db, h.service, {
    collectorCredentialsRaw: h.env.COLLECTOR_CREDENTIALS,
    fetchImpl: fakeFetch,
  });
  const t0 = Date.UTC(2026, 10, 13, 12, 0, 0);

  // Schedule 1 (due earlier): invalid Bing http:// baseUrl -> MUST record blocked, NOT throw or starve Schedule 2!
  const badSched = await scheduler.upsertSchedule(
    {
      tenantId: "tenant-a",
      resourceId: "site:alpha.example",
      connector: "bing_webmaster",
      sourceResourceId: "https://alpha.example/",
      credentialRef: "bing:bad-url",
      zeroSpendConfirmed: true,
    },
    t0 - 2000
  );
  // Schedule 2 (due slightly later): healthy GSC schedule
  const goodGsc = await scheduler.upsertSchedule(
    {
      tenantId: "tenant-a",
      resourceId: "site:beta.example",
      connector: "gsc",
      sourceResourceId: "sc-domain:beta.example",
      credentialRef: "gsc:good",
      dimensions: ["date"],
      zeroSpendConfirmed: true,
    },
    t0 - 1000
  );

  // Finding 4: Both schedules processed on single cron run; bad schedule durably blocked, healthy schedule succeeds!
  const cronOutcomes = await scheduler.runDueSchedules({ maxSchedules: 5, now: t0 });
  assert.equal(cronOutcomes.length, 2);
  assert.equal(cronOutcomes[0].scheduleId, badSched.scheduleId);
  assert.equal(cronOutcomes[0].status, "blocked");
  assert.equal(cronOutcomes[0].errorClass, "provider_config_invalid");
  assert.equal(cronOutcomes[1].scheduleId, goodGsc.scheduleId);
  assert.equal(cronOutcomes[1].status, "succeeded");
  assert.equal(healthyCalls, 1);

  // Finding 8: Malformed provider envelopes MUST be rejected as provider_malformed_response (NOT zero/matched)!
  malformedMode = "gsc_bad_rows";
  const badGscOut = await scheduler.executeSchedule(goodGsc, {
    windowStart: "2026-11-11",
    windowEnd: "2026-11-11",
    force: true,
    now: t0 + 10_000,
  });
  assert.equal(badGscOut.status, "failed");
  assert.equal(badGscOut.errorClass, "provider_malformed_response");

  malformedMode = "bing_error_obj";
  const goodBing = await scheduler.upsertSchedule(
    {
      tenantId: "tenant-a",
      resourceId: "site:beta.example",
      connector: "bing_webmaster",
      sourceResourceId: "https://beta.example/",
      credentialRef: "bing:good",
      dimensions: ["date"],
      zeroSpendConfirmed: true,
    },
    t0 + 20_000
  );
  const badBingOut = await scheduler.executeSchedule(goodBing, {
    windowStart: "2026-11-11",
    windowEnd: "2026-11-11",
    force: true,
    now: t0 + 20_000,
  });
  assert.equal(badBingOut.status, "failed");
  assert.equal(badBingOut.errorClass, "provider_malformed_response");

  // Finding 9: Streaming byte-cap cancels oversized stream immediately after crossing limit without reading all 12 MiB!
  let chunksPulled = 0;
  let streamCanceled = false;
  const oneMb = new Uint8Array(1024 * 1024);
  const oversizedStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunksPulled += 1;
      if (chunksPulled <= 12) {
        controller.enqueue(oneMb);
      } else {
        controller.close();
      }
    },
    cancel() {
      streamCanceled = true;
    },
  });
  const oversizedFetch: FetchLike = async () => new Response(oversizedStream, { status: 200 });
  await assert.rejects(
    () => fetchBoundedProviderText(oversizedFetch, "https://example.test/huge", { method: "GET" }, { maxBytes: 4 * 1024 * 1024 }),
    (err: any) => err instanceof ProviderResponseLimitError
  );
  assert.equal(streamCanceled, true, "Oversized ReadableStream MUST be canceled immediately on overflow");
  assert.ok(chunksPulled <= 6, `Expected streaming abort near 4 MiB cap, pulled ${chunksPulled} MiB chunks`);
});

test("D1 2-row multi-value INSERT packing reduces batch statement count and preserves exact monotonic recordSeq order", async () => {
  const db = new SqliteFileStorage(":memory:");
  db.exec(schemaSql);
  const recordedBatchSql: string[] = [];
  const instrumentedDb: typeof db = Object.assign(Object.create(Object.getPrototypeOf(db)), db, {
    async batch(statements: any[]) {
      for (const s of statements) {
        if (typeof s?.sql === "string" && s.sql.startsWith("INSERT INTO ms_observations")) {
          recordedBatchSql.push(s.sql);
        }
      }
      return db.batch(statements);
    },
  });

  const service = new MeasurementService(instrumentedDb);
  await service.registerResource({
    tenantId: "tenant-pack",
    resourceId: "site:pack.example",
    resourceType: "site",
    sourceResourceId: "sc-domain:pack.example",
    activeFrom: "2025-01-01T00:00:00Z",
  });
  await service.defineMetric({
    tenantId: "tenant-pack",
    metricId: "gsc_clicks",
    version: "1.0.0",
    family: "seo",
    unit: "count",
    valueType: "integer",
    grain: "daily",
    windowTz: "UTC",
    dimensionsSchema: { seq_label: { type: "string", required: true } },
    aggregationRule: "sum",
  });

  // Ingest 7 observations -> should pack into ceil(7 / 2) = 4 INSERT statements (2, 2, 2, 1)
  const observations = Array.from({ length: 7 }, (_, i) => ({
    metricId: "gsc_clicks",
    definitionVersion: "1.0.0",
    windowStart: "2026-11-10",
    windowEnd: "2026-11-10",
    windowTz: "UTC",
    grain: "daily",
    dimensions: { seq_label: `row-${i}` },
    valueNum: i + 1,
    interpretationVersion: "1.0.0",
    sourceRevision: 1,
    sourceAsOf: "2026-11-10T00:00:00Z",
    idempotencyKey: `pack-obs-${i}`,
  }));

  const res = await service.ingestAtomicBatch({
    tenantId: "tenant-pack",
    groups: [
      {
        resourceId: "site:pack.example",
        source: GSC_SOURCE,
        runId: "run_pack_1",
        runIdempotencyKey: "run-pack-1",
        windowStart: "2026-11-10",
        windowEnd: "2026-11-10",
        evidence: {
          evidenceId: "ev_pack_1",
          uriPointer: "evidence://pack/1",
          sha256: "a".repeat(64),
          byteSize: 100,
          mediaType: "application/json",
          privacyClass: "internal",
          retentionClass: "30d",
          collectedAt: "2026-11-11T00:00:00Z",
          sourceAsOf: "2026-11-10T00:00:00Z",
          adapterName: "test",
          adapterVersion: "1.0.0",
        },
        observations,
      },
    ],
  });
  assert.equal(res.inserted, 7);
  const rows = await db
    .prepare("SELECT record_seq, value_num FROM ms_observations WHERE tenant_id = 'tenant-pack' ORDER BY record_seq ASC")
    .all<any>();
  assert.deepEqual(
    (rows.results || []).map((r: any) => Number(r.value_num)),
    [1, 2, 3, 4, 5, 6, 7]
  );
  if (recordedBatchSql.length > 0) {
    assert.equal(recordedBatchSql.length, 4);
  }
});

test("Zero-traffic day records honest coverageStatus='zero' and worker.scheduled() runs due collectors automatically", async () => {
  let scheduledCalls = 0;
  const fakeFetch: FetchLike = async (input) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: syntheticToken("cron") }), { status: 200 });
    }
    scheduledCalls += 1;
    // Documented empty GSC response (rows omitted) -> honest zero traffic day
    return new Response(JSON.stringify({ responseAggregationType: "byProperty" }), { status: 200 });
  };

  const h = await createHarness({
    collectorCredentials: {
      "gsc:cron": {
        kind: "gsc_oauth_refresh",
        tenantId: "tenant-a",
        allowedProperties: { "site:alpha.example": ["sc-domain:alpha.example"] },
        clientId: "cid",
        clientSecret: "csec_cron_123",
        refreshToken: "rt_cron_123",
      },
    },
    fetchImpl: fakeFetch,
  });

  const schedRes = await h.apiReq("/api/measurement/collectors/schedules", {
    method: "POST",
    token: h.alphaToken,
    body: {
      tenantId: "tenant-a",
      resourceId: "site:alpha.example",
      connector: "gsc",
      sourceResourceId: "sc-domain:alpha.example",
      credentialRef: "gsc:cron",
      dimensions: ["date"],
      zeroSpendConfirmed: true,
    },
  });
  assert.equal(schedRes.status, 201);

  await worker.scheduled({}, h.env);
  assert.equal(scheduledCalls, 1);

  const cov = await h.service.queryCoverage({ tenantId: "tenant-a", resourceId: "site:alpha.example", source: GSC_SOURCE });
  assert.equal(cov.items.length, 1);
  assert.equal(cov.items[0].status, "zero");
  assert.equal(cov.items[0].reconciliationStatus, "matched");

  const statusRes = await h.apiReq("/api/measurement/collectors/status?tenantId=tenant-a", { token: h.alphaToken });
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.json.items[0].freshnessState, "fresh");
  assert.equal(statusRes.json.items[0].lastStatus, "succeeded");
});

test("Round-2 regressions: lease expiry fencing, midnight UTC quota, later-window exceptions, Bing row-limit revision, strict metrics, retry reset, and runSchedules isolation", async () => {
  // 1. Lease expiry fencing: paused Worker 1 MUST abort with schedule_lease_lost once lease expires and Worker 2 takes over
  let clockMs = Date.UTC(2026, 10, 14, 12, 0, 0);
  let releaseW1: (() => void) | null = null;
  let callNum = 0;
  const leaseFetch: FetchLike = async (input) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: syntheticToken("lease") }), { status: 200 });
    }
    callNum += 1;
    if (callNum === 1) {
      await new Promise<void>((resolve) => {
        releaseW1 = resolve;
      });
    }
    return new Response(
      JSON.stringify({ rows: [{ keys: ["2026-11-10"], clicks: callNum * 10, impressions: 100, ctr: 0.1, position: 3.0 }] }),
      { status: 200 }
    );
  };
  const h1 = await createHarness({
    collectorCredentials: {
      "gsc:alpha": {
        kind: "gsc_oauth_refresh",
        tenantId: "tenant-a",
        allowedProperties: { "site:alpha.example": ["sc-domain:alpha.example"] },
        clientId: "cid",
        clientSecret: "csec",
        refreshToken: "rt",
      },
      "bing:alpha": {
        kind: "bing_api_key",
        tenantId: "tenant-a",
        allowedProperties: { "site:alpha.example": ["https://alpha.example/"] },
        apiKey: syntheticToken("bing-r2"),
      },
      "gsc:beta": {
        kind: "gsc_oauth_refresh",
        tenantId: "tenant-a",
        allowedProperties: { "site:beta.example": ["sc-domain:beta.example"] },
        clientId: "cid",
        clientSecret: "csec",
        refreshToken: "rt",
      },
    },
    fetchImpl: leaseFetch,
  });
  const leaseSched = new MeasurementCollectorScheduler(h1.db, h1.service, {
    collectorCredentialsRaw: h1.env.COLLECTOR_CREDENTIALS,
    fetchImpl: leaseFetch,
    leaseMs: 1000,
  });
  const sAlpha = await leaseSched.upsertSchedule(
    {
      tenantId: "tenant-a",
      resourceId: "site:alpha.example",
      connector: "gsc",
      sourceResourceId: "sc-domain:alpha.example",
      credentialRef: "gsc:alpha",
      dimensions: ["date"],
      dailyRequestBudget: 10,
      maxRetries: 1,
      zeroSpendConfirmed: true,
    },
    clockMs
  );

  const w1Promise = leaseSched.executeSchedule(sAlpha, {
    windowStart: "2026-11-10",
    windowEnd: "2026-11-10",
    nowFn: () => clockMs,
  });
  await new Promise((r) => setTimeout(r, 15));
  // Advance clock past Worker 1's 1000ms lease -> Worker 2 takes over and succeeds!
  clockMs += 2000;
  const w2Out = await leaseSched.executeSchedule(sAlpha, {
    windowStart: "2026-11-10",
    windowEnd: "2026-11-10",
    nowFn: () => clockMs,
  });
  assert.equal(w2Out.status, "succeeded");
  assert.equal(w2Out.inserted, 4);
  // Release Worker 1 -> MUST detect lost lease BEFORE persisting!
  releaseW1!();
  const w1Out = await w1Promise;
  assert.equal(w1Out.errorClass, "schedule_lease_lost");
  assert.equal(w1Out.inserted, 0);

  // 2. Midnight UTC crossing quota: budget=2 crossing 23:59:59Z -> 00:00:01Z issues at most 2 requests on new UTC day!
  let midClock = Date.UTC(2026, 10, 14, 23, 59, 59);
  let midQueries = 0;
  const midFetch: FetchLike = async (input, init) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: syntheticToken("mid") }), { status: 200 });
    }
    midQueries += 1;
    const reqBody = JSON.parse(String(init?.body || "{}"));
    // Cross UTC midnight immediately after first request!
    if (midQueries === 1) midClock = Date.UTC(2026, 10, 15, 0, 0, 1);
    return new Response(
      JSON.stringify({ rows: [{ keys: [reqBody.startDate], clicks: 5, impressions: 50, ctr: 0.1, position: 4.0 }] }),
      { status: 200 }
    );
  };
  const midSchedObj = new MeasurementCollectorScheduler(h1.db, h1.service, {
    collectorCredentialsRaw: h1.env.COLLECTOR_CREDENTIALS,
    fetchImpl: midFetch,
  });
  const sBeta = await midSchedObj.upsertSchedule(
    {
      tenantId: "tenant-a",
      resourceId: "site:beta.example",
      connector: "gsc",
      sourceResourceId: "sc-domain:beta.example",
      credentialRef: "gsc:beta",
      dimensions: ["date"],
      dailyRequestBudget: 2,
      maxRetries: 1,
      zeroSpendConfirmed: true,
    },
    midClock
  );
  // 4 days requested: Day 1 on Nov 14 (1 req), Days 2 & 3 on Nov 15 (2 reqs -> budget=2 reached!), Day 4 MUST block!
  const midOut = await midSchedObj.executeSchedule(sBeta, {
    windowStart: "2026-11-08",
    windowEnd: "2026-11-11",
    nowFn: () => midClock,
  });
  assert.equal(midQueries, 3); // 1 on Nov 14 + 2 on Nov 15 (never 3 on Nov 15!)
  assert.equal(midOut.status, "partial");
  assert.equal(midOut.windows[3].status, "blocked");
  assert.equal(midOut.windows[3].errorClass, "quota_exceeded");
  const sBetaAfterMid = (await midSchedObj.getScheduleById("tenant-a", sBeta.scheduleId))!;
  assert.equal(sBetaAfterMid.requestsUsedDate, "2026-11-15");
  assert.equal(sBetaAfterMid.requestsUsedToday, 2);

  // 3. Later-window exception preserves day 1 committed results and marks day 2 failed (NOT day 1!)
  let ingestCalls = 0;
  const origIngest = h1.service.ingestAtomicBatch.bind(h1.service);
  const flakyService = Object.assign(Object.create(Object.getPrototypeOf(h1.service)), h1.service, {
    async ingestAtomicBatch(input: any, now?: number) {
      ingestCalls += 1;
      if (ingestCalls === 2) {
        throw new Error("Simulated day-2 persistence failure");
      }
      return origIngest(input, now);
    },
  });
  const flakySched = new MeasurementCollectorScheduler(h1.db, flakyService, {
    collectorCredentialsRaw: h1.env.COLLECTOR_CREDENTIALS,
    fetchImpl: midFetch,
  });
  await flakySched.upsertSchedule(
    {
      tenantId: "tenant-a",
      resourceId: "site:beta.example",
      connector: "gsc",
      sourceResourceId: "sc-domain:beta.example",
      credentialRef: "gsc:beta",
      dimensions: ["date"],
      dailyRequestBudget: 20,
      maxRetries: 1,
      zeroSpendConfirmed: true,
    },
    Date.UTC(2026, 10, 16, 12, 0, 0)
  );
  const sBeta2 = (await flakySched.getScheduleById("tenant-a", sBeta.scheduleId))!;
  const flakyOut = await flakySched.executeSchedule(sBeta2, {
    windowStart: "2026-11-01",
    windowEnd: "2026-11-02",
    now: Date.UTC(2026, 10, 16, 12, 0, 0),
  });
  assert.equal(flakyOut.status, "partial");
  assert.equal(flakyOut.inserted, 4);
  assert.equal(flakyOut.windowsProcessed, 2);
  assert.equal(flakyOut.windows[0].windowStart, "2026-11-01");
  assert.equal(flakyOut.windows[0].status, "succeeded");
  assert.equal(flakyOut.windows[1].windowStart, "2026-11-02");
  assert.equal(flakyOut.windows[1].status, "failed");
  const covAll = await h1.service.queryCoverage({ tenantId: "tenant-a", resourceId: "site:beta.example", source: GSC_SOURCE });
  const covDay1 = covAll.items.find((c: any) => c.windowStart === "2026-11-01");
  const covDay2 = covAll.items.find((c: any) => c.windowStart === "2026-11-02");
  assert.equal(covDay1?.status, "successful", "Day 1 coverage must NOT be overwritten to failed");
  assert.equal(covDay2?.status, "failed", "Day 2 coverage must be recorded as failed");

  // 4. Retry exhaustion in-memory reset: with maxRetries=1, failure -> success -> failure stays 'failed' (count=1), NOT retry_limit_exhausted!
  await h1.db
    .prepare("UPDATE ms_collector_schedules SET consecutive_failures = 0, last_status = 'planned', cooldown_until = NULL WHERE schedule_id = ?")
    .bind(sBeta.scheduleId)
    .run();
  let seqStep = 0;
  const seqFetch: FetchLike = async (input, init) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: syntheticToken("seq") }), { status: 200 });
    }
    seqStep += 1;
    const reqBody = JSON.parse(String(init?.body || "{}"));
    if (seqStep === 1 || seqStep === 3) {
      return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
    }
    return new Response(
      JSON.stringify({ rows: [{ keys: [reqBody.startDate], clicks: 2, impressions: 20, ctr: 0.1, position: 5.0 }] }),
      { status: 200 }
    );
  };
  const seqSched = new MeasurementCollectorScheduler(h1.db, h1.service, {
    collectorCredentialsRaw: h1.env.COLLECTOR_CREDENTIALS,
    fetchImpl: seqFetch,
  });
  const tSeq = Date.UTC(2026, 10, 17, 12, 0, 0);
  await seqSched.upsertSchedule(
    {
      tenantId: "tenant-a",
      resourceId: "site:beta.example",
      connector: "gsc",
      sourceResourceId: "sc-domain:beta.example",
      credentialRef: "gsc:beta",
      dimensions: ["date"],
      dailyRequestBudget: 20,
      maxRetries: 1,
      zeroSpendConfirmed: true,
    },
    tSeq
  );
  const sbSeq1 = (await seqSched.getScheduleById("tenant-a", sBeta.scheduleId))!;
  // Step 1: fail once (consecutiveFailures -> 1)
  const r1 = await seqSched.executeSchedule(sbSeq1, { windowStart: "2026-11-03", windowEnd: "2026-11-03", now: tSeq });
  assert.equal(r1.status, "failed");
  // Step 2+3 in one call: day 1 succeeds (resets consecutiveFailures -> 0!), day 2 fails (consecutiveFailures -> 1 <= maxRetries=1!)
  const sbSeq2 = (await seqSched.getScheduleById("tenant-a", sBeta.scheduleId))!;
  const r2 = await seqSched.executeSchedule(sbSeq2, {
    windowStart: "2026-11-03",
    windowEnd: "2026-11-04",
    force: true,
    now: tSeq + 400_000,
  });
  assert.equal(r2.status, "partial");
  assert.equal(r2.windows[0].status, "succeeded");
  assert.equal(r2.windows[1].status, "failed");
  assert.equal(r2.windows[1].errorClass, "provider_rate_limited", "Must NOT falsely exhaust retries after a success reset");
  const sbSeqAfter = (await seqSched.getScheduleById("tenant-a", sBeta.scheduleId))!;
  assert.equal(sbSeqAfter.consecutiveFailures, 1);

  // 5. Malformed envelopes & missing mandatory metrics rejected (never recorded as zero traffic!)
  for (const [label, body] of [
    ["gsc error-like envelope", { message: "upstream failed", status: 500 }],
    ["gsc missing clicks/impressions", { rows: [{ keys: ["2026-11-05"] }] }],
  ] as const) {
    await h1.db
      .prepare("UPDATE ms_collector_schedules SET consecutive_failures = 0, last_status = 'planned', cooldown_until = NULL WHERE schedule_id = ?")
      .bind(sBeta.scheduleId)
      .run();
    const badFetch: FetchLike = async (input) => {
      if (String(input) === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: syntheticToken("bad") }), { status: 200 });
      }
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const badSched = new MeasurementCollectorScheduler(h1.db, h1.service, {
      collectorCredentialsRaw: h1.env.COLLECTOR_CREDENTIALS,
      fetchImpl: badFetch,
    });
    const out = await badSched.executeSchedule(sbSeqAfter, {
      windowStart: "2026-11-05",
      windowEnd: "2026-11-05",
      force: true,
      now: tSeq + 800_000,
    });
    assert.equal(out.errorClass, "provider_malformed_response", `Failed rejecting ${label}`);
  }

  // 6. Bing row-limit partial-to-complete: raising maxRowsPerWindow 1 -> 10 with identical responses creates revision 2 cleanly!
  const bingPayloadFetch: FetchLike = async (input) => {
    const url = String(input);
    if (url.includes("GetRankAndTrafficStats")) {
      return new Response(JSON.stringify({ d: [{ Date: "2026-11-10", Clicks: 12, Impressions: 200, AvgImpressionPosition: 4.0 }] }), {
        status: 200,
      });
    }
    if (url.includes("GetQueryStats")) {
      return new Response(
        JSON.stringify({
          d: [
            { Date: "2026-11-10", Query: "q1", Clicks: 7, Impressions: 100, AvgImpressionPosition: 3.0 },
            { Date: "2026-11-10", Query: "q2", Clicks: 5, Impressions: 100, AvgImpressionPosition: 5.0 },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ d: [] }), { status: 200 });
  };
  const bingSched = new MeasurementCollectorScheduler(h1.db, h1.service, {
    collectorCredentialsRaw: h1.env.COLLECTOR_CREDENTIALS,
    fetchImpl: bingPayloadFetch,
  });
  const b1 = await bingSched.upsertSchedule(
    {
      tenantId: "tenant-a",
      resourceId: "site:alpha.example",
      connector: "bing_webmaster",
      sourceResourceId: "https://alpha.example/",
      credentialRef: "bing:alpha",
      dimensions: ["date", "query"],
      maxRowsPerWindow: 1,
      zeroSpendConfirmed: true,
    },
    tSeq
  );
  const bOut1 = await bingSched.executeSchedule(b1, { windowStart: "2026-11-10", windowEnd: "2026-11-10", now: tSeq });
  assert.equal(bOut1.status, "partial");
  assert.equal(bOut1.windows[0].truncated, true);
  // Raise maxRowsPerWindow 1 -> 10 with identical provider payload -> succeeds cleanly with zero ConflictError!
  const b2 = await bingSched.upsertSchedule(
    {
      tenantId: "tenant-a",
      resourceId: "site:alpha.example",
      connector: "bing_webmaster",
      sourceResourceId: "https://alpha.example/",
      credentialRef: "bing:alpha",
      dimensions: ["date", "query"],
      maxRowsPerWindow: 10,
      zeroSpendConfirmed: true,
    },
    tSeq + 60_000
  );
  const bOut2 = await bingSched.executeSchedule(b2, { windowStart: "2026-11-10", windowEnd: "2026-11-10", force: true, now: tSeq + 60_000 });
  assert.equal(bOut2.status, "succeeded");
  assert.equal(bOut2.windows[0].truncated, false);
  assert.equal(bOut2.inserted, 12); // 4 totals (r2) + 4 q1 (r2) + 4 q2 (r1)

  // Bing missing required Clicks/Impressions rejected
  const badBingFetch: FetchLike = async () => new Response(JSON.stringify({ d: [{ Date: "2026-11-11" }] }), { status: 200 });
  const badBingSched = new MeasurementCollectorScheduler(h1.db, h1.service, {
    collectorCredentialsRaw: h1.env.COLLECTOR_CREDENTIALS,
    fetchImpl: badBingFetch,
  });
  const badBingRowOut = await badBingSched.executeSchedule(b2, {
    windowStart: "2026-11-11",
    windowEnd: "2026-11-11",
    force: true,
    now: tSeq + 120_000,
  });
  assert.equal(badBingRowOut.errorClass, "provider_malformed_response");

  // 7. runSchedules lease-acquisition DB error isolation: Schedule 1 throwing on lease MUST NOT starve Schedule 2!
  let leaseFaultInjected = false;
  const faultDb: typeof h1.db = Object.assign(Object.create(Object.getPrototypeOf(h1.db)), h1.db, {
    prepare(sql: string) {
      if (!leaseFaultInjected && sql.includes("SET lease_owner = ?")) {
        leaseFaultInjected = true;
        return {
          bind() {
            return {
              async run() {
                throw new Error("Simulated transient D1 lease write error");
              },
            };
          },
        };
      }
      return h1.db.prepare(sql);
    },
  });
  const isoRunSched = new MeasurementCollectorScheduler(faultDb, h1.service, {
    collectorCredentialsRaw: h1.env.COLLECTOR_CREDENTIALS,
    fetchImpl: bingPayloadFetch,
  });
  // Both sAlpha (gsc) and b2 (bing) are enabled for tenant-a; lease error on first must not prevent second from running!
  const isoOuts = await isoRunSched.runSchedules(
    { tenantId: "tenant-a", resourceId: "site:alpha.example", force: true, windowStart: "2026-11-10", windowEnd: "2026-11-10" },
    { now: tSeq + 180_000 }
  );
  assert.equal(isoOuts.length, 2);
  assert.equal(isoOuts[0].errorClass, "collector_lease_error");
  assert.notEqual(isoOuts[1].errorClass, "collector_lease_error");
});

test("Round-3 regressions: atomic db.batch lease fence prevents stale coverage overwrite and GSC OAuth midnight crossing honors daily quota", async () => {
  // 1. Exact Round-3 Finding #1 counterexample:
  //    Pause Worker 1 AFTER entering ingestAtomicBatch; expire lease; let Worker 2 commit 4 observations
  //    with coverage='successful' and sourceTotalText='10'; resume Worker 1 with empty ('zero') result.
  //    Worker 1's entire db.batch() MUST roll back atomically (coverage remains 'successful' total '10')!
  let clockMs = Date.UTC(2026, 10, 14, 12, 0, 0);
  let fetchStep = 0;
  const raceFetch: FetchLike = async (input) => {
    if (String(input) === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: syntheticToken("r3-race") }), { status: 200 });
    }
    fetchStep += 1;
    if (fetchStep === 1) {
      // Worker 1 gets empty/zero traffic response
      return new Response(JSON.stringify({ responseAggregationType: "byProperty" }), { status: 200 });
    }
    // Worker 2 gets real traffic (clicks=10)
    return new Response(
      JSON.stringify({ rows: [{ keys: ["2026-11-10"], clicks: 10, impressions: 100, ctr: 0.1, position: 3.0 }] }),
      { status: 200 }
    );
  };

  const h = await createHarness({
    collectorCredentials: {
      "gsc:alpha": {
        kind: "gsc_oauth_refresh",
        tenantId: "tenant-a",
        allowedProperties: { "site:alpha.example": ["sc-domain:alpha.example"] },
        clientId: "cid",
        clientSecret: "csec",
        refreshToken: "rt",
      },
    },
    fetchImpl: raceFetch,
  });

  let pauseW1Ingest = true;
  let releaseW1Ingest: (() => void) | null = null;
  let w1EnteredIngest: (() => void) | null = null;
  const w1EnteredPromise = new Promise<void>((r) => {
    w1EnteredIngest = r;
  });

  const origIngestAtomic = h.service.ingestAtomicBatch.bind(h.service);
  const raceService = Object.assign(Object.create(Object.getPrototypeOf(h.service)), h.service, {
    async ingestAtomicBatch(input: any, now?: number, txOpts?: any) {
      if (pauseW1Ingest) {
        pauseW1Ingest = false;
        w1EnteredIngest!();
        await new Promise<void>((resolve) => {
          releaseW1Ingest = resolve;
        });
      }
      return origIngestAtomic(input, now, txOpts);
    },
  });

  const raceSched = new MeasurementCollectorScheduler(h.db, raceService, {
    collectorCredentialsRaw: h.env.COLLECTOR_CREDENTIALS,
    fetchImpl: raceFetch,
    leaseMs: 1000,
  });
  const sRace = await raceSched.upsertSchedule(
    {
      tenantId: "tenant-a",
      resourceId: "site:alpha.example",
      connector: "gsc",
      sourceResourceId: "sc-domain:alpha.example",
      credentialRef: "gsc:alpha",
      dimensions: ["date"],
      dailyRequestBudget: 10,
      zeroSpendConfirmed: true,
    },
    clockMs
  );

  // Start Worker 1 and wait until it is paused RIGHT INSIDE ingestAtomicBatch!
  const w1Promise = raceSched.executeSchedule(sRace, {
    windowStart: "2026-11-10",
    windowEnd: "2026-11-10",
    nowFn: () => clockMs,
  });
  await w1EnteredPromise;

  // Expire Worker 1's lease and let Worker 2 run to completion (commits 4 obs, coverage='successful', sourceTotalText='10')
  clockMs += 2000;
  const w2Out = await raceSched.executeSchedule(sRace, {
    windowStart: "2026-11-10",
    windowEnd: "2026-11-10",
    nowFn: () => clockMs,
  });
  assert.equal(w2Out.status, "succeeded");
  assert.equal(w2Out.inserted, 4);

  // Resume Worker 1 inside ingestAtomicBatch -> MUST roll back via atomic lease fence!
  releaseW1Ingest!();
  const w1Out = await w1Promise;
  assert.equal(w1Out.errorClass, "schedule_lease_lost");
  assert.equal(w1Out.inserted, 0);

  // Verify coverage was NEVER overwritten to 'zero' / '0' by stale Worker 1!
  const covRes = await h.service.queryCoverage({ tenantId: "tenant-a", resourceId: "site:alpha.example", source: GSC_SOURCE });
  const dayCov = covRes.items.find((c: any) => c.windowStart === "2026-11-10");
  assert.equal(dayCov?.status, "successful", "Stale worker MUST NOT overwrite coverage to zero");
  assert.equal(dayCov?.sourceTotalText, "10", "Stale worker MUST NOT overwrite sourceTotalText to 0");

  // 2. Exact Round-3 Finding #2 counterexample:
  //    GSC with dailyRequestBudget=1 starts at 23:59:59Z; clock crosses UTC midnight DURING OAuth token minting!
  //    Query 1 must book against the NEW UTC day (2026-11-15), so a second execution on 2026-11-15 MUST block!
  let oauthClock = Date.UTC(2026, 10, 14, 23, 59, 59);
  let gscQueryDispatches = 0;
  let oauthCalls = 0;
  const oauthMidnightFetch: FetchLike = async (input, init) => {
    if (String(input) === "https://oauth2.googleapis.com/token") {
      oauthCalls += 1;
      // Advance clock past UTC midnight DURING the first OAuth token exchange!
      if (oauthCalls === 1) {
        oauthClock = Date.UTC(2026, 10, 15, 0, 0, 1);
      }
      return new Response(JSON.stringify({ access_token: syntheticToken("midnight-oauth") }), { status: 200 });
    }
    gscQueryDispatches += 1;
    const reqBody = JSON.parse(String(init?.body || "{}"));
    return new Response(
      JSON.stringify({ rows: [{ keys: [reqBody.startDate], clicks: 7, impressions: 70, ctr: 0.1, position: 2.5 }] }),
      { status: 200 }
    );
  };

  const hMid = await createHarness({
    collectorCredentials: {
      "gsc:alpha": {
        kind: "gsc_oauth_refresh",
        tenantId: "tenant-a",
        allowedProperties: { "site:alpha.example": ["sc-domain:alpha.example"] },
        clientId: "cid",
        clientSecret: "csec",
        refreshToken: "rt",
      },
    },
    fetchImpl: oauthMidnightFetch,
  });
  const midSched = new MeasurementCollectorScheduler(hMid.db, hMid.service, {
    collectorCredentialsRaw: hMid.env.COLLECTOR_CREDENTIALS,
    fetchImpl: oauthMidnightFetch,
  });
  const sMid = await midSched.upsertSchedule(
    {
      tenantId: "tenant-a",
      resourceId: "site:alpha.example",
      connector: "gsc",
      sourceResourceId: "sc-domain:alpha.example",
      credentialRef: "gsc:alpha",
      dimensions: ["date"],
      dailyRequestBudget: 1,
      zeroSpendConfirmed: true,
    },
    oauthClock
  );

  const firstRun = await midSched.executeSchedule(sMid, {
    windowStart: "2026-11-10",
    windowEnd: "2026-11-10",
    nowFn: () => oauthClock,
  });
  assert.equal(firstRun.status, "succeeded");
  assert.equal(gscQueryDispatches, 1);
  const afterFirst = (await midSched.getScheduleById("tenant-a", sMid.scheduleId))!;
  assert.equal(afterFirst.requestsUsedDate, "2026-11-15", "Quota MUST be booked on the post-OAuth UTC day");
  assert.equal(afterFirst.requestsUsedToday, 1);

  // Second run on 2026-11-15 MUST fail closed with quota_exceeded and ZERO extra OAuth or GSC query calls!
  const secondRun = await midSched.executeSchedule(afterFirst, {
    windowStart: "2026-11-11",
    windowEnd: "2026-11-11",
    force: true,
    nowFn: () => oauthClock,
  });
  assert.equal(secondRun.status, "blocked");
  assert.equal(secondRun.errorClass, "quota_exceeded");
  assert.equal(gscQueryDispatches, 1, "Budget=1 MUST NEVER dispatch 2 queries on the new UTC day");
  assert.equal(oauthCalls, 1, "Fail-closed pre-check MUST avoid unnecessary OAuth call when quota is already 0");
});

test("Round-4 regressions: SQLite transaction-time lease expiry without takeover (atomic, staged, failure) + retryCount & run.updated events", async () => {
  // 1. Real wall-clock expiry INSIDE db.batch() WITHOUT any second worker taking over!
  let delayNextFencedBatchMs = 0;
  let mode: "success_10" | "empty_zero" | "staged_1008" | "fail_429" = "success_10";

  const fakeFetch: FetchLike = async (input, init) => {
    if (String(input) === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: syntheticToken("r4") }), { status: 200 });
    }
    if (mode === "fail_429") {
      return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
    }
    const reqBody = JSON.parse(String(init?.body || "{}"));
    const isBreakdown = Array.isArray(reqBody.dimensions) && reqBody.dimensions.length > 1;
    if (mode === "empty_zero") {
      return new Response(JSON.stringify({ responseAggregationType: "byProperty" }), { status: 200 });
    }
    if (mode === "staged_1008") {
      if (!isBreakdown) {
        return new Response(
          JSON.stringify({ rows: [{ keys: ["2026-11-11"], clicks: 251, impressions: 2510, ctr: 0.1, position: 3.0 }] }),
          { status: 200 }
        );
      }
      // 251 breakdown rows * 4 metrics = 1,004 + 4 totals = 1,008 observations (> 1,000 atomic limit -> staged import!)
      const rows = Array.from({ length: 251 }, (_, i) => ({
        keys: ["2026-11-11", `https://alpha.example/p-${i}`],
        clicks: 1,
        impressions: 10,
        ctr: 0.1,
        position: 3.0,
      }));
      return new Response(JSON.stringify({ rows }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ rows: [{ keys: ["2026-11-10"], clicks: 10, impressions: 100, ctr: 0.1, position: 3.0 }] }),
      { status: 200 }
    );
  };

  const h = await createHarness({
    collectorCredentials: {
      "gsc:alpha": {
        kind: "gsc_oauth_refresh",
        tenantId: "tenant-a",
        allowedProperties: { "site:alpha.example": ["sc-domain:alpha.example"] },
        clientId: "cid",
        clientSecret: "csec",
        refreshToken: "rt",
      },
    },
    fetchImpl: fakeFetch,
  });

  // Wrap db.batch so we can inject a real wall-clock delay AFTER statements are bound, right before SQLite executes the tx!
  const delayedDb: typeof h.db = Object.assign(Object.create(Object.getPrototypeOf(h.db)), h.db, {
    async batch(statements: any[]) {
      const hasFence = statements.some((s) => typeof s?.sql === "string" && s.sql.includes("__collector_lease_fence__"));
      if (hasFence && delayNextFencedBatchMs > 0) {
        const ms = delayNextFencedBatchMs;
        delayNextFencedBatchMs = 0;
        await new Promise((r) => setTimeout(r, ms));
      }
      return h.db.batch(statements);
    },
  });
  const delayedService = new MeasurementService(delayedDb);
  const sched = new MeasurementCollectorScheduler(delayedDb, delayedService, {
    collectorCredentialsRaw: h.env.COLLECTOR_CREDENTIALS,
    fetchImpl: fakeFetch,
    leaseMs: 120,
  });

  const s = await sched.upsertSchedule({
    tenantId: "tenant-a",
    resourceId: "site:alpha.example",
    connector: "gsc",
    sourceResourceId: "sc-domain:alpha.example",
    credentialRef: "gsc:alpha",
    dimensions: ["date"],
    dailyRequestBudget: 50,
    maxRetries: 3,
    zeroSpendConfirmed: true,
  });

  // Baseline: commit day 2026-11-10 with clicks=10, coverage='successful'
  const baseOut = await sched.executeSchedule(s, { windowStart: "2026-11-10", windowEnd: "2026-11-10" });
  assert.equal(baseOut.status, "succeeded");
  assert.equal(baseOut.inserted, 4);

  // 1a. Delay ingestAtomicBatch db.batch() by 200ms > 120ms lease (NO second worker takeover!)
  mode = "empty_zero";
  delayNextFencedBatchMs = 200;
  const expiredAtomic = await sched.executeSchedule(s, { windowStart: "2026-11-10", windowEnd: "2026-11-10", force: true });
  assert.equal(expiredAtomic.errorClass, "schedule_lease_lost");
  const covAfterAtomic = (await h.service.queryCoverage({ tenantId: "tenant-a", resourceId: "site:alpha.example", source: GSC_SOURCE }))
    .items.find((c: any) => c.windowStart === "2026-11-10");
  assert.equal(covAfterAtomic?.status, "successful", "Expired ingestAtomicBatch MUST roll back via SQLite tx clock");
  assert.equal(covAfterAtomic?.sourceTotalText, "10");

  // 1b. Delay recordBlockedOrFailedCoverage db.batch() by 200ms > 120ms lease (NO second worker takeover!)
  mode = "fail_429";
  delayNextFencedBatchMs = 200;
  const expiredFail = await sched.executeSchedule(s, { windowStart: "2026-11-10", windowEnd: "2026-11-10", force: true });
  assert.equal(expiredFail.errorClass, "schedule_lease_lost");
  const covAfterFail = (await h.service.queryCoverage({ tenantId: "tenant-a", resourceId: "site:alpha.example", source: GSC_SOURCE }))
    .items.find((c: any) => c.windowStart === "2026-11-10");
  assert.equal(covAfterFail?.status, "successful", "Expired failure recording MUST NOT overwrite coverage to failed");

  // 1c. Delay commitStagedImport (1,008 observations) db.batch() by 200ms > 120ms lease (NO second worker takeover!)
  const sDim = await sched.upsertSchedule({
    tenantId: "tenant-a",
    resourceId: "site:alpha.example",
    connector: "gsc",
    sourceResourceId: "sc-domain:alpha.example",
    credentialRef: "gsc:alpha",
    dimensions: ["date", "page"],
    dailyRequestBudget: 50,
    maxRetries: 3,
    zeroSpendConfirmed: true,
  });
  mode = "staged_1008";
  delayNextFencedBatchMs = 200;
  const expiredStaged = await sched.executeSchedule(sDim, { windowStart: "2026-11-11", windowEnd: "2026-11-11", force: true });
  assert.equal(expiredStaged.errorClass, "schedule_lease_lost");
  const nov11Obs = await h.db
    .prepare("SELECT COUNT(*) AS cnt FROM ms_observations WHERE tenant_id = 'tenant-a' AND window_start = '2026-11-11'")
    .first<any>();
  const receiptCnt = await h.db.prepare("SELECT COUNT(*) AS cnt FROM ms_staged_import_receipts").first<any>();
  const stagedCnt = await h.db.prepare("SELECT COUNT(*) AS cnt FROM ms_staged_imports").first<any>();
  assert.equal(Number(nov11Obs?.cnt ?? 0), 0, "Expired commitStagedImport MUST commit 0 observations");
  assert.equal(Number(receiptCnt?.cnt ?? 0), 0, "Expired commitStagedImport MUST commit 0 receipts");
  assert.equal(Number(stagedCnt?.cnt ?? 0), 0, "Expired commitStagedImport MUST clean up staged chunks");

  // 2. Failed collector runs MUST increment retryCount AND emit run.updated events in ms_events!
  mode = "fail_429";
  delayNextFencedBatchMs = 0;
  const normalSched = new MeasurementCollectorScheduler(h.db, h.service, {
    collectorCredentialsRaw: h.env.COLLECTOR_CREDENTIALS,
    fetchImpl: fakeFetch,
  });
  const sNorm = (await normalSched.getScheduleById("tenant-a", s.scheduleId))!;
  const f1 = await normalSched.executeSchedule(sNorm, { windowStart: "2026-11-12", windowEnd: "2026-11-12", force: true });
  assert.equal(f1.status, "failed");
  const f2 = await normalSched.executeSchedule(sNorm, { windowStart: "2026-11-12", windowEnd: "2026-11-12", force: true });
  assert.equal(f2.status, "failed");

  const errRunRow = await h.db
    .prepare("SELECT run_id, retry_count FROM ms_runs WHERE tenant_id = 'tenant-a' AND window_start = '2026-11-12'")
    .first<any>();
  assert.ok(errRunRow?.run_id);
  const runDetail = await h.service.getRun("tenant-a", String(errRunRow.run_id));
  assert.equal(runDetail.retryCount, 2, "Two failed attempts MUST report retryCount === 2");
  assert.equal(runDetail.attempts.length, 2);

  const evFeed = await h.service.queryEvents({ tenantId: "tenant-a", limit: 100 });
  const failRunEvents = evFeed.events.filter(
    (e: any) => e.eventType === "run.updated" && e.payload?.runId === errRunRow.run_id && e.payload?.status === "failed"
  );
  assert.equal(failRunEvents.length, 2, "Two failed collector attempts MUST emit 2 run.updated events");
});

test("Round-5 regression: intra-transaction lease expiry between opening fence and final schedule update rolls back atomic, staged, failed, and blocked batches", async () => {
  let mode: "atomic_4" | "staged_1008" | "fail_429" | "block_400" = "atomic_4";
  const fakeFetch: FetchLike = async (input, init) => {
    if (String(input) === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: syntheticToken("r5") }), { status: 200 });
    }
    if (mode === "fail_429") {
      return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
    }
    if (mode === "block_400") {
      return new Response(JSON.stringify({ error: "bad request" }), { status: 400 });
    }
    const reqBody = JSON.parse(String(init?.body || "{}"));
    const isBreakdown = Array.isArray(reqBody.dimensions) && reqBody.dimensions.length > 1;
    if (mode === "staged_1008") {
      if (!isBreakdown) {
        return new Response(
          JSON.stringify({ rows: [{ keys: ["2026-11-21"], clicks: 251, impressions: 2510, ctr: 0.1, position: 3.0 }] }),
          { status: 200 }
        );
      }
      const rows = Array.from({ length: 251 }, (_, i) => ({
        keys: ["2026-11-21", `https://alpha.example/r5-${i}`],
        clicks: 1,
        impressions: 10,
        ctr: 0.1,
        position: 3.0,
      }));
      return new Response(JSON.stringify({ rows }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ rows: [{ keys: ["2026-11-20"], clicks: 10, impressions: 100, ctr: 0.1, position: 3.0 }] }),
      { status: 200 }
    );
  };

  const h = await createHarness({
    collectorCredentials: {
      "gsc:alpha": {
        kind: "gsc_oauth_refresh",
        tenantId: "tenant-a",
        allowedProperties: { "site:alpha.example": ["sc-domain:alpha.example"] },
        clientId: "cid",
        clientSecret: "csec",
        refreshToken: "rt",
      },
    },
    fetchImpl: fakeFetch,
  });

  // Install a TEMP SQLite trigger that fires AFTER INSERT ON ms_runs (i.e. strictly AFTER the opening lease fence
  // has passed and strictly BEFORE the final ms_collector_schedules UPDATE executes!), stalling inside SQLite
  // until real wall-clock time crosses lease_expires_at!
  h.db.exec(`
    CREATE TEMP TRIGGER r5_intratx_expire_delay
    AFTER INSERT ON ms_runs
    BEGIN
      SELECT COUNT(*) FROM (
        WITH RECURSIVE spin(x) AS (
          SELECT 1
          UNION ALL
          SELECT x + 1 FROM spin
          WHERE CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
                <= (SELECT COALESCE(MAX(lease_expires_at), 0) + 15 FROM ms_collector_schedules)
            AND x < 5000000
        )
        SELECT x FROM spin
      );
    END;
  `);

  const sched = new MeasurementCollectorScheduler(h.db, h.service, {
    collectorCredentialsRaw: h.env.COLLECTOR_CREDENTIALS,
    fetchImpl: fakeFetch,
    leaseMs: 80,
  });

  const s = await sched.upsertSchedule({
    tenantId: "tenant-a",
    resourceId: "site:alpha.example",
    connector: "gsc",
    sourceResourceId: "sc-domain:alpha.example",
    credentialRef: "gsc:alpha",
    dimensions: ["date"],
    dailyRequestBudget: 50,
    maxRetries: 1,
    zeroSpendConfirmed: true,
  });

  // 1. Atomic ingestion: opening fence passes, trigger expires lease mid-transaction -> FULL ROLLBACK!
  mode = "atomic_4";
  const outAtomic = await sched.executeSchedule(s, { windowStart: "2026-11-20", windowEnd: "2026-11-20", force: true });
  assert.equal(outAtomic.errorClass, "schedule_lease_lost");
  assert.equal(Number((await h.db.prepare("SELECT COUNT(*) AS cnt FROM ms_observations").first<any>())?.cnt ?? 0), 0);
  assert.equal(Number((await h.db.prepare("SELECT COUNT(*) AS cnt FROM ms_runs").first<any>())?.cnt ?? 0), 0);
  assert.equal(Number((await h.db.prepare("SELECT COUNT(*) AS cnt FROM ms_coverage").first<any>())?.cnt ?? 0), 0);
  assert.equal((await sched.getScheduleById("tenant-a", s.scheduleId))?.lastStatus, "planned");

  // 2. Staged ingestion (1,008 observations): opening fence passes, trigger expires lease mid-commit -> FULL ROLLBACK + cleanup!
  const sDim = await sched.upsertSchedule({
    tenantId: "tenant-a",
    resourceId: "site:alpha.example",
    connector: "gsc",
    sourceResourceId: "sc-domain:alpha.example",
    credentialRef: "gsc:alpha",
    dimensions: ["date", "page"],
    dailyRequestBudget: 50,
    maxRetries: 1,
    zeroSpendConfirmed: true,
  });
  mode = "staged_1008";
  const outStaged = await sched.executeSchedule(sDim, { windowStart: "2026-11-21", windowEnd: "2026-11-21", force: true });
  assert.equal(outStaged.errorClass, "schedule_lease_lost");
  assert.equal(Number((await h.db.prepare("SELECT COUNT(*) AS cnt FROM ms_observations").first<any>())?.cnt ?? 0), 0);
  assert.equal(Number((await h.db.prepare("SELECT COUNT(*) AS cnt FROM ms_staged_import_receipts").first<any>())?.cnt ?? 0), 0);
  assert.equal(Number((await h.db.prepare("SELECT COUNT(*) AS cnt FROM ms_staged_imports").first<any>())?.cnt ?? 0), 0);
  assert.equal((await sched.getScheduleById("tenant-a", s.scheduleId))?.lastStatus, "planned");

  // 3. Failed collection (HTTP 429): trigger expires lease mid-failure-batch -> FULL ROLLBACK!
  mode = "fail_429";
  const outFail = await sched.executeSchedule(sDim, { windowStart: "2026-11-22", windowEnd: "2026-11-22", force: true });
  assert.equal(outFail.errorClass, "schedule_lease_lost");
  assert.equal(Number((await h.db.prepare("SELECT COUNT(*) AS cnt FROM ms_runs").first<any>())?.cnt ?? 0), 0);
  assert.equal(Number((await h.db.prepare("SELECT COUNT(*) AS cnt FROM ms_attempts").first<any>())?.cnt ?? 0), 0);
  assert.equal(
    Number((await h.db.prepare("SELECT COUNT(*) AS cnt FROM ms_events WHERE event_type = 'run.updated'").first<any>())?.cnt ?? 0),
    0
  );
  assert.equal(Number((await h.db.prepare("SELECT COUNT(*) AS cnt FROM ms_coverage").first<any>())?.cnt ?? 0), 0);
  assert.equal((await sched.getScheduleById("tenant-a", s.scheduleId))?.consecutiveFailures, 0);

  // 4. Blocked collection (HTTP 400): trigger expires lease mid-blocked-batch -> FULL ROLLBACK!
  mode = "block_400";
  const outBlock = await sched.executeSchedule(sDim, { windowStart: "2026-11-23", windowEnd: "2026-11-23", force: true });
  assert.equal(outBlock.errorClass, "schedule_lease_lost");
  assert.equal(Number((await h.db.prepare("SELECT COUNT(*) AS cnt FROM ms_runs").first<any>())?.cnt ?? 0), 0);
  assert.equal(Number((await h.db.prepare("SELECT COUNT(*) AS cnt FROM ms_attempts").first<any>())?.cnt ?? 0), 0);
  assert.equal(
    Number((await h.db.prepare("SELECT COUNT(*) AS cnt FROM ms_events WHERE event_type = 'run.updated'").first<any>())?.cnt ?? 0),
    0
  );
  assert.equal(Number((await h.db.prepare("SELECT COUNT(*) AS cnt FROM ms_coverage").first<any>())?.cnt ?? 0), 0);
  assert.equal((await sched.getScheduleById("tenant-a", s.scheduleId))?.lastStatus, "planned");
});
