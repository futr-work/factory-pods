import test from "node:test";
import assert from "node:assert/strict";
import { handleMcpRequest } from "../src/mcp.js";
import { createPodConnector } from "../src/connector.js";
import { loadPodConfig } from "../src/config.js";

test("starter pod: MCP server discovery endpoint (GET /mcp)", async () => {
  const config = loadPodConfig();
  const req = new Request("https://starter-pod.local/mcp", { method: "GET" });
  const res = await handleMcpRequest(req, {}, config);

  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.mcpVersion, "2024-11-05");
  const toolNames = data.tools.map((t: any) => t.name).sort();
  assert.deepEqual(toolNames, ["approve", "cancel", "get_receipt", "submit_task", "task_status"].sort());
});

test("starter pod: MCP JSON-RPC initialize", async () => {
  const config = loadPodConfig();
  const req = new Request("https://starter-pod.local/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }),
  });

  const res = await handleMcpRequest(req, {}, config);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.jsonrpc, "2.0");
  assert.equal(data.id, 1);
  assert.equal(data.result.protocolVersion, "2024-11-05");
  assert.equal(data.result.serverInfo.name, config.id);
});

test("starter pod: PodConnector interacts seamlessly with Cloudflare MCP v2", async () => {
  const config = loadPodConfig();

  const mockFetch: typeof fetch = async (input, init) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "healthy", podId: config.id }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/mcp") {
      const req = new Request(urlStr, init);
      return handleMcpRequest(req, {}, config);
    }

    return new Response("Not Found", { status: 404 });
  };

  const connector = createPodConnector({
    baseUrl: "https://starter-pod.local",
    fetchFn: mockFetch,
  });

  // 1. Health
  const health = await connector.health();
  assert.equal(health.status, "healthy");

  // 2. Discover
  const discovery = await connector.discover();
  assert.equal(discovery.tools.length, 5);

  // 3. List tools
  const tools = await connector.listTools();
  assert.equal(tools.length, 5);

  // 4. Submit task
  const sub = await connector.submitTask({
    repo: "factory-pods",
    issue: 12,
    requestId: "req-starter-test",
    title: "Test Task",
  });
  assert.ok(sub.taskId);
  assert.equal(sub.phase, "running");

  // 5. Task status
  const status = await connector.taskStatus({ taskId: sub.taskId });
  assert.equal(status.taskId, sub.taskId);

  // 6. Approve
  const app = await connector.approve({ taskId: sub.taskId, decision: "approve" });
  assert.equal(app.ok, true);

  // 7. Cancel
  const cancel = await connector.cancel({ taskId: sub.taskId });
  assert.equal(cancel.ok, true);
  assert.equal(cancel.status, "aborted");

  // 8. Get receipt
  const receipt = await connector.getReceipt({ taskId: sub.taskId });
  assert.equal(receipt.taskId, sub.taskId);
  assert.ok(receipt.checks.length > 0);
});
