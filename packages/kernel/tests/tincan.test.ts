import { test } from "node:test";
import assert from "node:assert/strict";
import { TincanClient, TincanMeshClient, withHubAuth, type TincanClientConfig } from "../src/tincan.js";

const config: TincanClientConfig = {
  id: "pod:test", name: "test", role: "tester", lob: "qa", capabilities: ["x"],
  hubUrl: "https://hub.test", hubToken: "tok-123",
};

test("pod sends FACTORY_HUB_TOKEN as Bearer on every hub call via service binding", async () => {
  const seen: (string | null)[] = [];
  const binding = {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("Authorization"));
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    },
  };
  const client = new TincanClient(config, binding);
  await client.sendHeartbeat();
  await client.pollInbox(5);
  await client.acknowledge("m1");
  await client.publish("t", "pod:x", {});
  assert.equal(seen.length, 4);
  for (const h of seen) assert.equal(h, "Bearer tok-123");
});

test("withHubAuth preserves existing headers and is a no-op without a token", () => {
  const init = withHubAuth({ method: "POST", headers: { "Content-Type": "application/json" } }, "t");
  const h = new Headers(init?.headers);
  assert.equal(h.get("Content-Type"), "application/json");
  assert.equal(h.get("Authorization"), "Bearer t");
  const plain = { method: "GET" };
  assert.equal(withHubAuth(plain, ""), plain);
});

test("unreachable hub yields false/empty instead of throwing", async () => {
  const client = new TincanClient(config, async () => { throw new Error("down"); });
  const quiet = console.warn; console.warn = () => {};
  try {
    assert.equal(await client.sendHeartbeat(), false);
    assert.deepEqual(await client.pollInbox(), []);
    assert.equal(await client.acknowledge("m"), false);
    assert.equal(await client.publish("t", "pod:x", 1), false);
  } finally { console.warn = quiet; }
});

test("mesh client posts the heartbeat with bearer via service binding and falls back to false on error", async () => {
  let seen: { url: string; auth: string | null } | null = null;
  const binding = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), auth: new Headers(init?.headers).get("Authorization") };
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  };
  const payload = { podId: "p", name: "n", role: "r", lob: "l", endpoint: "e", status: "healthy" as const, timestamp: 1 };
  assert.equal(await new TincanMeshClient(binding, undefined, "tok").sendHeartbeat(payload), true);
  assert.deepEqual(seen, { url: "https://factory-hub/api/heartbeat", auth: "Bearer tok" });
  const broken = { fetch: (async () => { throw new Error("x"); }) as typeof fetch };
  assert.equal(await new TincanMeshClient(broken).sendHeartbeat(payload), false);
});
