import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@futr-work/pod-kernel/auth";
import { SqliteFileStorage } from "@futr-work/pod-kernel/storage/sqlite";
import worker, { type Env } from "../src/worker.js";
import { AccountsService, ConflictError, NotFoundError, ValidationError } from "../src/service.js";
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
  redactSecrets,
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

test("parseVaultUri, zero-secret guard, and redactSecrets reject wildcards, fragments with '=', connectToken, PEMs, and redact short secrets", async () => {
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
    "vault://infisical-dev/a#access_token=canary",
    " vault://infisical-dev/a ",
  ]) {
    assert.throws(() => parseVaultUri(bad), `Expected parseVaultUri to reject: ${bad}`);
  }

  const pem = await generateSyntheticPkcs8Pem();
  assert.throws(() => assertNoEmbeddedSecretPayload({ nested: { apiKey: makeSynthetic("x") } }), /Embedded secret field/);
  assert.throws(() => assertNoEmbeddedSecretPayload({ connectToken: makeSynthetic("op") }), /Embedded secret field/);
  assert.throws(() => assertNoEmbeddedSecretPayload({ nested: { note: pem } }), /PEM private key/);
  assert.throws(() => assertNoEmbeddedSecretPayload(pem), /PEM private key/);
  assert.throws(() => assertNoEmbeddedSecretPayload(JSON.parse('{"__proto__": {"a": 1}}')), /Forbidden object key/);

  // Short explicit known secrets (< 6 chars) are also redacted
  assert.equal(redactSecrets("failed carrying ab12 in header", ["ab12"]), "failed carrying [REDACTED] in header");
});

