import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DynamicSkillEngine, DynamicSkillPackage } from "../src/skill-engine.js";

describe("Dynamic Skill Engine & Hot-Plugging Test Suite", () => {
  test("1. Executes rule_engine skill dynamically without compiled code", () => {
    const engine = new DynamicSkillEngine("http://localhost:5000");

    const robotsSkill: DynamicSkillPackage = {
      id: "seo.robots_txt_probe",
      name: "AI Crawler Governance",
      domain: "seo",
      version: "1.0.0",
      description: "Test rule",
      executionType: "rule_engine",
      specSchema: {},
      instructions: "Evaluate bot directives",
    };

    engine.registerLocalSkill(robotsSkill);

    const result = engine.execute(robotsSkill, {
      robotsTxtContent: `
User-agent: GPTBot
Disallow: /

User-agent: PerplexityBot
Disallow:

User-agent: *
Disallow:
      `,
    });

    assert.equal(result.skillId, "seo.robots_txt_probe");
    assert.equal(result.botStatus.GPTBot, "blocked");
    assert.equal(result.botStatus.PerplexityBot, "allowed");
    assert.equal(result.score, 75);
    assert.equal(result.aiSearchFriendly, true);
  });

  test("2. Executes security_txt rule engine and detects non-compliance", () => {
    const engine = new DynamicSkillEngine("http://localhost:5000");

    const secSkill: DynamicSkillPackage = {
      id: "security.security_txt_probe",
      name: "RFC 9116 Security.txt",
      domain: "security",
      version: "1.0.0",
      description: "Test security",
      executionType: "rule_engine",
      specSchema: {},
      instructions: "Check contact and expires",
    };

    // Test missing Contact:
    const invalidRes = engine.execute(secSkill, {
      securityTxtContent: "Expires: 2026-12-31T23:59:59Z",
    });
    assert.equal(invalidRes.isCompliant, false);
    assert.equal(invalidRes.score, 0);

    // Test valid Contact + Expires:
    const validRes = engine.execute(secSkill, {
      securityTxtContent: "Contact: security@example.com\nExpires: 2026-12-31T23:59:59Z",
    });
    assert.equal(validRes.isCompliant, true);
    assert.equal(validRes.score, 100);
  });

  test("3. Job Tracker: Detects stuck jobs, calculates uncollected revenue, and formats Telegram digest", () => {
    const engine = new DynamicSkillEngine("http://localhost:5000");

    const jobSkill: DynamicSkillPackage = {
      id: "job_tracker.stuck_jobs_probe",
      name: "Stuck Job Detector",
      domain: "operations",
      version: "1.0.0",
      description: "Checks TRACK sheet for overdue items",
      executionType: "rule_engine",
      specSchema: {},
      instructions: "Find stuck jobs",
    };

    engine.registerLocalSkill(jobSkill);

    const result = engine.execute(jobSkill, {
      jobs: [
        { id: "1", title: "HVAC Repair", customer: "Smith Family", status: "done", invoiced: false, daysWaiting: 3, amount: 850 },
        { id: "2", title: "Boiler Installation", customer: "Acme Corp", status: "quoted", daysWaiting: 5, amount: 4500 },
        { id: "3", title: "Emergency Callout", customer: "Miller Bakery", status: "invoiced", daysWaiting: 14, amount: 1200 },
        { id: "4", title: "Routine Check", customer: "Davis", status: "in_progress", daysWaiting: 1, amount: 300 },
      ],
      thresholds: {
        doneUninvoicedDays: 1,
        quoteUnansweredDays: 3,
        unpaidInvoiceDays: 7,
      },
    });

    assert.equal(result.skillId, "job_tracker.stuck_jobs_probe");
    assert.equal(result.stuckCount, 3);
    assert.equal(result.totalStuckRevenue, 6550);
    assert.equal(result.stuckJobs.length, 3);
    assert.ok(result.digestMessage.includes("Morning Pod Report:"));
    assert.ok(result.digestMessage.includes("Done but not invoiced:"));
    assert.ok(result.digestMessage.includes("Smith Family"));
    assert.ok(result.digestMessage.includes("Quotes with no reply:"));
    assert.ok(result.digestMessage.includes("Acme Corp"));
    assert.ok(result.digestMessage.includes("Unpaid invoices:"));
    assert.ok(result.digestMessage.includes("Miller Bakery"));
  });

  test("4. Model Governor: Automatically fails over to backup provider on HTTP 429", () => {
    const engine = new DynamicSkillEngine("http://localhost:5000");

    const govSkill: DynamicSkillPackage = {
      id: "model_governor.route_probe",
      name: "Model Governor Failover",
      domain: "ai",
      version: "1.0.0",
      description: "Routes requests with rate limit failover",
      executionType: "rule_engine",
      specSchema: {},
      instructions: "Route or failover",
    };

    engine.registerLocalSkill(govSkill);

    // When primary hits 429:
    const failoverResult = engine.execute(govSkill, {
      primary: "openai",
      fallback: "cerebras",
      providers: {
        openai: { status: 429, latencyMs: 250 },
        cerebras: { status: 200, latencyMs: 38 },
      },
    });

    assert.equal(failoverResult.selectedProvider, "cerebras");
    assert.equal(failoverResult.failedOver, true);
    assert.equal(failoverResult.reason, "primary_openai_status_429");

    // When primary is healthy:
    const healthyResult = engine.execute(govSkill, {
      primary: "openai",
      fallback: "cerebras",
      providers: {
        openai: { status: 200, latencyMs: 150 },
      },
    });

    assert.equal(healthyResult.selectedProvider, "openai");
    assert.equal(healthyResult.failedOver, false);
    assert.equal(healthyResult.reason, "primary_healthy");
  });

  test("5. Sentinel Radar: Validates webhook sizes and rejects oversized payloads", () => {
    const engine = new DynamicSkillEngine("http://localhost:5000");

    const sentinelSkill: DynamicSkillPackage = {
      id: "sentinel_radar.webhook_probe",
      name: "Webhook Bounds Sentinel",
      domain: "security",
      version: "1.0.0",
      description: "Validates incoming webhook payload bounds",
      executionType: "rule_engine",
      specSchema: {},
      instructions: "Check payload bounds",
    };

    engine.registerLocalSkill(sentinelSkill);

    // Normal payload with signature:
    const normalRes = engine.execute(sentinelSkill, {
      payloadBytes: 4096,
      signature: "sha256=abc123valid",
    });
    assert.equal(normalRes.accepted, true);
    assert.equal(normalRes.bounded, true);

    // Oversized payload (>100KB):
    const oversizedRes = engine.execute(sentinelSkill, {
      payloadBytes: 250 * 1024,
      signature: "sha256=abc123valid",
    });
    assert.equal(oversizedRes.accepted, false);
    assert.equal(oversizedRes.bounded, false);
  });
});
