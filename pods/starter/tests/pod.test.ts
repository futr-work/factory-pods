import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadPodConfig } from "../src/config.js";
import { DefaultPodHandler, activeHandler } from "../src/handler.js";
import worker from "../src/worker.js";
import { isPodStorage, POD_STORAGE_BRAND } from "@futr-work/pod-kernel/storage";
import { DynamicSkillEngine } from "../src/skill-engine.js";
import { renderPodUiHtml } from "../src/ui.js";
import { TaskRecord, boundPayload, EpisodeRecord, BeliefRecord } from "../src/types.js";
import { runSleepConsolidation } from "../src/consolidation.js";

describe("Autonomous Worker Pod Chassis Test Suite", () => {
  test("1. loadPodConfig applies defaults and environment overrides", () => {
    const config = loadPodConfig({
      POD_ID: "sample-worker-pod",
      POD_NAME: "Sample Worker Pod",
      POD_ROLE: "worker",
      POD_DOMAIN: "telemetry",
      POD_CAPABILITIES: "data_processing,stream_filtering",
    });

    assert.equal(config.id, "sample-worker-pod");
    assert.equal(config.name, "Sample Worker Pod");
    assert.equal(config.role, "worker");
    assert.equal(config.lob, "telemetry");
    assert.deepEqual(config.capabilities, ["data_processing", "stream_filtering"]);
  });

  test("2. DefaultPodHandler executes task, generates receipts, and records episodes", async () => {
    const handler = new DefaultPodHandler();
    const config = loadPodConfig();
    let publishedTopic = "";
    let recordedEpisode: any = null;

    const task: TaskRecord = {
      id: 1,
      taskId: "task_test_101",
      topic: "data.process",
      source: "unit-test",
      spec: { recordId: "rec_101" },
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const res = await handler.handle(task, {
      podConfig: config,
      now: Date.now(),
      recordEpisode: async (ep) => {
        recordedEpisode = ep;
      },
      publishEvent: async (topic, toPod, payload) => {
        publishedTopic = topic;
      },
    });

    assert.equal(res.taskId, "task_test_101");
    assert.equal(res.role, config.role);
    assert.equal(publishedTopic, "task.completed");
    assert.ok(res.evidence.receiptHash, "Receipt hash must be present");
    assert.equal(typeof res.confidence, "number");
    assert.ok(recordedEpisode, "Episode must be recorded for continuous learning");
    assert.equal(recordedEpisode.taskId, "task_test_101");
  });

  test("3. DynamicSkillEngine respects TTL and handles custom hub URLs", async () => {
    let fetchCount = 0;
    const mockFetcher = async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          skill: {
            id: "seo.robots_txt_probe",
            name: "Robots Probe",
            domain: "seo",
            version: "1.0.0",
            executionType: "rule_engine",
            instructions: "Audit robots",
            specSchema: {},
            description: "Probe",
          },
        }),
        { status: 200 }
      );
    };

    // Instantiate with short TTL of 50ms
    const engine = new DynamicSkillEngine("https://custom-hub.example.com", mockFetcher as any, 50);
    const skill1 = await engine.getSkill("seo.robots_txt_probe");
    assert.equal(fetchCount, 1);
    assert.equal(skill1?.name, "Robots Probe");

    // Second call within TTL should hit cache
    const skillCached = await engine.getSkill("seo.robots_txt_probe");
    assert.equal(fetchCount, 1, "Cache must prevent duplicate network call");

    // Wait for TTL expiration
    await new Promise((resolve) => setTimeout(resolve, 60));
    const skillRefreshed = await engine.getSkill("seo.robots_txt_probe");
    assert.equal(fetchCount, 2, "Expired TTL must re-fetch fresh version from hub");
  });

  test("4. DynamicSkillEngine executes rule_engine probes deterministically", async () => {
    const engine = new DynamicSkillEngine();
    engine.registerLocalSkill({
      id: "seo.robots_txt_probe",
      name: "Robots Probe",
      domain: "seo",
      version: "1.0.0",
      description: "Audits AI crawlers",
      specSchema: {},
      executionType: "rule_engine",
      instructions: "Check bots",
    });

    const skill = await engine.getSkill("seo.robots_txt_probe");
    assert.ok(skill);

    const result = await engine.execute(skill, {
      robotsTxtContent: "User-agent: GPTBot\nDisallow: /\nUser-agent: ClaudeBot\nDisallow:",
    });

    assert.equal(result.botStatus.GPTBot, "blocked");
    assert.equal(result.botStatus.ClaudeBot, "allowed");
    assert.equal(result.score, 75);
    assert.equal(result.confidence, 1.0);
  });

  test("5. boundPayload enforces byte bounds without corrupting small payloads", () => {
    const small = { key: "value", num: 123 };
    const boundedSmall = boundPayload(small, 1024);
    assert.deepEqual(boundedSmall, small);

    // Large payload exceeding 100 bytes
    const large = { text: "x".repeat(500) };
    const boundedLarge = boundPayload(large, 100);
    assert.equal((boundedLarge as any)._truncated, true);
    assert.ok((boundedLarge as any)._originalByteSize > 500);
  });

  test("6. Confidence < 0.8 triggers verification escalation", async () => {
    const handler = new DefaultPodHandler();
    const config = loadPodConfig();
    let publishedTopic = "";

    const task: TaskRecord = {
      id: 2,
      taskId: "task_low_conf_99",
      topic: "unclear.domain",
      source: "unit-test",
      spec: { requireVerification: true },
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await handler.handle(task, {
      podConfig: config,
      now: Date.now(),
      publishEvent: async (topic) => {
        publishedTopic = topic;
      },
    });

    assert.equal(publishedTopic, "task.verification_requested");
  });

  test("7. renderPodUiHtml produces valid cockpit markup", () => {
    const config = loadPodConfig();
    const html = renderPodUiHtml(config, []);

    assert.equal(html.includes("Worker Pod Cockpit"), true);
    assert.equal(html.includes("DOMAIN:"), true);
    assert.equal(html.includes("Task Execution Ledger"), true);
  });

  test("8. DynamicSkillEngine.executeWithAi constructs few-shot prompt with recalled episodes", async () => {
    const engine = new DynamicSkillEngine();
    let capturedPrompt = "";

    const mockAi = async (model: string, input: any) => {
      capturedPrompt = input.messages[1].content;
      return { response: "Generated synthetic article" };
    };

    const promptSkill = {
      id: "content.generator",
      name: "Article Generator",
      domain: "content",
      version: "1.0.0",
      description: "Writes articles",
      specSchema: {},
      executionType: "prompt_template" as const,
      instructions: "Generate 500 words on topic",
    };

    const episodes: EpisodeRecord[] = [
      {
        id: 1,
        taskId: "task_prev_1",
        topic: "content.generator",
        specSummary: "Topic: SEO guide",
        actionTaken: "Generated guide",
        outcome: "Success",
        confidence: 0.98,
        latencyMs: 120,
        createdAt: Date.now() - 1000,
      },
    ];

    const result = await engine.executeWithAi(promptSkill, { keyword: "medicare" }, {
      ai: mockAi,
      recalledEpisodes: episodes,
    });

    assert.ok(capturedPrompt.includes("Example Task: task_prev_1"), "Recalled episode must appear in prompt");
    assert.ok(capturedPrompt.includes("medicare"), "Spec must appear in prompt");
    assert.equal(result.confidence, 0.95);
    assert.equal(result.episodesUsed, 1);
  });

  test("9. DynamicSkillEngine.executeWithAi injects operational beliefs into prompt context", async () => {
    const engine = new DynamicSkillEngine();
    let capturedPrompt = "";

    const mockAi = async (model: string, input: any) => {
      capturedPrompt = input.messages[1].content;
      return { response: "Audit successful" };
    };

    const promptSkill = {
      id: "seo.audit",
      name: "SEO Auditor",
      domain: "seo",
      version: "1.0.0",
      description: "Audits pages",
      specSchema: {},
      executionType: "prompt_template" as const,
      instructions: "Audit the domain",
    };

    const beliefs: BeliefRecord[] = [
      {
        id: "belief_seo_robots",
        domain: "seo",
        claim: "Robots.txt wildcards override specific user-agent blocks",
        confidence: 0.98,
        evidenceCount: 14,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 5000,
      },
    ];

    const result = await engine.executeWithAi(promptSkill, { domain: "example.com" }, {
      ai: mockAi,
      beliefs,
    });

    assert.ok(capturedPrompt.includes("Operational Beliefs & Domain Principles"), "Beliefs header must appear in prompt");
    assert.ok(capturedPrompt.includes("Robots.txt wildcards override"), "Belief claim must be present");
    assert.equal(result.beliefsUsed, 1);
  });

  test("10. runSleepConsolidation decays stale beliefs and synthesizes new principles from clustered episodes", async () => {
    const now = 1793650000000;
    const memoryDb: any[] = [];
    const beliefsDb = new Map<string, any>();

    // Seed mock DB adapter
    const mockDb = {
      prepare(query: string) {
        return {
          bind(...args: any[]) {
            return {
              all: async () => {
                if (query.includes("FROM episodes")) {
                  const windowStart = args[0];
                  return { results: memoryDb.filter((e) => e.created_at >= windowStart) };
                }
                return { results: [] };
              },
              run: async () => {
                if (query.includes("DELETE FROM beliefs")) {
                  const expireThreshold = args[0];
                  let changes = 0;
                  for (const [id, b] of beliefsDb.entries()) {
                    if (b.expires_at && b.expires_at < expireThreshold) {
                      beliefsDb.delete(id);
                      changes++;
                    }
                  }
                  return { meta: { changes } };
                }
                if (query.includes("INSERT INTO beliefs")) {
                  const [id, domain, claim, confidence, evidenceCount, sourceEpisodes, expiresAt] = args;
                  beliefsDb.set(id, { id, domain, claim, confidence, evidenceCount, expiresAt });
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    };

    // 1. Seed an expired belief
    beliefsDb.set("old_stale_belief", {
      id: "old_stale_belief",
      domain: "seo",
      claim: "Old deprecated crawler directive",
      expires_at: now - 1000,
    });

    // 2. Seed 3 successful episodes for topic 'seo.robots_probe'
    for (let i = 1; i <= 3; i++) {
      memoryDb.push({
        id: i,
        task_id: `task_ep_${i}`,
        topic: "seo.robots_probe",
        spec_summary: "Probe robots",
        action_taken: "Evaluated bot status",
        outcome: "Clean pass",
        confidence: 0.95,
        latency_ms: 50,
        created_at: now - 10000,
      });
    }

    const summary = await runSleepConsolidation(mockDb as any, "seo", now);

    assert.equal(summary.beliefsDecayed, 1, "Stale belief must be pruned");
    assert.equal(summary.beliefsSynthesized, 1, "Clustered episodes must synthesize 1 new belief");
    assert.equal(summary.episodesAnalyzed, 3);
    assert.ok(beliefsDb.has("belief_seo_seo_robots_probe"));
  });

  test("11. HTTP POST /api/task composes unbranded D1 into branded PodStorage on HandlerContext.storage", async () => {
    const tasks: Record<string, any> = {};
    const mockD1 = {
      prepare(sql: string) {
        let boundParams: unknown[] = [];
        const stmt = {
          bind(...params: unknown[]) {
            boundParams = params;
            return stmt;
          },
          async first<T = unknown>(_colName?: string): Promise<T | null> {
            return null;
          },
          async all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: any }> {
            return { results: [], success: true, meta: { changes: 0 } };
          },
          async run(): Promise<{ success: boolean; meta: any }> {
            if (sql.includes("INSERT INTO tasks")) {
              tasks[boundParams[0] as string] = {
                taskId: boundParams[0],
                topic: boundParams[1],
                status: "running",
              };
            }
            if (sql.includes("UPDATE tasks SET status = 'completed'")) {
              const taskId = boundParams[2] as string;
              if (tasks[taskId]) tasks[taskId].status = "completed";
            }
            return { success: true, meta: { changes: 1, last_row_id: 1 } };
          },
        };
        return stmt;
      },
      async batch() {
        return [];
      },
    };

    assert.equal(isPodStorage(mockD1), false, "Raw mockD1 must be unbranded");
    assert.equal((mockD1 as any)[POD_STORAGE_BRAND], undefined);

    const env = {
      DB: mockD1,
      FACTORY_HUB_TOKEN: "test-token",
    };

    let observedContextStorage: unknown = null;
    let observedContextDb: unknown = null;
    const origHandle = activeHandler.handle;
    activeHandler.handle = async (t, ctx) => {
      observedContextStorage = ctx.storage;
      observedContextDb = ctx.db;
      return origHandle.call(activeHandler, t, ctx);
    };

    try {
      const req = new Request("https://starter-pod.local/api/task", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-token",
        },
        body: JSON.stringify({
          taskId: "task_starter_01",
          topic: "demo.task",
          spec: { foo: "bar" },
        }),
      });

      const res = await worker.fetch(req, env as any);
      assert.equal(res.status, 200);

      assert.ok(observedContextStorage !== null, "Handler must have been called with storage");
      assert.notEqual(observedContextStorage, mockD1, "Storage must not be raw unbranded D1");
      assert.equal(isPodStorage(observedContextStorage), true, "Storage must be branded PodStorage");
      assert.equal((observedContextStorage as any)[POD_STORAGE_BRAND], true);
      assert.equal(observedContextDb, observedContextStorage, "ctx.db must alias ctx.storage");
      assert.equal(tasks["task_starter_01"]?.status, "completed");
    } finally {
      activeHandler.handle = origHandle;
    }
  });

  test("12. Scheduled cron polling composes unbranded D1 into branded PodStorage on HandlerContext.storage", async () => {
    const mockD1 = {
      prepare(_sql: string) {
        const stmt = {
          bind(..._params: unknown[]) {
            return stmt;
          },
          async first<T = unknown>(_colName?: string): Promise<T | null> {
            return null;
          },
          async all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: any }> {
            return { results: [], success: true, meta: { changes: 0 } };
          },
          async run(): Promise<{ success: boolean; meta: any }> {
            return { success: true, meta: { changes: 1, last_row_id: 1 } };
          },
        };
        return stmt;
      },
      async batch() {
        return [];
      },
    };

    const mockHubBinding = {
      fetch: async (input: RequestInfo | URL) => {
        const urlStr = typeof input === "string" ? input : (input as Request).url;
        if (urlStr.includes("/api/tincan/messages")) {
          return new Response(JSON.stringify({
            messages: [
              {
                id: "msg_starter_cron_01",
                topic: "task.assigned",
                payload: {
                  taskId: "task_starter_cron_01",
                  spec: { action: "ping" },
                },
              },
            ],
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    };

    const env = {
      DB: mockD1,
      FACTORY_HUB: mockHubBinding,
      FACTORY_HUB_TOKEN: "test-token",
    };

    let observedContextStorage: unknown = null;
    const origHandle = activeHandler.handle;
    activeHandler.handle = async (t, ctx) => {
      observedContextStorage = ctx.storage;
      return origHandle.call(activeHandler, t, ctx);
    };

    try {
      await worker.scheduled({}, env as any);

      assert.ok(observedContextStorage !== null, "Scheduled handler must be called with storage");
      assert.notEqual(observedContextStorage, mockD1, "Storage must not be raw unbranded D1");
      assert.equal(isPodStorage(observedContextStorage), true, "Storage must be branded PodStorage");
      assert.equal((observedContextStorage as any)[POD_STORAGE_BRAND], true);
    } finally {
      activeHandler.handle = origHandle;
    }
  });
});
