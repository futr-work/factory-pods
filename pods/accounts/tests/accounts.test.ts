import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@futr-work/pod-kernel/auth";
import { SqliteFileStorage } from "@futr-work/pod-kernel/storage/sqlite";
import worker, { type Env } from "../src/worker.js";
import { AccountsService, NotFoundError, ValidationError } from "../src/service.js";
import {
  assertNoEmbeddedSecretPayload,
  BitwardenVaultAdapter,
  buildOAuthAuthorizeUrl,
  CloudflareSecretVaultAdapter,
  createPkcePair,
  InfisicalVaultAdapter,
  LastPassVaultAdapter,
  OnePasswordConnectVaultAdapter,
  parseVaultUri,
  VaultAdapterRegistry,
} from "../src/vault/adapters.js";

const podDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaSql = readFileSync(join(podDir, "schema.sql"), "utf8");

function makeSynthetic(label: string): string {
  return `test-val-${label}-001`;
}

async function generateSyntheticPkcs8Pem(): Promise<string> {
  const kp = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer;
  const raw = new Uint8Array(exported);
  let bin = "";
  for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]);
  const body = btoa(bin).match(/.{1,64}/g)?.join("\n") || "";
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

function createTestDb(): { db: SqliteFileStorage; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "accounts-pod-test-"));
  const db = new SqliteFileStorage(join(dir, "accounts.sqlite"));
  db.exec(schemaSql);
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createTestEnv(db: SqliteFileStorage): Promise<{
  env: Env;
  hubToken: string;
  alphaAdminToken: string;
  alphaReadOnlyToken: string;
  alphaAssetScopedToken: string;
  betaAdminToken: string;
}> {
  const hubToken = makeSynthetic("hub-operator");
  const alphaAdminToken = makeSynthetic("alpha-admin");
  const alphaReadOnlyToken = makeSynthetic("alpha-readonly");
  const alphaAssetScopedToken = makeSynthetic("alpha-scoped-site");
  const betaAdminToken = makeSynthetic("beta-admin");

  const grants = [
    {
      callerId: "alpha-admin",
      tokenSha256: await sha256Hex(alphaAdminToken),
      grants: [{ tenantId: "tenant-alpha", resourceIds: ["*"], actions: ["read", "write"] }],
    },
    {
      callerId: "alpha-reader",
      tokenSha256: await sha256Hex(alphaReadOnlyToken),
      grants: [{ tenantId: "tenant-alpha", resourceIds: ["*"], actions: ["read"] }],
    },
    {
      callerId: "alpha-site-only",
      tokenSha256: await sha256Hex(alphaAssetScopedToken),
      grants: [{ tenantId: "tenant-alpha", resourceIds: ["site:example.com"], actions: ["read"] }],
    },
    {
      callerId: "beta-admin",
      tokenSha256: await sha256Hex(betaAdminToken),
      grants: [{ tenantId: "tenant-beta", resourceIds: ["*"], actions: ["read", "write"] }],
    },
  ];

  return {
    env: {
      DB: db,
      FACTORY_HUB_TOKEN: hubToken,
      SCOPED_CALLER_GRANTS: JSON.stringify(grants),
    },
    hubToken,
    alphaAdminToken,
    alphaReadOnlyToken,
    alphaAssetScopedToken,
    betaAdminToken,
  };
}

test("parseVaultUri and zero-secret guard reject wildcards, traversal, prototype keys, embedded secrets, and PKCS#8 PEMs", async () => {
  const valid = parseVaultUri("vault://infisical-dev/measurement-pod/BING_ENTRY#field1");
  assert.equal(valid.backendId, "infisical-dev");
  assert.deepEqual(valid.segments, ["measurement-pod", "BING_ENTRY"]);
  assert.equal(valid.fragment, "field1");

  for (const bad of [
    "",
    "http://infisical/foo",
    "vault://infisical-dev",
    "vault://infisical-dev/a/../b",
    "vault://infisical-dev/a/*",
    "vault://__proto__/secret",
    "vault://infisical-dev/a?q=1",
    "vault://infisical-dev/a#",
    " vault://infisical-dev/a ",
  ]) {
    assert.throws(() => parseVaultUri(bad), `Expected parseVaultUri to reject: ${bad}`);
  }

  const pem = await generateSyntheticPkcs8Pem();
  assert.throws(() => assertNoEmbeddedSecretPayload({ nested: { apiKey: makeSynthetic("x") } }), /Embedded secret field/);
  assert.throws(() => assertNoEmbeddedSecretPayload({ nested: { note: pem } }), /PEM private key/);
  assert.throws(() => assertNoEmbeddedSecretPayload(JSON.parse('{"__proto__": {"a": 1}}')), /Forbidden object key/);
});

