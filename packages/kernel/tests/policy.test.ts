import test from "node:test";
import assert from "node:assert/strict";
import {
  globMatches,
  ruleMatches,
  strictestRule,
  evaluatePolicy,
  type PolicyRule,
  type ApprovalCandidate,
} from "../src/policy.js";

test("Policy Gate Suite - Glob Matching", () => {
  assert.equal(globMatches("*", "anything"), true);
  assert.equal(globMatches("pod:*", "pod:model-governor"), true);
  assert.equal(globMatches("pod:*", "other:pod"), false);
  assert.equal(globMatches("mcp__*__audit", "mcp__seo__audit"), true);
  assert.equal(globMatches("mcp__*__audit", "mcp__seo__write"), false);
});

test("Policy Gate Suite - Rule Matching & Ranking Strictness", () => {
  const rules: PolicyRule[] = [
    {
      id: "rule-allow-all-reads",
      botId: "pod:*",
      toolRef: "*",
      effect: "read",
      scope: "*",
      behaviour: "allow",
      reason: "All read tools are safe",
    },
    {
      id: "rule-preapprove-dev-writes",
      botId: "pod:dev",
      toolRef: "git:*",
      effect: "write",
      scope: "internal",
      behaviour: "pre_approved",
      reason: "Git writes by dev pod are pre-approved",
    },
    {
      id: "rule-ask-on-billing",
      botId: "*",
      toolRef: "*",
      effect: "*",
      scope: "billing",
      behaviour: "ask",
      reason: "Any billing operation requires explicit human confirmation",
    },
    {
      id: "rule-handoff-secrets",
      botId: "*",
      toolRef: "*",
      effect: "*",
      scope: "credentials",
      behaviour: "hand_off",
      reason: "Credential manipulation must be handed off directly to human operator",
    },
  ];

  // 1. Safe read candidate
  const readCandidate: ApprovalCandidate = {
    botId: "pod:seo",
    toolRef: "mcp__radar__probe",
    effect: "read",
    scope: "internal",
  };
  const evalRead = evaluatePolicy(readCandidate, rules);
  assert.equal(evalRead.decision, "allow");
  assert.equal(evalRead.proceedAutomatically, true);
  assert.equal(evalRead.requiresHumanInterrupt, false);

  // 2. Billing candidate triggers 'ask'
  const billingCandidate: ApprovalCandidate = {
    botId: "pod:finance",
    toolRef: "stripe_charge",
    effect: "write",
    scope: "billing",
  };
  const evalBilling = evaluatePolicy(billingCandidate, rules);
  assert.equal(evalBilling.decision, "ask");
  assert.equal(evalBilling.requiresHumanInterrupt, true);
  assert.equal(evalBilling.proceedAutomatically, false);

  // 3. Strictest rule wins when overlapping (e.g. read on billing)
  const billingReadCandidate: ApprovalCandidate = {
    botId: "pod:finance",
    toolRef: "stripe_invoices",
    effect: "read",
    scope: "billing",
  };
  // 'rule-allow-all-reads' matches (allow, rank 0), 'rule-ask-on-billing' matches (ask, rank 2)
  // Strictness rank: ask (2) > allow (0)
  const evalBillingRead = evaluatePolicy(billingReadCandidate, rules);
  assert.equal(evalBillingRead.decision, "ask");
  assert.equal(evalBillingRead.matchedRule?.id, "rule-ask-on-billing");

  // 4. Credential access triggers 'hand_off' (highest strictness)
  const credCandidate: ApprovalCandidate = {
    botId: "pod:dev",
    toolRef: "vault_read_secret",
    effect: "read",
    scope: "credentials",
  };
  const evalCred = evaluatePolicy(credCandidate, rules);
  assert.equal(evalCred.decision, "hand_off");
  assert.equal(evalCred.matchedRule?.id, "rule-handoff-secrets");
  assert.equal(evalCred.requiresHumanInterrupt, true);
});
