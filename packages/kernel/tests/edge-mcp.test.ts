import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createEdgeMcpHandler } from "../src/edge-mcp.js";
import { createPodConnector } from "../src/connector.js";
import type { PodReceipt } from "../src/types.js";

describe("edge-mcp & PodConnector test suite", () => {
  const TOKEN = "test-token";
  const podName = "test-edge-pod";

  // Mock handlers
  const mockReceipt: PodReceipt = {
    taskId: "task-100",
    pr: "https://github.com/org/repo/pull/1",
    commit: "11223344556677889900aabbccddeeff11223344",
    checks: ["PASS test"],
    diffHash: "hash123",
    model: "gpt-6.1-sol",
    provider: "opencode",
    family: "opencode",
    runtime: "pod-kernel",
  };

  const edgeHandler = createEdgeMcpHandler({
    podName,
    podRole: "spec-architect",
    version: "1.2.0",
    bearerToken: TOKEN,
    coreHandlers: {
      onSubmitTask: async (p) => ({
        taskId: "task-100",
        requestId: p.requestId,
        phase: "verify",
        status: "running",
        existing: false,
      }),
      onTaskStatus: async () => ({
        taskId: "task-100",
        phase: "await_approval",
        status: "pending",
        checks: ["PASS typecheck"],
        diffHash: "hash123",
      }),
      onApprove: async (p) => ({
        ok: true,
        decision: p.decision,
      }),
      onCancel: async () => ({
        ok: true,
        status: "aborted",
      }),
      onGetReceipt: async () => mockReceipt,
    },
    tools: [
      {
        name: "custom_ping",
        description: "A custom domain tool",
        inputSchema: {
          type: "object",
          properties: {
            msg: { type: "string" },
          },
          required: ["msg"],
        },
        handler: async (args) => {
          return { echo: `echo:${args.msg}` };
        },
      },
    ],
  });

  // Mock fetch router to simulate Cloudflare Workers routing
  const mockFetch: typeof fetch = async (input, init) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "healthy", podId: podName, version: "1.2.0" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/mcp") {
      const req = new Request(urlStr, init);
      return edgeHandler(req);
    }

    return new Response("Not Found", { status: 404 });
  };

  const connector = createPodConnector({
    baseUrl: "https://mock-pod.internal",
    bearerToken: TOKEN,
    fetchFn: mockFetch,
  });

  test("GET /mcp discovery document contains core tools and custom tools", async () => {
    const discovery = await connector.discover();
    assert.equal(discovery.mcpVersion, "2026-07-28");
    assert.equal(discovery.server.name, podName);
    assert.equal(discovery.server.role, "spec-architect");
    assert.equal(discovery.server.version, "1.2.0");

    const toolNames = discovery.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      "approve",
      "cancel",
      "custom_ping",
      "get_receipt",
      "submit_task",
      "task_status",
    ].sort());
  });

  test("health check resolves successfully", async () => {
    const health = await connector.health();
    assert.equal(health.status, "healthy");
    assert.equal(health.podId, podName);
  });

  test("listTools returns registered tools via POST /mcp", async () => {
    const tools = await connector.listTools();
    assert.equal(tools.length, 6);
  });

  test("submitTask executes submit_task tool cleanly", async () => {
    const res = await connector.submitTask({
      repo: "org/repo",
      issue: 42,
      requestId: "req-abc",
    });
    assert.equal(res.taskId, "task-100");
    assert.equal(res.phase, "verify");
    assert.equal(res.status, "running");
  });

  test("taskStatus returns phase and checks", async () => {
    const res = await connector.taskStatus({ taskId: "task-100" });
    assert.equal(res.taskId, "task-100");
    assert.equal(res.phase, "await_approval");
    assert.deepEqual(res.checks, ["PASS typecheck"]);
  });

  test("approve registers decision", async () => {
    const res = await connector.approve({ taskId: "task-100", decision: "approve" });
    assert.equal(res.ok, true);
    assert.equal(res.decision, "approve");
  });

  test("cancel aborts task", async () => {
    const res = await connector.cancel({ taskId: "task-100" });
    assert.equal(res.ok, true);
    assert.equal(res.status, "aborted");
  });

  test("getReceipt returns full cryptographic receipt", async () => {
    const res = await connector.getReceipt({ taskId: "task-100" });
    assert.equal(res.taskId, "task-100");
    assert.equal(res.diffHash, "hash123");
    assert.equal(res.model, "gpt-6.1-sol");
  });

  test("callTool executes custom pod tool", async () => {
    const res = await connector.callTool("custom_ping", { msg: "hello-edge" });
    assert.deepEqual(res, { echo: "echo:hello-edge" });
  });

  test("auth gate rejects unauthenticated POST calls with 401", async () => {
    const unauthConnector = createPodConnector({
      baseUrl: "https://mock-pod.internal",
      bearerToken: "wrong-token",
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => unauthConnector.listTools(),
      (err: any) => err.message.includes("401") || err.message.includes("Unauthorized")
    );
  });
});