test("VaultAdapterRegistry resolves across Infisical, 1Password, LastPass, Bitwarden, CF Secret, fallback, blocks redirects, and redacts tokens", async () => {
  const infToken = makeSynthetic("inf-bearer");
  const opToken = makeSynthetic("op-bearer");
  const lpToken = makeSynthetic("lp-bearer");
  const bwToken = makeSynthetic("bw-bearer");

  const infAdapter = new InfisicalVaultAdapter({
    backendId: "inf-main",
    projectId: "proj-1",
    environment: "dev",
    bearerToken: infToken,
    fetchImpl: async (url, init) => {
      assert.equal(init?.redirect, "manual");
      if (String(url).includes("MISSING")) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ secret: { secretValue: "val-from-infisical", version: 3 } }), { status: 200 });
    },
  });

  const opAdapter = new OnePasswordConnectVaultAdapter({
    backendId: "op-main",
    connectUrl: "https://connect.example.com",
    connectToken: opToken,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          version: 7,
          fields: [{ id: "f1", label: "api_token", value: "val-from-1password" }],
        }),
        { status: 200 }
      ),
  });

  const lpAdapter = new LastPassVaultAdapter({
    backendId: "lp-main",
    bridgeUrl: "https://lp-bridge.example.com",
    authToken: lpToken,
    fetchImpl: async () => new Response(JSON.stringify({ value: "val-from-lastpass" }), { status: 200 }),
  });

  const bwAdapter = new BitwardenVaultAdapter({
    backendId: "bw-main",
    accessToken: bwToken,
    fetchImpl: async () => new Response(JSON.stringify({ value: "val-from-bitwarden" }), { status: 200 }),
  });

  const cfAdapter = new CloudflareSecretVaultAdapter({
    backendId: "cf-env",
    rawJson: JSON.stringify({ "bing:acct1": { credential: "val-from-cf-secret" } }),
  });

  const registry = new VaultAdapterRegistry()
    .register(infAdapter)
    .register(opAdapter)
    .register(lpAdapter)
    .register(bwAdapter)
    .register(cfAdapter);

  assert.equal((await registry.resolve("vault://inf-main/app/KEY_1")).value, "val-from-infisical");
  assert.equal((await registry.resolve("vault://op-main/vault1/item1#api_token")).value, "val-from-1password");
  assert.equal((await registry.resolve("vault://lp-main/folder/item1#password")).value, "val-from-lastpass");
  assert.equal((await registry.resolve("vault://bw-main/uuid-123")).value, "val-from-bitwarden");
  assert.equal((await registry.resolve("vault://cf-env/bing:acct1#credential")).value, "val-from-cf-secret");

  // Fallback across heterogeneous vault backends (Infisical -> 1Password)
  const fb = await registry.resolve("vault://inf-main/app/MISSING", {
    fallbackVaultUri: "vault://op-main/vault1/item1#api_token",
  });
  assert.equal(fb.value, "val-from-1password");
  assert.equal(fb.driver, "onepassword_connect");

  // Redirect blocking & bearer redaction on transport errors
  const redirAdapter = new OnePasswordConnectVaultAdapter({
    backendId: "op-redir",
    connectUrl: "https://connect.example.com",
    connectToken: opToken,
    fetchImpl: async () => new Response("", { status: 302, headers: { Location: "https://evil.example" } }),
  });
  await assert.rejects(() => redirAdapter.resolveSecret("vault://op-redir/v/i"), /redirect blocked/i);

  const errAdapter = new LastPassVaultAdapter({
    backendId: "lp-err",
    bridgeUrl: "https://lp-bridge.example.com",
    authToken: lpToken,
    fetchImpl: async () => {
      throw new Error(`network failure carrying ${lpToken}`);
    },
  });
  await assert.rejects(
    () => errAdapter.resolveSecret("vault://lp-err/item"),
    (err: Error) => {
      assert.ok(!err.message.includes(lpToken), "Vault token must be redacted from error message");
      return true;
    }
  );

  // Non-HTTPS endpoint rejected
  assert.throws(
    () => new LastPassVaultAdapter({ backendId: "lp-http", bridgeUrl: "http://evil.example", authToken: lpToken }),
    /must use https/
  );

  // OAuth2 PKCE pair + authorize URL builder
  const pkce = await createPkcePair();
  assert.equal(pkce.method, "S256");
  assert.ok(pkce.codeVerifier.length >= 32);
  assert.ok(pkce.codeChallenge.length >= 32);
  const authUrl = buildOAuthAuthorizeUrl({
    authorizeEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    clientId: "cid-demo",
    redirectUri: "http://127.0.0.1:8792/callback",
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    state: "state-123",
    codeChallenge: pkce.codeChallenge,
  });
  assert.match(authUrl, /code_challenge_method=S256/);
});

