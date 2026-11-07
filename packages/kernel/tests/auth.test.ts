// C1 containment: every pod route except /health requires the hub token. Single shared gate for all pods.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { authGate } from "../src/auth.js";

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
