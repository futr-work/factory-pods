import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadPodConfig } from "../src/config.js";
import { DefaultPodHandler } from "../src/handler.js";
import { renderPodUiHtml } from "../src/ui.js";
import { TaskRecord } from "../src/types.js";

describe("Factory Pod Template Test Suite", () => {
  test("1. loadPodConfig applies defaults and environment overrides", () => {
    const config = loadPodConfig({
      POD_ID: "authority-seo-pod",
      POD_NAME: "Authority SEO Pod",
      POD_ROLE: "seo",
      POD_LOB: "authority-network",
      POD_CAPABILITIES: "keyword_clustering,schema_org",
    });

    assert.equal(config.id, "authority-seo-pod");
    assert.equal(config.name, "Authority SEO Pod");
    assert.equal(config.role, "seo");
    assert.equal(config.lob, "authority-network");
    assert.deepEqual(config.capabilities, ["keyword_clustering", "schema_org"]);
  });

  test("2. DefaultPodHandler executes task and reports progress", async () => {
    const handler = new DefaultPodHandler();
    const config = loadPodConfig();
    let publishedTopic = "";

    const task: TaskRecord = {
      id: 1,
      taskId: "task_test_101",
      topic: "seo.audit",
      source: "unit-test",
      spec: { domain: "landscaping.example.com" },
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const res = await handler.handle(task, {
      podConfig: config,
      now: Date.now(),
      publishEvent: async (topic, toPod, payload) => {
        publishedTopic = topic;
      },
    });

    assert.equal(res.taskId, "task_test_101");
    assert.equal(res.role, config.role);
    assert.equal(publishedTopic, "task.completed");
  });

  test("3. renderPodUiHtml produces valid cockpit markup", () => {
    const config = loadPodConfig();
    const html = renderPodUiHtml(config, []);

    assert.equal(html.includes("Factory Pod Cockpit"), true);
    assert.equal(html.includes("LOB:"), true);
    assert.equal(html.includes("Task Execution Ledger"), true);
  });

  test("4. AuthoritySeoPodHandler generates 2026 AI crawler governance robots.txt", () => {
    const handler = new DefaultPodHandler();
    const res = handler.generateRobotsTxt({ domain: "loans.example.com", allowAiSearch: true, allowAiTraining: false });

    assert.equal(res.robotsTxt.includes("User-agent: PerplexityBot"), true);
    assert.equal(res.robotsTxt.includes("User-agent: OAI-SearchBot"), true);
    assert.equal(res.robotsTxt.includes("User-agent: GPTBot\nUser-agent: CCBot\nUser-agent: Bytespider"), true);
    assert.equal(res.robotsTxt.includes("Sitemap: https://loans.example.com/sitemap.xml"), true);
  });

  test("5. AuthoritySeoPodHandler generates schema.org JSON-LD", () => {
    const handler = new DefaultPodHandler();
    const schema = handler.generateSchemaJsonLd({
      type: "Organization",
      domain: "capital.example.com",
      name: "Example Capital Partners",
      description: "Direct middle-market private lending.",
      url: "https://capital.example.com",
    });

    assert.equal(schema["@context"], "https://schema.org");
    assert.equal(schema["@type"], "Organization");
    assert.equal(schema.name, "Example Capital Partners");
  });

  test("6. AuthoritySeoPodHandler audits and optimizes meta tags", () => {
    const handler = new DefaultPodHandler();
    const meta = handler.auditAndOptimizeMeta({
      title: "Commercial Equipment Financing & Bridge Loans | Example Capital",
      description: "Example Capital provides flexible commercial equipment financing and quick bridge loans with transparent terms for growing enterprises.",
      targetKeyword: "Commercial Equipment Financing",
      url: "https://capital.example.com/equipment-financing",
    });

    assert.equal(meta.title.hasKeyword, true);
    assert.equal(meta.title.optimalLength, true);
    assert.equal(meta.description.hasKeyword, true);
    assert.equal(meta.score, 100);
  });

  test("7. AuthoritySeoPodHandler executes submitIndexNow via handler", async () => {
    const handler = new DefaultPodHandler();
    const task: TaskRecord = {
      id: 2,
      taskId: "task_indexnow_01",
      topic: "seo.submit_indexnow",
      source: "cron",
      spec: {
        domain: "clinic.example.com",
        urls: ["https://clinic.example.com/guides/glp-1-care-cycle"],
      },
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const sent: { url: string; body: { urlList: string[] } }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response("", { status: 200 });
    }) as typeof fetch;
    let res;
    try {
      res = await handler.handle(task, {
        podConfig: loadPodConfig(),
        now: Date.now(),
        publishEvent: async () => {},
        env: { INDEXNOW_KEY: "e3b0c44298fc1c149afbf4c8996fb924" },
      });
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.equal(res.result.host, "clinic.example.com");
    assert.equal(res.result.submitted, 1);
    assert.equal(res.result.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://api.indexnow.org/IndexNow");
    assert.deepEqual(sent[0].body.urlList, ["https://clinic.example.com/guides/glp-1-care-cycle"]);
  });

  test("8. AuthoritySeoPodHandler executes searchGoogleSerp with env api key", async () => {
    const handler = new DefaultPodHandler();
    const task: TaskRecord = {
      id: 3,
      taskId: "task_serp_01",
      topic: "seo.google_serp",
      source: "test",
      spec: { query: "online glp-1 prescription" },
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Fails closed if no key is supplied
    await assert.rejects(
      () => handler.handle(task, { podConfig: loadPodConfig(), now: Date.now(), publishEvent: async () => {} }),
      /SERPER_API_KEY is required/
    );
  });
});
