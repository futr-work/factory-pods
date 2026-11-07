import test from "node:test";
import assert from "node:assert/strict";
import { OrreryConnector } from "../src/orrery-connector.js";

test("OrreryConnector falls back gracefully when service is offline", async () => {
  const connector = new OrreryConnector({ ORRERY_URL: "http://127.0.0.1:9999" });
  const result = await connector.auditDomain("https://clinic.example.com");

  assert.equal(result.status, "fallback_edge_mode");
  assert.equal(result.url, "https://clinic.example.com");
  assert.equal(result.summary.hasSchema, false);
  assert.ok(result.findings.length > 0);
});

test("OrreryConnector parses response from service binding or mock fetch", async () => {
  const mockFetch = async () => {
    return new Response(
      JSON.stringify({
        url: "https://clinic.example.com/",
        status: "completed",
        pages_crawled: 5,
        pages: [
          { url: "https://clinic.example.com/", schema_types: [] },
          { url: "https://clinic.example.com/glp-1", schema_types: [] },
        ],
        findings: [
          { severity: "low", issue_type: "images-missing-alt", title: "Images missing alt text" },
        ],
        summary: {
          total_pages: 5,
          total_findings: 1,
          schema_types_found: [],
          has_schema: false,
          has_robots_txt: true,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const connector = new OrreryConnector({
    ORRERY: { fetch: mockFetch as any },
    FACTORY_HUB_TOKEN: "mock-token",
  });

  const result = await connector.auditDomain("https://clinic.example.com/");
  assert.equal(result.status, "completed");
  assert.equal(result.pagesCrawled, 5);
  assert.equal(result.summary.hasSchema, false);
  assert.equal(result.findings[0].issue_type, "images-missing-alt");
});
