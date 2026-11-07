import test from "node:test";
import assert from "node:assert/strict";
import { handleMcpRequest, MCP_V2_PROTOCOL_VERSION } from "../src/mcp.js";
import { loadPodConfig } from "../src/config.js";

test("MCP v2 server discovery endpoint (GET /mcp)", async () => {
  const config = loadPodConfig();
  const req = new Request("https://authority-seo-pod.local/mcp", { method: "GET" });
  const res = await handleMcpRequest(req, {}, config);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Mcp-Version"), MCP_V2_PROTOCOL_VERSION);
  const data = (await res.json()) as any;
  assert.equal(data.mcpVersion, MCP_V2_PROTOCOL_VERSION);
  assert.equal(data.server.version, "2.0.0");
  assert.ok(data.capabilities.tasks);
  assert.ok(data.capabilities.tools);
  assert.ok(data.capabilities.resources);
  assert.ok(data.tools.some((t: any) => t.name === "audit_site"));
  assert.ok(data.resources.some((r: any) => r.uri.includes("Example Clinic")));
});

test("MCP v2 JSON-RPC initialize", async () => {
  const config = loadPodConfig();
  const req = new Request("https://authority-seo-pod.local/mcp", {
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
  assert.equal(data.result.protocolVersion, MCP_V2_PROTOCOL_VERSION);
  assert.equal(data.result.serverInfo.version, "2.0.0");
  assert.ok(data.result.capabilities.tasks);
});

test("MCP v2 JSON-RPC batch execution", async () => {
  const config = loadPodConfig();
  const req = new Request("https://authority-seo-pod.local/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: "batch-1", method: "tools/list" },
      { jsonrpc: "2.0", id: "batch-2", method: "resources/list" },
    ]),
  });

  const res = await handleMcpRequest(req, {}, config);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any[];
  assert.equal(data.length, 2);
  assert.equal(data[0].id, "batch-1");
  assert.ok(data[0].result.tools.length >= 4);
  assert.equal(data[1].id, "batch-2");
  assert.ok(data[1].result.resources.length >= 2);
});

test("MCP v2 Resources Extension (resources/read)", async () => {
  const config = loadPodConfig();
  const req = new Request("https://authority-seo-pod.local/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "res-1",
      method: "resources/read",
      params: { uri: "seo://Example Clinic/robots.txt" },
    }),
  });

  const res = await handleMcpRequest(req, {}, config);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.ok(data.result.contents[0].text.includes("clinic.example.com"));
  assert.ok(data.result.contents[0].text.includes("User-agent: PerplexityBot"));
});

test("MCP v2 Tasks Extension (tasks/list)", async () => {
  const config = loadPodConfig();
  const mockDb = {
    prepare: () => ({
      bind: () => ({
        all: async () => ({
          results: [{ task_id: "task_1", topic: "seo.audit", status: "completed" }],
        }),
      }),
    }),
  };

  const req = new Request("https://authority-seo-pod.local/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "tasks-1",
      method: "tasks/list",
    }),
  });

  const res = await handleMcpRequest(req, { DB: mockDb }, config);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.result.tasks.length, 1);
  assert.equal(data.result.tasks[0].task_id, "task_1");
});

test("MCP JSON-RPC tools/call generate_sample_fixpack", async () => {
  const config = loadPodConfig();
  const req = new Request("https://authority-seo-pod.local/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "generate_sample_fixpack",
        arguments: {},
      },
    }),
  });

  const res = await handleMcpRequest(req, {}, config);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  const content = JSON.parse(data.result.content[0].text);
  assert.ok(content.robotsTxt.includes("clinic.example.com"));
  assert.equal(content.schemaOrgJsonLd["@type"], "MedicalBusiness");
  assert.equal(content.schemaOrgJsonLd.name, "Example Clinic");
  assert.ok(content.onPageRecommendations.home);
  assert.ok(content.onPageRecommendations.glp1);
});

test("MCP JSON-RPC tools/call submit_indexnow", async () => {
  const config = loadPodConfig();
  const req = new Request("https://authority-seo-pod.local/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "submit_indexnow",
        arguments: {
          domain: "clinic.example.com",
          urls: ["https://clinic.example.com/", "https://clinic.example.com/glp-1"],
        },
      },
    }),
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 202 })) as typeof fetch;
  let res: Response;
  try {
    res = await handleMcpRequest(req, {}, config);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  const content = JSON.parse(data.result.content[0].text);
  assert.equal(content.host, "clinic.example.com");
  assert.equal(content.submitted, 2);
  assert.equal(content.status, 202);
});
