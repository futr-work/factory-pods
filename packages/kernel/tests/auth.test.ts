// C1 containment: every pod route except /health requires the hub token. Single shared gate for all pods.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  authGate,
  authorizeScopedCaller,
  isCallerAuthorized,
  parseScopedCallerGrants,
  resolveScopedCaller,
  sha256Hex,
} from "../src/auth.js";

const env = { FACTORY_HUB_TOKEN: "pod-secret" };
const req = (method: string, path: string, auth?: string) =>
  new Request(`https://pod.test${path}`, { method, headers: auth ? { Authorization: auth } : {} });

describe("shared pod auth gate", () => {
  test("health is open", () => assert.equal(authGate(req("GET", "/health"), env), null));
  test("task injection without a credential is rejected", () => {
    assert.equal(authGate(req("POST", "/api/task"), env)!.status, 401);
    assert.equal(authGate(req("GET", "/api/tasks"), env)!.status, 401);
    assert.equal(authGate(req("GET", "/"), env)!.status, 401);
  });
  test("wrong token is rejected; bearer and basic with the right token pass", () => {
    assert.equal(authGate(req("POST", "/api/task", "Bearer nope"), env)!.status, 401);
    assert.equal(authGate(req("POST", "/api/task", "Bearer pod-secret"), env), null);
    assert.equal(authGate(req("GET", "/", `Basic ${btoa("op:pod-secret")}`), env), null);
  });
  test("fails closed without a configured token", () => {
    assert.equal(authGate(req("GET", "/api/tasks", "Bearer pod-secret"), {})!.status, 401);
    assert.equal(authGate(req("GET", "/api/tasks", "Bearer pod-secret"), { FACTORY_HUB_TOKEN: "" })!.status, 401);
  });
  test("a well-known dev password is never accepted alongside the configured token", () => {
    assert.equal(authGate(req("GET", "/api/tasks", "Bearer dev-token"), env)!.status, 401);
    assert.equal(authGate(req("GET", "/", `Basic ${btoa("op:dev-token")}`), env)!.status, 401);
  });
  test("the 401 challenge carries the caller's realm", () => {
    assert.equal(authGate(req("GET", "/"), env)!.headers.get("WWW-Authenticate"), 'Basic realm="factory-pod"');
    assert.equal(authGate(req("GET", "/"), env, "model-governor")!.headers.get("WWW-Authenticate"), 'Basic realm="model-governor"');
  });
});

describe("scoped caller grant resolver (fail-closed tenant/resource isolation)", () => {
  test("two distinct scoped credentials enforce bidirectional cross-tenant denial and ungranted shared token fails closed", async () => {
    const tokenA = "scoped-secret-alpha-001";
    const tokenB = "scoped-secret-beta-002";
    const sharedHubToken = "pod-secret";

    const rawConfig = JSON.stringify([
      {
        callerId: "caller-a",
        tokenSha256: await sha256Hex(tokenA),
        grants: [{ tenantId: "tenant-a", resourceIds: ["res-a1"], actions: ["read", "write"] }],
      },
      {
        callerId: "caller-b",
        tokenSha256: await sha256Hex(tokenB),
        grants: [{ tenantId: "tenant-b", resourceIds: ["res-b1"], actions: ["read"] }],
      },
    ]);

    const configured = parseScopedCallerGrants(rawConfig);
    assert.equal(configured.length, 2);

    const callerA = await resolveScopedCaller(req("GET", "/api/measurement/series", `Bearer ${tokenA}`), configured);
    const callerB = await resolveScopedCaller(req("GET", "/api/measurement/series", `Bearer ${tokenB}`), configured);
    const sharedCaller = await resolveScopedCaller(req("GET", "/api/measurement/series", `Bearer ${sharedHubToken}`), configured);

    assert.equal(callerA?.callerId, "caller-a");
    assert.equal(callerB?.callerId, "caller-b");
    assert.equal(sharedCaller, null);

    // Caller A can read/write tenant-a/res-a1, denied on tenant-b and other resources
    assert.equal(isCallerAuthorized(callerA, { tenantId: "tenant-a", resourceId: "res-a1", action: "read" }), true);
    assert.equal(isCallerAuthorized(callerA, { tenantId: "tenant-a", resourceId: "res-a1", action: "write" }), true);
    assert.equal(isCallerAuthorized(callerA, { tenantId: "tenant-b", resourceId: "res-b1", action: "read" }), false);
    assert.equal(isCallerAuthorized(callerA, { tenantId: "tenant-a", resourceId: "res-a2", action: "read" }), false);

    // Caller B can read tenant-b/res-b1, denied write and denied tenant-a
    assert.equal(isCallerAuthorized(callerB, { tenantId: "tenant-b", resourceId: "res-b1", action: "read" }), true);
    assert.equal(isCallerAuthorized(callerB, { tenantId: "tenant-b", resourceId: "res-b1", action: "write" }), false);
    assert.equal(isCallerAuthorized(callerB, { tenantId: "tenant-a", resourceId: "res-a1", action: "read" }), false);

    // HTTP gate returns 401 for ungranted shared token, 403 for cross-tenant, null for permitted
    assert.equal(authorizeScopedCaller(sharedCaller, { tenantId: "tenant-a", resourceId: "res-a1", action: "read" })!.status, 401);
    assert.equal(authorizeScopedCaller(callerA, { tenantId: "tenant-b", resourceId: "res-b1", action: "read" })!.status, 403);
    assert.equal(authorizeScopedCaller(callerA, { tenantId: "tenant-a", resourceId: "res-a1", action: "read" }), null);
  });

  test("parseScopedCallerGrants fails closed on malformed JSON or invalid sha256", () => {
    assert.deepEqual(parseScopedCallerGrants("not-json"), []);
    assert.deepEqual(
      parseScopedCallerGrants(JSON.stringify([{ callerId: "x", tokenSha256: "short", grants: [] }])),
      []
    );
  });
});
