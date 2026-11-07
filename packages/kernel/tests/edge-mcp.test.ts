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
    assert.equal(discovery.mcpVersion, "2024-11-05");
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