test("AccountsService enforces zero-secret storage, tenant FK isolation, overlap preservation, canonical swap, and atomic vault switching", async () => {
  const { db, cleanup } = createTestDb();
  try {
    const svc = new AccountsService(db);

    // 1. Register Infisical, 1Password, and LastPass backends for tenant-alpha
    await svc.upsertVaultBackend({ tenantId: "tenant-alpha", backendId: "inf-dev", driver: "infisical", label: "Infisical Dev", config: { env: "dev" } }, "op");
    await svc.upsertVaultBackend({ tenantId: "tenant-alpha", backendId: "op-prod", driver: "onepassword_connect", label: "1Password Ops", config: { vault: "Ops" } }, "op");
    await svc.upsertVaultBackend({ tenantId: "tenant-alpha", backendId: "lp-prod", driver: "lastpass", label: "LastPass Shared" }, "op");

    // Embedded secret in backend config rejected
    await assert.rejects(
      () =>
        svc.upsertVaultBackend(
          { tenantId: "tenant-alpha", backendId: "bad", driver: "infisical", label: "Bad", config: { apiKey: makeSynthetic("leak") } },
          "op"
        ),
      ValidationError
    );

    // 2. Register principals & provider accounts
    await svc.upsertPrincipal({ tenantId: "tenant-alpha", principalId: "person:alice", kind: "human", displayName: "Alice", email: "alice@example.com" }, "op");
    await svc.upsertPrincipal({ tenantId: "tenant-alpha", principalId: "person:bob", kind: "human", displayName: "Bob", email: "bob@example.com" }, "op");
    await svc.upsertProviderAccount({ tenantId: "tenant-alpha", accountId: "acct:bing:alice", provider: "bing_webmaster", ownerPrincipalId: "person:alice", label: "Alice Bing" }, "op");
    await svc.upsertProviderAccount({ tenantId: "tenant-alpha", accountId: "acct:bing:bob", provider: "bing_webmaster", ownerPrincipalId: "person:bob", label: "Bob Bing" }, "op");
    await svc.upsertProviderAccount({ tenantId: "tenant-alpha", accountId: "acct:cf:alice", provider: "cloudflare", ownerPrincipalId: "person:alice", label: "Alice CF" }, "op");

    // Cross-tenant FK rejected
    await assert.rejects(
      () =>
        svc.upsertProviderAccount(
          { tenantId: "tenant-beta", accountId: "acct:beta", provider: "bing_webmaster", ownerPrincipalId: "person:alice", label: "Cross-tenant" },
          "op"
        ),
      NotFoundError
    );

    // 3. Register connection on Infisical, then switch to 1Password, then to LastPass
    const conn = await svc.upsertConnection(
      {
        tenantId: "tenant-alpha",
        connectionId: "conn:bing:alice",
        accountId: "acct:bing:alice",
        authType: "api_key",
        vaultBackendId: "inf-dev",
        vaultUri: "vault://inf-dev/measurement/BING_ALICE",
        status: "healthy",
        zeroSpendConfirmed: true,
      },
      "op"
    );
    assert.equal(conn.vaultBackendId, "inf-dev");

    const switched1p = await svc.switchConnectionVault(
      {
        tenantId: "tenant-alpha",
        connectionId: "conn:bing:alice",
        vaultBackendId: "op-prod",
        vaultUri: "vault://op-prod/ops-vault/bing-alice#credential",
      },
      "op"
    );
    assert.equal(switched1p.vaultBackendId, "op-prod");
    assert.equal(switched1p.vaultUri, "vault://op-prod/ops-vault/bing-alice#credential");

    const switchedLp = await svc.switchConnectionVault(
      {
        tenantId: "tenant-alpha",
        connectionId: "conn:bing:alice",
        vaultBackendId: "lp-prod",
        vaultUri: "vault://lp-prod/bing-alice#password",
      },
      "op"
    );
    assert.equal(switchedLp.vaultBackendId, "lp-prod");

    // 4. Discovery from Alice's Bing auto-creates site:example.com and sets canonical
    const disc1 = await svc.ingestDiscovery(
      {
        tenantId: "tenant-alpha",
        accountId: "acct:bing:alice",
        connectionId: "conn:bing:alice",
        items: [{ assetId: "site:example.com", canonicalName: "example.com", brandGroup: "brand-a", externalResourceId: "https://example.com/" }],
      },
      "op"
    );
    assert.equal(disc1.createdAssets, 1);
    assert.equal(disc1.canonicalAssigned, 1);
    assert.equal(disc1.overlapsFlagged, 0);

    // 5. Discovery from Bob's Bing sees the SAME site -> preserves Alice as canonical and flags overlap_conflict!
    const disc2 = await svc.ingestDiscovery(
      {
        tenantId: "tenant-alpha",
        accountId: "acct:bing:bob",
        items: [{ assetId: "site:example.com", canonicalName: "example.com", externalResourceId: "https://example.com/" }],
      },
      "op"
    );
    assert.equal(disc2.overlapsFlagged, 1);
    assert.equal(disc2.bindings[0].isCanonical, false);
    assert.equal(disc2.bindings[0].discoveryState, "overlap_conflict");

    // 6. whoOwns reports canonical owner (with switched LastPass vault pointer!), overlap, and missing providers
    const who = await svc.whoOwns("tenant-alpha", "site:example.com", ["bing_webmaster", "gsc", "cloudflare"]);
    assert.equal(who.providers.bing_webmaster.canonical?.accountId, "acct:bing:alice");
    assert.equal(who.providers.bing_webmaster.canonical?.vaultDriver, "lastpass");
    assert.equal(who.providers.bing_webmaster.canonical?.vaultUri, "vault://lp-prod/bing-alice#password");
    assert.equal(who.providers.bing_webmaster.hasOverlap, true);
    assert.deepEqual(who.missingProviders, ["gsc", "cloudflare"]);

    // 7. Atomic canonical swap to Bob succeeds and demotes Alice
    const swapped = await svc.setCanonicalBinding("tenant-alpha", disc2.bindings[0].bindingId, "op");
    assert.equal(swapped.isCanonical, true);
    const whoAfter = await svc.whoOwns("tenant-alpha", "site:example.com");
    assert.equal(whoAfter.providers.bing_webmaster.canonical?.accountId, "acct:bing:bob");

    // 8. Overlaps & gaps report
    const report = await svc.queryOverlapsAndGaps("tenant-alpha", ["bing_webmaster", "gsc"]);
    assert.equal(report.overlaps.length, 1);
    assert.equal(report.overlaps[0].canonicalAccountId, "acct:bing:bob");
    assert.deepEqual(report.gaps, [{ assetId: "site:example.com", missingProviders: ["gsc"] }]);

    // 9. Audit trail recorded switch_vault + set_canonical
    const audit = await svc.queryAuditEvents("tenant-alpha", 0, 50);
    assert.ok(audit.some((e) => e.action === "switch_vault"));
    assert.ok(audit.some((e) => e.action === "set_canonical"));
  } finally {
    cleanup();
  }
});