test("VaultAdapterRegistry resolves across Infisical, 1Password, LastPass, Bitwarden bridge, CF Secret, rejects Bitwarden ciphertext, and preserves OAuth PKCE invariants", async () => {
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
    bridgeUrl: "https://bw-bridge.example.com",
    accessToken: bwToken,
    fetchImpl: async (url) => {
      if (String(url).includes("CIPHER")) {
        return new Response(JSON.stringify({ decrypted: true, value: "2.aXZiYXNlNjQ=|Y3RiYXNlNjQ=|bWFjYmFzZTY0" }), { status: 200 });
      }
      if (String(url).includes("UNFLAGGED")) {
        return new Response(JSON.stringify({ value: "raw-without-decrypted-flag" }), { status: 200 });
      }
      return new Response(JSON.stringify({ decrypted: true, value: "val-from-bitwarden-bridge" }), { status: 200 });
    },
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
  assert.equal((await registry.resolve("vault://bw-main/uuid-123")).value, "val-from-bitwarden-bridge");
  assert.equal((await registry.resolve("vault://cf-env/bing:acct1#credential")).value, "val-from-cf-secret");

  // Bitwarden adapter MUST reject ciphertext envelopes and unflagged plaintext
  await assert.rejects(() => bwAdapter.resolveSecret("vault://bw-main/CIPHER"), /CipherString/);
  await assert.rejects(() => bwAdapter.resolveSecret("vault://bw-main/UNFLAGGED"), /decrypted plaintext/);

  // Fallback across heterogeneous vault backends (Infisical -> 1Password)
  const fb = await registry.resolve("vault://inf-main/app/MISSING", {
    fallbackVaultUri: "vault://op-main/vault1/item1#api_token",
  });
  assert.equal(fb.value, "val-from-1password");
  assert.equal(fb.driver, "onepassword_connect");

  // Redirect blocking & bearer redaction (including short tokens)
  const redirAdapter = new OnePasswordConnectVaultAdapter({
    backendId: "op-redir",
    connectUrl: "https://connect.example.com",
    connectToken: opToken,
    fetchImpl: async () => new Response("", { status: 302, headers: { Location: "https://evil.example" } }),
  });
  await assert.rejects(() => redirAdapter.resolveSecret("vault://op-redir/v/i"), /redirect blocked/i);

  const shortToken = "s9k2";
  const errAdapter = new LastPassVaultAdapter({
    backendId: "lp-err",
    bridgeUrl: "https://lp-bridge.example.com",
    authToken: shortToken,
    fetchImpl: async () => {
      throw new Error(`network failure carrying ${shortToken}`);
    },
  });
  await assert.rejects(
    () => errAdapter.resolveSecret("vault://lp-err/item"),
    (err: Error) => {
      assert.ok(!err.message.includes(shortToken), "Short vault token must be redacted");
      return true;
    }
  );

  // OAuth2 PKCE: preserves exact trailing slash on redirectUri and rejects reserved extraParams overrides
  const pkce = await createPkcePair();
  const authUrl = buildOAuthAuthorizeUrl({
    authorizeEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    clientId: "cid-demo",
    redirectUri: "http://127.0.0.1:8792/callback/",
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    state: "state-123",
    codeChallenge: pkce.codeChallenge,
    extraParams: { access_type: "offline" },
  });
  const parsedAuth = new URL(authUrl);
  assert.equal(parsedAuth.searchParams.get("redirect_uri"), "http://127.0.0.1:8792/callback/");
  assert.equal(parsedAuth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(parsedAuth.searchParams.get("access_type"), "offline");

  for (const reserved of ["redirect_uri", "code_challenge_method", "state", "client_id", "response_type"]) {
    assert.throws(
      () =>
        buildOAuthAuthorizeUrl({
          authorizeEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          clientId: "cid-demo",
          redirectUri: "https://app.example.com/cb/",
          scopes: [],
          state: "s",
          codeChallenge: pkce.codeChallenge,
          extraParams: { [reserved]: "evil" },
        }),
      /reserved OAuth parameter/
    );
  }
});

test("AccountsService enforces zero-secret storage across all fields, strict driver configs, concurrent discovery ownership preservation, connection reparent protection, and atomic vault switching", async () => {
  const { db, cleanup } = createTestDb();
  try {
    const svc = new AccountsService(db);
    const pem = await generateSyntheticPkcs8Pem();

    // 1. Register Infisical, 1Password, and LastPass backends
    await svc.upsertVaultBackend({ tenantId: "tenant-alpha", backendId: "inf-dev", driver: "infisical", label: "Infisical Dev", config: { env: "dev" } }, "op");
    await svc.upsertVaultBackend({ tenantId: "tenant-alpha", backendId: "op-prod", driver: "onepassword_connect", label: "1Password Ops", config: { vault: "Ops" } }, "op");
    await svc.upsertVaultBackend({ tenantId: "tenant-alpha", backendId: "lp-prod", driver: "lastpass", label: "LastPass Shared" }, "op");

    // Rejects connectToken and unknown config keys
    await assert.rejects(
      () =>
        svc.upsertVaultBackend(
          { tenantId: "tenant-alpha", backendId: "bad-op", driver: "onepassword_connect", label: "Bad", config: { connectToken: makeSynthetic("op-leak") } },
          "op"
        ),
      ValidationError
    );
    await assert.rejects(
      () =>
        svc.upsertVaultBackend(
          { tenantId: "tenant-alpha", backendId: "bad-key", driver: "infisical", label: "Bad", config: { unknownFlag: "x" } },
          "op"
        ),
      ValidationError
    );

    // Rejects PKCS#8 private key in displayName (even a short synthetic 240-char PEM)
    const shortPem = "-----BEGIN PRIVATE KEY-----\n" + "A".repeat(180) + "\n-----END PRIVATE KEY-----";
    await assert.rejects(
      () =>
        svc.upsertPrincipal(
          { tenantId: "tenant-alpha", principalId: "person:bad", kind: "human", displayName: shortPem },
          "op"
        ),
      ValidationError
    );
    await assert.rejects(
      () =>
        svc.upsertPrincipal(
          { tenantId: "tenant-alpha", principalId: "person:bad2", kind: "human", displayName: pem.slice(0, 200) },
          "op"
        ),
      ValidationError
    );

    // 2. Register principals & provider accounts
    await svc.upsertPrincipal({ tenantId: "tenant-alpha", principalId: "person:alice", kind: "human", displayName: "Alice", email: "alice@example.com" }, "op");
    await svc.upsertPrincipal({ tenantId: "tenant-alpha", principalId: "person:bob", kind: "human", displayName: "Bob", email: "bob@example.com" }, "op");
    await svc.upsertProviderAccount({ tenantId: "tenant-alpha", accountId: "acct:bing:alice", provider: "bing_webmaster", ownerPrincipalId: "person:alice", label: "Alice Bing" }, "op");
    await svc.upsertProviderAccount({ tenantId: "tenant-alpha", accountId: "acct:bing:bob", provider: "bing_webmaster", ownerPrincipalId: "person:bob", label: "Bob Bing" }, "op");

    // Cross-tenant FK rejected
    await assert.rejects(
      () =>
        svc.upsertProviderAccount(
          { tenantId: "tenant-beta", accountId: "acct:beta", provider: "bing_webmaster", ownerPrincipalId: "person:alice", label: "Cross-tenant" },
          "op"
        ),
      NotFoundError
    );

    // 3. Register connection & switch vaults Infisical -> 1Password -> LastPass
    await svc.upsertConnection(
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
    await svc.switchConnectionVault(
      {
        tenantId: "tenant-alpha",
        connectionId: "conn:bing:alice",
        vaultBackendId: "op-prod",
        vaultUri: "vault://op-prod/ops-vault/bing-alice#credential",
      },
      "op"
    );
    await svc.switchConnectionVault(
      {
        tenantId: "tenant-alpha",
        connectionId: "conn:bing:alice",
        vaultBackendId: "lp-prod",
        vaultUri: "vault://lp-prod/bing-alice#password",
      },
      "op"
    );

    // 4. CONCURRENT discovery for two distinct accounts on the same asset MUST assign canonical to exactly ONE and flag overlap on the other!
    const [rA, rB] = await Promise.all([
      svc.ingestDiscovery(
        {
          tenantId: "tenant-alpha",
          accountId: "acct:bing:alice",
          connectionId: "conn:bing:alice",
          items: [{ assetId: "site:example.com", canonicalName: "example.com", brandGroup: "brand-a", externalResourceId: "https://example.com/" }],
        },
        "op"
      ),
      svc.ingestDiscovery(
        {
          tenantId: "tenant-alpha",
          accountId: "acct:bing:bob",
          items: [{ assetId: "site:example.com", canonicalName: "example.com", externalResourceId: "https://example.com/" }],
        },
        "op"
      ),
    ]);
    assert.equal(rA.canonicalAssigned + rB.canonicalAssigned, 1, "Exactly one concurrent discovery call may claim canonical ownership");
    assert.equal(rA.overlapsFlagged + rB.overlapsFlagged, 1, "The second concurrent discovery call must flag overlap_conflict");

    // 5. Reparenting conn:bing:alice to acct:bing:bob while bound to site:example.com MUST fail with ConflictError!
    await assert.rejects(
      () =>
        svc.upsertConnection(
          {
            tenantId: "tenant-alpha",
            connectionId: "conn:bing:alice",
            accountId: "acct:bing:bob",
            authType: "api_key",
            vaultBackendId: "lp-prod",
            vaultUri: "vault://lp-prod/bing-bob#password",
          },
          "op"
        ),
      ConflictError
    );

    // 6. Explicit canonical swap succeeds cleanly
    const loser = rA.bindings[0].isCanonical ? rB.bindings[0] : rA.bindings[0];
    const swapped = await svc.setCanonicalBinding("tenant-alpha", loser.bindingId, "op");
    assert.equal(swapped.isCanonical, true);
    const whoAfter = await svc.whoOwns("tenant-alpha", "site:example.com", ["bing_webmaster", "gsc"]);
    assert.equal(whoAfter.providers.bing_webmaster.canonical?.accountId, loser.accountId);
    assert.equal(whoAfter.providers.bing_webmaster.hasOverlap, true);
    assert.deepEqual(whoAfter.missingProviders, ["gsc"]);
  } finally {
    cleanup();
  }
});

test("HTTP Worker enforces scoped auth on /api/tasks, rejects raw credentials in HTTP/MCP tasks, redacts 400 errors, executes Code Mode, and escapes rendered cockpit XSS", async () => {
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
    assert.equal((await call("/health")).status, 200);

    // 2. Hub-token-only requests MUST fail closed on BOTH /api/accounts/* AND /api/tasks!
    assert.equal((await call("/api/accounts/matrix?tenantId=tenant-alpha", { token: hubToken })).status, 401);
    assert.equal(
      (
        await call("/api/tasks", {
          method: "POST",
          token: hubToken,
          body: { topic: "accounts.matrix", spec: { action: "matrix", tenantId: "tenant-alpha" } },
        })
      ).status,
      401
    );

    // 3. Value-free validation error NEVER reflects synthetic credential supplied as driver
    const canaryBearer = makeSynthetic("driver-canary-secret");
    const badDriverRes = await call("/api/accounts/vault-backends", {
      method: "POST",
      token: alphaAdminToken,
      body: { tenantId: "tenant-alpha", backendId: "b1", driver: `Bearer ${canaryBearer}`, label: "Bad" },
    });
    assert.equal(badDriverRes.status, 400);
    const badDriverText = await badDriverRes.text();
    assert.ok(!badDriverText.includes(canaryBearer), "400 validation error must never reflect caller-supplied credential");

    // 4. Undeclared password field rejected on BOTH HTTP /api/tasks and MCP submit_task (never persisted in SQLite!)
    const pwCanary = makeSynthetic("raw-task-pw");
    const badHttpTask = await call("/api/tasks", {
      method: "POST",
      token: alphaAdminToken,
      body: { topic: "accounts.matrix", spec: { action: "matrix", tenantId: "tenant-alpha", password: pwCanary } },
    });
    assert.equal(badHttpTask.status, 400);

    const badMcpTask = await call("/mcp", {
      method: "POST",
      token: alphaAdminToken,
      body: {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "submit_task", arguments: { requestId: "req-pw", objective: "test", password: pwCanary } },
      },
    });
    const badMcpJson: any = await badMcpTask.json();
    assert.ok(badMcpJson.error || badMcpJson.result?.isError, "MCP submit_task must reject raw password field");
    const storedTasks = await db.prepare("SELECT spec_json FROM tasks").all<any>();
    assert.ok(!JSON.stringify(storedTasks.results || []).includes(pwCanary), "Raw password must never be persisted to tasks table");

    // 5. Seed graph via HTTP API (include angle brackets in backendId-adjacent audit summary via assetId to test actual cockpit HTML rendering)
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
          body: { tenantId: "tenant-alpha", principalId: "person:ops", kind: "human", displayName: "Ops", email: "ops@example.com" },
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

    // Scoped /api/tasks works for authorized caller, denies read-only on write task, denies cross-tenant
    assert.equal(
      (
        await call("/api/tasks", {
          method: "POST",
          token: alphaReadOnlyToken,
          body: { topic: "accounts.matrix", spec: { action: "matrix", tenantId: "tenant-alpha" } },
        })
      ).status,
      200
    );
    assert.equal(
      (
        await call("/api/tasks", {
          method: "POST",
          token: alphaReadOnlyToken,
          body: {
            topic: "accounts.discover",
            spec: {
              action: "discover",
              tenantId: "tenant-alpha",
              accountId: "acct:gsc:ops",
              items: [{ assetId: "site:new.com", canonicalName: "new.com", externalResourceId: "sc-domain:new.com" }],
            },
          },
        })
      ).status,
      403
    );
    assert.equal(
      (
        await call("/api/tasks", {
          method: "POST",
          token: betaAdminToken,
          body: { topic: "accounts.matrix", spec: { action: "matrix", tenantId: "tenant-alpha" } },
        })
      ).status,
      403
    );

    // 6. Resource-scoped caller can query who-owns for site:example.com, NOT site:other.com
    assert.equal((await call("/api/accounts/who-owns?tenantId=tenant-alpha&assetId=site:example.com", { token: alphaAssetScopedToken })).status, 200);
    assert.equal((await call("/api/accounts/who-owns?tenantId=tenant-alpha&assetId=site:other.com", { token: alphaAssetScopedToken })).status, 403);

    // 7. MCP Code Mode execute runs scoped SDK query end-to-end
    const codeModeRes = await call("/mcp", {
      method: "POST",
      token: alphaAssetScopedToken,
      body: {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: {
          name: "execute",
          arguments: {
            code: 'const r = await pod.whoOwns("tenant-alpha", "site:example.com"); return r.providers.gsc.canonical.vaultUri;',
          },
        },
      },
    });
    assert.equal(codeModeRes.status, 200);
    const codeModeJson: any = await codeModeRes.json();
    assert.ok(!codeModeJson.error);
    assert.match(JSON.stringify(codeModeJson.result), /vault:\/\/inf-dev\/gcloud\/SA_JSON/);

    // 8. Cockpit UI renders and escapes hostile HTML in an actually rendered column (audit event entity_id)
    assert.equal(
      (
        await call("/api/accounts/assets", {
          method: "POST",
          token: alphaAdminToken,
          body: { tenantId: "tenant-alpha", assetId: "site:<img src=x onerror=alert(1)>", assetKind: "site", canonicalName: "xss.example" },
        })
      ).status,
      201
    );
    const uiRes = await call("/", { token: hubToken });
    assert.equal(uiRes.status, 200);
    const html = await uiRes.text();
    assert.ok(!html.includes("<img src=x onerror=alert(1)>"), "Rendered cockpit HTML must escape hostile entity_id");
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "Escaped entity_id should appear in rendered audit table");
  } finally {
    cleanup();
  }
});
