import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startPodMcpServer } from "../src/mcp.js";
import { createPodClient } from "../src/client.js";
import type { PodReceipt } from "../src/types.js";

describe("pod-kernel MCP server and client contract", () => {
  let serverInstance: any;
  let serverUrl: string;
  const TOKEN = "test-token-123";

  before(async () => {
    serverInstance = await startPodMcpServer({
      podName: "test-pod",
      port: 0,
      host: "127.0.0.1",
      bearerToken: TOKEN,
      handlers: {
        onSubmitTask: async (params) => ({
          taskId: "task-42",
          requestId: params.requestId,
          phase: "fetch",
          status: "pending",
          existing: false,
        }),
        onTaskStatus: async () => ({
          taskId: "task-42",
          phase: "await_approval",
          status: "pending",
          checks: ["PASS test"],
          diffHash: "abc1234",
        }),
        onApprove: async (params) => ({
          ok: true,
          decision: params.decision,
        }),
        onCancel: async () => ({
          ok: true,
          status: "aborted",
        }),
        onGetReceipt: async () => ({
          taskId: "task-42",
          pr: "https://github.com/org/repo/pull/1",
          commit: "11223344556677889900aabbccddeeff11223344",
          checks: ["PASS test"],
          diffHash: "abc1234",
          model: "gpt-6.1-sol",
          provider: "opencode",
          family: "opencode",
          runtime: "pod-kernel",
        } as PodReceipt),
      },
    });

    serverUrl = `http://127.0.0.1:${serverInstance.port}/mcp`;
  });

  after(async () => {
    if (serverInstance) await serverInstance.close();
  });

  test("health check returns status 200 without auth", async () => {
    const client = createPodClient({ baseUrl: serverUrl, bearerToken: TOKEN });
    const health = await client.health();
    assert.equal(health.status, "ok");
    assert.equal(health.pod, "test-pod");
  });

  test("lists all 5 required tools", async () => {
    const client = createPodClient({ baseUrl: serverUrl, bearerToken: TOKEN });
    const toolList = await client.listTools();
    const names = toolList.tools.map((t: any) => t.name).sort();
    assert.deepEqual(names, ["approve", "cancel", "get_receipt", "submit_task", "task_status"].sort());
    await client.close();
  });

  test("submit_task returns taskId and phase", async () => {
    const client = createPodClient({ baseUrl: serverUrl, bearerToken: TOKEN });
    const res = await client.submitTask({
      repo: "org/repo",
      issue: 1,
      requestId: "req-1",
    });
    assert.equal(res.taskId, "task-42");
    assert.equal(res.phase, "fetch");
    await client.close();
  });

  test("task_status returns phase and checks", async () => {
    const client = createPodClient({ baseUrl: serverUrl, bearerToken: TOKEN });
    const res = await client.taskStatus({ taskId: "task-42" });
    assert.equal(res.phase, "await_approval");
    assert.equal(res.diffHash, "abc1234");
    await client.close();
  });

  test("approve registers decision", async () => {
    const client = createPodClient({ baseUrl: serverUrl, bearerToken: TOKEN });
    const res = await client.approve({ taskId: "task-42", decision: "approve" });
    assert.equal(res.ok, true);
    assert.equal(res.decision, "approve");
    await client.close();
  });

  test("cancel aborts task", async () => {
    const client = createPodClient({ baseUrl: serverUrl, bearerToken: TOKEN });
    const res = await client.cancel({ taskId: "task-42" });
    assert.equal(res.ok, true);
    assert.equal(res.status, "aborted");
    await client.close();
  });

  test("getReceipt returns full receipt", async () => {
    const client = createPodClient({ baseUrl: serverUrl, bearerToken: TOKEN });
    const res = await client.getReceipt({ taskId: "task-42" });
    assert.equal(res.taskId, "task-42");
    assert.equal(res.provider, "opencode");
    assert.equal(res.runtime, "pod-kernel");
    await client.close();
  });
});