test("HTTP Worker, scoped caller authorization, MCP tools, Code Mode, and XSS-safe Cockpit UI", async () => {
  const { db, cleanup } = createTestDb();
  try {
    const { env, hubToken, alphaAdminToken, alphaReadOnlyToken, alphaAssetScopedToken, betaAdminToken } = await createTestEnv(db);

    const call = (path: string, opts: { method?: string; token?: string; body?: any } = {}) =>
      worker.fetch(
        new Request(`https://accounts-pod.example.test${path}`, {
          method: opts.method || "GET",
          headers: {
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        }),
        env
      );

    // 1. Open /health
    const health = await call("/health");
    assert.equal(health.status, 200);
    const healthJson: any = await health.json();
    assert.equal(healthJson.role, "accounts");
    assert.equal(healthJson.zeroSecretControlPlane, true);

    // 2. Unauthenticated & hub-token-only requests fail closed on tenant routes!
    assert.equal((await call("/api/accounts/matrix?tenantId=tenant-alpha")).status, 401);
    assert.equal((await call("/api/accounts/matrix?tenantId=tenant-alpha", { token: hubToken })).status, 401);

    // 3. Cross-tenant & read-only write attempts fail with 403
    assert.equal((await call("/api/accounts/matrix?tenantId=tenant-alpha", { token: betaAdminToken })).status, 403);
    assert.equal(
      (
        await call("/api/accounts/vault-backends", {
          method: "POST",
          token: alphaReadOnlyToken,
          body: { tenantId: "tenant-alpha", backendId: "inf-1", driver: "infisical", label: "Inf" },
        })
      ).status,
      403
    );

    // 4. Seed graph via HTTP API as tenant-alpha admin (including XSS payload in displayName to verify UI escaping)
    assert.equal(
      (
        await call("/api/accounts/vault-backends", {
          method: "POST",
          token: alphaAdminToken,
          body: { tenantId: "tenant-alpha", backendId: "inf-dev", driver: "infisical", label: "Infisical" },
        })
      ).status,
      201
    );
    assert.equal(
      (
        await call("/api/accounts/principals", {
          method: "POST",
          token: alphaAdminToken,
          body: { tenantId: "tenant-alpha", principalId: "person:ops", kind: "human", displayName: "<script>alert(1)</script>", email: "ops@example.com" },
        })
      ).status,
      201
    );
    assert.equal(
      (
        await call("/api/accounts/provider-accounts", {
          method: "POST",
          token: alphaAdminToken,
          body: { tenantId: "tenant-alpha", accountId: "acct:gsc:ops", provider: "gsc", ownerPrincipalId: "person:ops", label: "Ops GSC" },
        })
      ).status,
      201
    );
    assert.equal(
      (
        await call("/api/accounts/connections", {
          method: "POST",
          token: alphaAdminToken,
          body: {
            tenantId: "tenant-alpha",
            connectionId: "conn:gsc:ops",
            accountId: "acct:gsc:ops",
            authType: "gcp_service_account",
            vaultBackendId: "inf-dev",
            vaultUri: "vault://inf-dev/gcloud/SA_JSON",
            status: "healthy",
          },
        })
      ).status,
      201
    );
    assert.equal(
      (
        await call("/api/accounts/discover", {
          method: "POST",
          token: alphaAdminToken,
          body: {
            tenantId: "tenant-alpha",
            accountId: "acct:gsc:ops",
            connectionId: "conn:gsc:ops",
            items: [
              { assetId: "site:example.com", canonicalName: "example.com", externalResourceId: "sc-domain:example.com" },
              { assetId: "site:other.com", canonicalName: "other.com", externalResourceId: "sc-domain:other.com" },
            ],
          },
        })
      ).status,
      200
    );

    // 5. Resource-scoped caller can query who-owns for site:example.com, NOT site:other.com, NOT tenant-wide matrix!
    const okWho = await call("/api/accounts/who-owns?tenantId=tenant-alpha&assetId=site:example.com", { token: alphaAssetScopedToken });
    assert.equal(okWho.status, 200);
    const okWhoJson: any = await okWho.json();
    assert.equal(okWhoJson.providers.gsc.canonical.vaultUri, "vault://inf-dev/gcloud/SA_JSON");

    assert.equal(
      (await call("/api/accounts/who-owns?tenantId=tenant-alpha&assetId=site:other.com", { token: alphaAssetScopedToken })).status,
      403
    );
    assert.equal((await call("/api/accounts/matrix?tenantId=tenant-alpha", { token: alphaAssetScopedToken })).status, 403);

    // 6. MCP tools/list & acc_who_owns call via /mcp
    const mcpList = await call("/mcp", {
      method: "POST",
      token: alphaAdminToken,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    assert.equal(mcpList.status, 200);
    const mcpListJson: any = await mcpList.json();
    const toolNames = (mcpListJson.result?.tools || []).map((t: any) => t.name);
    assert.ok(toolNames.includes("acc_who_owns"));
    assert.ok(toolNames.includes("acc_switch_vault"));

    const mcpCall = await call("/mcp", {
      method: "POST",
      token: alphaAssetScopedToken,
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "acc_who_owns", arguments: { tenantId: "tenant-alpha", assetId: "site:example.com" } },
      },
    });
    assert.equal(mcpCall.status, 200);
    const mcpCallJson: any = await mcpCall.json();
    assert.ok(!mcpCallJson.error);
    assert.match(JSON.stringify(mcpCallJson.result), /vault:\/\/inf-dev\/gcloud\/SA_JSON/);

    // 7. Cockpit UI requires hubToken and escapes HTML
    assert.equal((await call("/")).status, 401);
    const uiRes = await call("/", { token: hubToken });
    assert.equal(uiRes.status, 200);
    const html = await uiRes.text();
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.match(html, /Accounts Pod/);
  } finally {
    cleanup();
  }
});
