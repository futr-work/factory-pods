// @futr-work/pod-kernel: Pre-Action Policy Gate
// Evaluates tool actions, external mutations, and API calls before execution
// Pure, deterministic, zero-dependency policy engine runnable in edge V8 isolates

export type RuleBehaviour = "allow" | "pre_approved" | "ask" | "hand_off";

export const RULE_BEHAVIOURS: readonly RuleBehaviour[] = [
  "allow",
  "pre_approved",
  "ask",
  "hand_off",
] as const;

export const BEHAVIOUR_RANK: Record<RuleBehaviour, number> = {
  allow: 0,
  pre_approved: 1,
  ask: 2,
  hand_off: 3,
};

export interface ApprovalCandidate {
  botId: string;
  toolRef: string;
  effect: string; // "read" | "write" | "delete" | "execute" | "network" | custom
  scope: string;  // "internal" | "external" | "filesystem" | "billing" | custom
  params?: Record<string, any>;
}

export interface PolicyRule {
  id: string;
  botId: string;       // Glob pattern e.g. "pod:*" or "pod:governor"
  toolRef: string;     // Glob pattern e.g. "mcp__*" or "exec:*" or "fetch:*"
  effect: string;      // Glob pattern e.g. "write" or "*"
  scope: string;       // Glob pattern e.g. "billing" or "*"
  behaviour: RuleBehaviour;
  reason?: string;
}

export interface PolicyEvaluationResult {
  decision: RuleBehaviour;
  matchedRule?: PolicyRule;
  reason: string;
  requiresHumanInterrupt: boolean;
  proceedAutomatically: boolean;
}

/** Matches a glob pattern against a target string. `*` matches any sequence of characters. */
export function globMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern === value) return true;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "s").test(value);
}

/** Determines if a specific policy rule applies to the candidate action. */
export function ruleMatches(rule: PolicyRule, candidate: ApprovalCandidate): boolean {
  return (
    globMatches(rule.botId, candidate.botId) &&
    globMatches(rule.toolRef, candidate.toolRef) &&
    globMatches(rule.effect, candidate.effect) &&
    globMatches(rule.scope, candidate.scope)
  );
}

/** Selects the strictest matching rule for a candidate action based on rank. */
export function strictestRule(
  candidate: ApprovalCandidate,
  rules: readonly PolicyRule[],
): PolicyRule | undefined {
  let highest: PolicyRule | undefined;
  for (const rule of rules) {
    if (ruleMatches(rule, candidate)) {
      if (!highest || BEHAVIOUR_RANK[rule.behaviour] > BEHAVIOUR_RANK[highest.behaviour]) {
        highest = rule;
      }
    }
  }
  return highest;
}

/**
 * Evaluates a candidate tool action against an active rule set.
 * Returns the final decision and whether an AG-UI human interrupt is required.
 */
export function evaluatePolicy(
  candidate: ApprovalCandidate,
  rules: readonly PolicyRule[],
  defaultBehaviour: RuleBehaviour = "ask",
): PolicyEvaluationResult {
  const matched = strictestRule(candidate, rules);
  const decision = matched ? matched.behaviour : defaultBehaviour;

  const requiresHumanInterrupt = decision === "ask" || decision === "hand_off";
  const proceedAutomatically = decision === "allow" || decision === "pre_approved";

  let reason = matched?.reason;
  if (!reason) {
    if (matched) {
      reason = `Matched policy rule '${matched.id}' (${matched.behaviour}) for tool '${candidate.toolRef}'`;
    } else {
      reason = `Default policy applies: ${defaultBehaviour} for tool '${candidate.toolRef}'`;
    }
  }

  return {
    decision,
    matchedRule: matched,
    reason,
    requiresHumanInterrupt,
    proceedAutomatically,
  };
}
