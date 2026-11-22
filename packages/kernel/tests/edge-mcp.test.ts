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
      get: async ({ taskId }) => ({ task: taskId === "t-1" ? { taskId: "t-1", status: "completed" } : null }),
      cancel: async ({ taskId }) => ({ ok: true, status: `cancelled:${taskId}` }),
    },
    codeMode: {
      timeoutMs: 500,
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
      ],
      createSdk: () => ({
        listSites: async () => ["alpha.test", "beta.test"],
        sumMetrics: async (nums: number[]) => nums.reduce((a, b) => a + b, 0),
      }),
    },
  });

  const post = (body: any, headers: Record<string, string> = {}) =>
    handler(
      new Request("https://pod.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
          ...headers,
        },
        body: JSON.stringify(body),
      })
    );

  test("negotiates 2026-07-28 by default and falls back to 2024-11-05 when requested", async () => {
    const resV2 = await post({ jsonrpc: "2.0", id: 1, method: "initialize" });
    assert.equal(resV2.status, 200);
    assert.equal(resV2.headers.get("Mcp-Version"), "2026-07-28");
    const jsonV2 = (await resV2.json()) as any;
    assert.equal(jsonV2.result.protocolVersion, "2026-07-28");
    assert.equal(jsonV2.result.capabilities.experimental.codeMode.execute, true);

    const resV1 = await post(
      { jsonrpc: "2.0", id: 2, method: "initialize" },
      { "Mcp-Version": "2024-11-05" }
    );
    assert.equal(resV1.headers.get("Mcp-Version"), "2024-11-05");
    const jsonV1 = (await resV1.json()) as any;
    assert.equal(jsonV1.result.protocolVersion, "2024-11-05");
  });

  test("supports batch JSON-RPC, tasks/*, and resources/*", async () => {
    const res = await post([
      { jsonrpc: "2.0", id: "b1", method: "tasks/list", params: { limit: 5 } },
      { jsonrpc: "2.0", id: "b2", method: "tasks/get", params: { taskId: "t-1" } },
      { jsonrpc: "2.0", id: "b3", method: "resources/list" },
      { jsonrpc: "2.0", id: "b4", method: "resources/read", params: { uri: "pod://measurement/spec" } },
    ]);
    assert.equal(res.status, 200);
    const batch = (await res.json()) as any[];
    assert.equal(batch.length, 4);
    assert.equal(batch[0].result.tasks[0].taskId, "t-1");
    assert.equal(batch[1].result.task.status, "completed");
    assert.equal(batch[2].result.resources[0].uri, "pod://measurement/spec");
    assert.match(batch[3].result.contents[0].text, /"telemetry"/);
  });

  test("Code Mode search filters typed SDK spec and execute runs multi-step code in sandbox", async () => {
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

  test("Code Mode sandbox blocks forbidden globals (process, fetch, Function, prototype traversal)", async () => {
    for (const badCode of [
      "return process.env;",
      "return await fetch('https://example.com');",
      "return Function('return 1')();",
      "return ({}).constructor.constructor('return 1')();",
    ]) {
      const res = await post({
        jsonrpc: "2.0",
        id: "bad",
        method: "tools/call",
        params: { name: "execute", arguments: { code: badCode } },
      });
      assert.equal(res.status, 500);
      const json = (await res.json()) as any;
      assert.match(json.error.message, /Sandbox policy violation/);
    }
  });
});
