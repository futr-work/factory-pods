import test from "node:test";
import assert from "node:assert/strict";
import {
  validateHandoff,
  formatRefusal,
  type PodHandoffEnvelope,
} from "../src/handoff.js";

test("Pod Handoff Suite - Envelope Validation", () => {
  // Valid envelope
  const validPayload: PodHandoffEnvelope = {
    task: "audit-rate-limits",
    constraints: "timeoutMs: 2000, maxCalls: 3",
    expecting: "Structured JSON report of rate-limited endpoints",
    context: { provider: "anthropic" },
  };

  const res1 = validateHandoff(validPayload);
  assert.equal(res1.valid, true);
  assert.equal(res1.errors.length, 0);
  assert.equal(res1.handoff?.task, "audit-rate-limits");

  // Invalid: missing task
  const res2 = validateHandoff({ constraints: "none" });
  assert.equal(res2.valid, false);
  assert.match(res2.errors[0], /Missing required string field 'task'/);

  // Invalid: non-object
  const res3 = validateHandoff("do this task");
  assert.equal(res3.valid, false);
});

test("Pod Handoff Suite - Refusal Formatting", () => {
  const refusal = formatRefusal("Model rate limit exceeded on Claude 3.5 Sonnet", {
    code: "QUOTA_EXHAUSTED",
    remediation: "Failover to GPT-4o-mini recommended",
    details: { retryAfterSeconds: 45 },
  });

  assert.equal(refusal.ok, false);
  assert.equal(refusal.refusal, true);
  assert.equal(refusal.code, "QUOTA_EXHAUSTED");
  assert.match(refusal.reason, /rate limit exceeded/);
  assert.equal(refusal.remediation, "Failover to GPT-4o-mini recommended");
  assert.ok(refusal.timestamp > 0);
  assert.equal(refusal.details?.retryAfterSeconds, 45);
});
