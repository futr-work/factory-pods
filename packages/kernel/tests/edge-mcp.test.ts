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
        taskId === "t-1" ? { taskId: "t-1", status: "completed", resultType: "complete" } : null,
      cancel: async ({ taskId }) => ({ taskId, status: "cancelled", resultType: "cancelled" }),
    },
    codeMode: {
      timeoutMs: 120,
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

  test("server/discover returns 2026-07-28 capabilities and io.modelcontextprotocol/tasks extension", async () => {
    const res = await post({ jsonrpc: "2.0", id: "d1", method: "server/discover" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("MCP-Protocol-Version"), "2026-07-28");
    const json = (await res.json()) as any;
    assert.equal(json.result.protocolVersion, "2026-07-28");
    assert.deepEqual(json.result.supportedProtocolVersions, ["2026-07-28", "2024-11-05"]);
    assert.equal(json.result.capabilities.extensions["io.modelcontextprotocol/tasks"].get, true);
    assert.equal(json.result.capabilities.experimental.codeMode.execute, true);
  });

  test("validates exact MCP protocol version headers and rejects unsupported versions or routing mismatches with 400", async () => {
    // Unsupported header version -> 400
    const badVer = await post(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { "MCP-Protocol-Version": "2099-01-01" }
    );
    assert.equal(badVer.status, 400);

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

    // Routing header mismatch (header claims tools/list, body invokes tools/call) -> 400, tool NOT executed
    const beforeWrites = writeCount;
    const mismatch = await post(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "execute", arguments: { code: "return await pod.recordWrite('smuggled');" } },
      },
      { "MCP-Method": "tools/list" }
    );
    assert.equal(mismatch.status, 400);
    assert.equal(writeCount, beforeWrites);
  });

  test("supports isolated batch JSON-RPC, flat tasks/get resultType, resources/*, and omits notification responses", async () => {
    const res = await post([
      { jsonrpc: "2.0", id: "b1", method: "tasks/list", params: { limit: 5 } },
      { jsonrpc: "2.0", id: "b2", method: "tasks/get", params: { taskId: "t-1" } },
      { jsonrpc: "2.0", id: "b3", method: "resources/list" },
      { jsonrpc: "2.0", id: "b4", method: "resources/read", params: { uri: "pod://measurement/spec" } },
      { jsonrpc: "2.0", id: "b5", method: "tools/call", params: null }, // malformed member isolated
      { jsonrpc: "2.0", method: "ping" }, // notification (no id) -> no response
    ]);
    assert.equal(res.status, 200);
    const batch = (await res.json()) as any[];
    assert.equal(batch.length, 5);
    assert.equal(batch[0].result.tasks[0].taskId, "t-1");
    assert.equal(batch[1].result.taskId, "t-1");
    assert.equal(batch[1].result.resultType, "complete");
    assert.equal(batch[2].result.resources[0].uri, "pod://measurement/spec");
    assert.match(batch[3].result.contents[0].text, /"telemetry"/);
    assert.equal(batch[4].id, "b5");
    assert.equal(batch[4].error.code, -32602);
  });

  test("Code Mode search filters typed SDK spec and execute runs multi-step code in isolated worker", async () => {
    const searchRes = await post({
      jsonrpc: "2.0",
      id: "s1",
      method: "tools/call",
      params: { name: "search", arguments: { query: "sites" } },
    });
    const searchJson = (await searchRes.json()) as any;
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
          code: "const sites = await pod.listSites(); const total = await pod.sumMetrics([10, 20, 12]); return { count: sites.length, total };",
        },
      },
    });
    assert.equal(execRes.status, 200);
    const execJson = (await execRes.json()) as any;
    const execData = JSON.parse(execJson.result.content[0].text);
    assert.deepEqual(execData, { ok: true, result: { count: 2, total: 42 } });
  });

  test("Code Mode isolate cannot read host process.env secrets or escape via Object['constructor']", async () => {
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
            code: "try { const p = Object['constructor']('return pro' + 'cess')(); return { env: p.env }; } catch (e) { return { blocked: e.message }; }",
          },
        },
      });
      const text = await res.text();
      assert.equal(text.includes("synthetic-host-secret-xyz"), false);
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
          code: "await 0; const end = Date.now() + 600; while (Date.now() < end) {} await pod.recordWrite('after-timeout'); return 'late';",
        },
      },
    });
    const elapsed = Date.now() - started;
    assert.equal(res.status, 500);
    const json = (await res.json()) as any;
    assert.match(json.error.message, /timed out/i);
    assert.ok(elapsed < 450, `Expected hard termination well before 600ms spin; took ${elapsed}ms`);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(writeCount, before, "SDK write must not execute after timeout revocation");
  });

  test("Code Mode uses Cloudflare Dynamic Worker Loader binding (CODE_LOADER) with globalOutbound: null when bound", async () => {
    let capturedConfig: any = null;
    const mockLoader = {
      get: (_id: string, getCode: () => Promise<any>) => ({
        getEntrypoint: () => ({
          fetch: async () => {
            capturedConfig = await getCode();
            // Exercise the injected POD_SDK bridge directly
            const rpcRes = await capturedConfig.env.POD_SDK.fetch(
              new Request("https://pod-sdk.internal/call", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ method: "sumMetrics", args: [[3, 4, 5]] }),
              })
            );
            const rpcJson = (await rpcRes.json()) as any;
            return new Response(JSON.stringify({ ok: true, result: { viaLoader: rpcJson.result } }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        }),
      }),
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
    assert.equal(capturedConfig.globalOutbound, null);
    const json = (await res.json()) as any;
    const data = JSON.parse(json.result.content[0].text);
    assert.deepEqual(data, { ok: true, result: { viaLoader: 12 } });
  });
});