describe("edge-mcp MCP v2 (2026-07-28) extensions + Code Mode", () => {
  const TOKEN = "v2-token";
  let writeCount = 0;

  const handler = createEdgeMcpHandler({
    podName: "measurement-pod",
    podRole: "measurement",
    version: "2.0.0",
    bearerToken: TOKEN,
    resources: [
      {
        uri: "pod://measurement/spec",
        name: "Measurement Spec",
        mimeType: "application/json",
        read: async () => ({ text: JSON.stringify({ families: ["seo", "analytics", "spend", "telemetry"] }) }),
      },
    ],
    tasks: {
      list: async ({ limit }) => ({ tasks: [{ taskId: "t-1", status: "completed", limit: limit ?? 20 }] }),
      get: async ({ taskId }) =>
        taskId === "t-1" ? { taskId: "t-1", status: "pending", resultType: "pending" as any } : null,
      cancel: async ({ taskId }) => ({ taskId, status: "cancelled" }),
    },
    codeMode: {
      timeoutMs: 180,
      spec: [
        {
          name: "listSites",
          method: "pod.listSites()",
          description: "List registered sites for the caller",
          signature: "() => Promise<string[]>",
          tags: ["sites", "resources"],
        },
        {
          name: "sumMetrics",
          method: "pod.sumMetrics(nums)",
          description: "Sum numeric observations",
          signature: "(nums: number[]) => Promise<number>",
          tags: ["metrics", "series"],
        },
        {
          name: "recordWrite",
          method: "pod.recordWrite(tag)",
          description: "Record a write call for deadline-revocation testing",
          signature: "(tag: string) => Promise<number>",
          tags: ["write"],
        },
      ],
      createSdk: () => ({
        listSites: async () => ["alpha.test", "beta.test"],
        sumMetrics: async (nums: number[]) => nums.reduce((a, b) => a + b, 0),
        recordWrite: async () => {
          writeCount += 1;
          return writeCount;
        },
      }),
    },
  });

  const post = (body: any, headers: Record<string, string> = {}, env?: any) =>
    handler(
      new Request("https://pod.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
          ...headers,
        },
        body: JSON.stringify(body),
      }),
      env
    );

  test("server/discover returns 2026-07-28 supportedVersions, resultType, and io.modelcontextprotocol/tasks extension", async () => {
    const res = await post({ jsonrpc: "2.0", id: "d1", method: "server/discover" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("MCP-Protocol-Version"), "2026-07-28");
    const json = (await res.json()) as any;
    assert.equal(json.result.resultType, "complete");
    assert.equal(json.result.protocolVersion, "2026-07-28");
    assert.deepEqual(json.result.supportedVersions, ["2026-07-28", "2024-11-05"]);
    assert.equal(json.result.capabilities.extensions["io.modelcontextprotocol/tasks"].get, true);
    assert.equal(json.result.capabilities.experimental.codeMode.execute, true);

    const pingRes = await post({ jsonrpc: "2.0", id: "p1", method: "ping" });
    const pingJson = (await pingRes.json()) as any;
    assert.equal(pingJson.result.resultType, "complete");

    const notifRes = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(notifRes.status, 202);
    assert.equal(await notifRes.text(), "");
  });

  test("validates exact MCP protocol version headers, Mcp-Name, Mcp-Method, and body _meta.protocolVersion with HeaderMismatch", async () => {
    // Unsupported header version -> 400
    const badVer = await post(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { "MCP-Protocol-Version": "2099-01-01" }
    );
    assert.equal(badVer.status, 400);

    // Body _meta.protocolVersion mismatch -> 400 HeaderMismatch
    const badMeta = await post(
      {
        jsonrpc: "2.0",
        id: "m1",
        method: "ping",
        params: { _meta: { protocolVersion: "2099-01-01" } },
      },
      { "MCP-Protocol-Version": "2026-07-28" }
    );
    assert.equal(badMeta.status, 400);
    const badMetaJson = (await badMeta.json()) as any;
    assert.equal(badMetaJson.error.data.error, "HeaderMismatch");

    // Legacy initialize body negotiation aligns response header to negotiated version
    const v1Init = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    assert.equal(v1Init.status, 200);
    assert.equal(v1Init.headers.get("MCP-Protocol-Version"), "2024-11-05");
    const v1Json = (await v1Init.json()) as any;
    assert.equal(v1Json.result.protocolVersion, "2024-11-05");
    assert.equal(v1Json.result.resultType, undefined);

    // Mcp-Name header mismatch (header claims readOnly, body invokes execute) -> 400 HeaderMismatch, tool NOT executed
    const beforeWrites = writeCount;
    const mismatch = await post(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "execute", arguments: { code: "return await pod.recordWrite('smuggled');" } },
      },
      { "Mcp-Method": "tools/call", "Mcp-Name": "readOnly" }
    );
    assert.equal(mismatch.status, 400);
    const mismatchJson = (await mismatch.json()) as any;
    assert.equal(mismatchJson.error.data.error, "HeaderMismatch");
    assert.equal(writeCount, beforeWrites);
  });

  test("supports isolated batch JSON-RPC, flat tasks/get + tasks/cancel with resultType complete, resources/*, and omits notification responses", async () => {
    const res = await post([
      { jsonrpc: "2.0", id: "b1", method: "tasks/list", params: { limit: 5 } },
      { jsonrpc: "2.0", id: "b2", method: "tasks/get", params: { taskId: "t-1" } },
      { jsonrpc: "2.0", id: "b3", method: "tasks/cancel", params: { taskId: "t-1" } },
      { jsonrpc: "2.0", id: "b4", method: "resources/list" },
      { jsonrpc: "2.0", id: "b5", method: "resources/read", params: { uri: "pod://measurement/spec" } },
      { jsonrpc: "2.0", id: "b6", method: "tools/call", params: null }, // malformed member isolated
      { jsonrpc: "2.0", method: "ping" }, // notification (no id) -> no response
    ]);
    assert.equal(res.status, 200);
    const batch = (await res.json()) as any[];
    assert.equal(batch.length, 6);
    assert.equal(batch[0].result.tasks[0].taskId, "t-1");
    assert.equal(batch[1].result.taskId, "t-1");
    assert.equal(batch[1].result.status, "pending");
    assert.equal(batch[1].result.resultType, "complete"); // discriminator enforced even when task status is pending
    assert.equal(batch[2].result.resultType, "complete");
    assert.equal(batch[3].result.resources[0].uri, "pod://measurement/spec");
    assert.match(batch[4].result.contents[0].text, /"telemetry"/);
    assert.equal(batch[5].id, "b6");
    assert.equal(batch[5].error.code, -32602);
  });

  test("Code Mode search filters typed SDK spec and execute runs multi-step code in OS-isolated subprocess", async () => {
    const searchRes = await post({
      jsonrpc: "2.0",
      id: "s1",
      method: "tools/call",
      params: { name: "search", arguments: { query: "sites" } },
    });
    const searchJson = (await searchRes.json()) as any;
    assert.equal(searchJson.result.resultType, "complete");
    const searchData = JSON.parse(searchJson.result.content[0].text);
    assert.equal(searchData.total, 1);
    assert.equal(searchData.entries[0].name, "listSites");

    const execRes = await post({
      jsonrpc: "2.0",
      id: "e1",
      method: "tools/call",
      params: {
        name: "execute",
        arguments: {
          code: "console.log(null); console.log('noise'); const sites = await pod.listSites(); const total = await pod.sumMetrics([10, 20, 12]); return { count: sites.length, total, big: 'x'.repeat(70000).length };",
        },
      },
    });
    assert.equal(execRes.status, 200);
    const execJson = (await execRes.json()) as any;
    assert.equal(execJson.result.resultType, "complete");
    const execData = JSON.parse(execJson.result.content[0].text);
    assert.deepEqual(execData, { ok: true, result: { count: 2, total: 42, big: 70000 } });

    const bigRes = await post({
      jsonrpc: "2.0",
      id: "e2",
      method: "tools/call",
      params: {
        name: "execute",
        arguments: { code: "return 'x'.repeat(131072);" },
      },
    });
    assert.equal(bigRes.status, 200);
    const bigJson = (await bigRes.json()) as any;
    const bigData = JSON.parse(bigJson.result.content[0].text);
    assert.equal(bigData.ok, true);
    assert.equal(bigData.result.length, 131072);
  });

  test("Code Mode OS-permission isolate blocks host env secrets, filesystem reads, and loopback network access", async () => {
    const prevSecret = process.env.TEST_HOST_SECRET_PROBE;
    process.env.TEST_HOST_SECRET_PROBE = "synthetic-host-secret-xyz";
    try {
      const res = await post({
        jsonrpc: "2.0",
        id: "esc1",
        method: "tools/call",
        params: {
          name: "execute",
          arguments: {
            code: `
              let fsErr = null, netErr = null, envLeak = null;
              try {
                const p = Object['constructor']('return pro' + 'cess')();
                envLeak = p.env && p.env.TEST_HOST_SECRET_PROBE ? p.env.TEST_HOST_SECRET_PROBE : null;
                const fs = p.getBuiltinModule('node:fs');
                fs.readFileSync('package.json', 'utf8');
              } catch (e) { fsErr = e.code || e.message; }
              try {
                const p = Object['constructor']('return pro' + 'cess')();
                const http = p.getBuiltinModule('node:http');
                await new Promise((resolve, reject) => {
                  const r = http.get('http://127.0.0.1:1/', () => resolve('connected'));
                  r.on('error', reject);
                });
              } catch (e) { netErr = e.code || e.message; }
              return { envLeak, fsErr, netErr };
            `,
          },
        },
      });
      const text = await res.text();
      assert.equal(text.includes("synthetic-host-secret-xyz"), false);
      const json = JSON.parse(text);
      const payload = JSON.parse(json.result.content[0].text).result;
      assert.equal(payload.envLeak, null);
      assert.equal(payload.fsErr, "ERR_ACCESS_DENIED");
      assert.equal(payload.netErr, "ERR_ACCESS_DENIED");
    } finally {
      if (prevSecret === undefined) delete process.env.TEST_HOST_SECRET_PROBE;
      else process.env.TEST_HOST_SECRET_PROBE = prevSecret;
    }
  });

  test("Code Mode hard-terminates post-await CPU spin and revokes SDK writes on timeout", async () => {
    const before = writeCount;
    const started = Date.now();
    const res = await post({
      jsonrpc: "2.0",
      id: "to1",
      method: "tools/call",
      params: {
        name: "execute",
        arguments: {
          code: "await 0; const end = Date.now() + 800; while (Date.now() < end) {} await pod.recordWrite('after-timeout'); return 'late';",
        },
      },
    });
    const elapsed = Date.now() - started;
    assert.equal(res.status, 500);
    const json = (await res.json()) as any;
    assert.match(json.error.message, /timed out/i);
    assert.ok(elapsed < 550, `Expected hard termination well before 800ms spin; took ${elapsed}ms`);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(writeCount, before, "SDK write must not execute after timeout revocation");
  });

  test("Code Mode uses Cloudflare Dynamic Worker Loader (worker.js + globalOutbound: null)", async () => {
    let capturedConfig: any = null;
    const mockLoader = {
      load: (config: any) => {
        capturedConfig = config;
        return {
          getEntrypoint: () => ({
            fetch: async () =>
              new Response(JSON.stringify({ ok: true, result: { viaLoader: 12 } }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
          }),
        };
      },
    };

    const res = await post(
      {
        jsonrpc: "2.0",
        id: "wl1",
        method: "tools/call",
        params: { name: "execute", arguments: { code: "return await pod.sumMetrics([3, 4, 5]);" } },
      },
      {},
      { CODE_LOADER: mockLoader }
    );
    assert.equal(res.status, 200);
    assert.equal(capturedConfig.mainModule, "worker.js");
    assert.ok(typeof capturedConfig.modules["worker.js"] === "string");
    assert.equal(capturedConfig.globalOutbound, null);
    const json = (await res.json()) as any;
    const data = JSON.parse(json.result.content[0].text);
    assert.deepEqual(data, { ok: true, result: { viaLoader: 12 } });
  });
});
