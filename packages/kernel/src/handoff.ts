// @futr-work/pod-kernel: Structured Inter-Pod Handoff Envelope
// Governs delegation and communication between worker pods in the mesh
// Enforces typed fields over free text to eliminate silent multi-agent drift

export interface PodHandoffEnvelope {
  /** Explicit action or goal the receiving pod is asked to accomplish (verb + noun). */
  task: string;
  /** Operational boundaries: time budgets, quota limits, file paths, or forbidden actions. */
  constraints?: string;
  /** Exact shape and criteria of a successful output: schema, receipt, decision, or metric. */
  expecting?: string;
  /** Optional structured context metadata for execution. */
  context?: Record<string, any>;
}

export interface PodRefusal {
  ok: false;
  refusal: true;
  code: string;
  reason: string;
  remediation?: string;
  timestamp: number;
  details?: Record<string, any>;
}

export interface HandoffValidationResult {
  valid: boolean;
  errors: string[];
  handoff?: PodHandoffEnvelope;
}

/**
 * Validates a handoff envelope to ensure neither free-text drift nor missing targets occur.
 */
export function validateHandoff(envelope: unknown): HandoffValidationResult {
  const errors: string[] = [];

  if (!envelope || typeof envelope !== "object") {
    return { valid: false, errors: ["Handoff envelope must be an object"] };
  }

  const raw = envelope as Record<string, any>;

  if (typeof raw.task !== "string" || !raw.task.trim()) {
    errors.push("Missing required string field 'task'");
  }

  if (raw.constraints !== undefined && typeof raw.constraints !== "string") {
    errors.push("'constraints' must be a string if provided");
  }

  if (raw.expecting !== undefined && typeof raw.expecting !== "string") {
    errors.push("'expecting' must be a string if provided");
  }

  if (raw.context !== undefined && (typeof raw.context !== "object" || raw.context === null)) {
    errors.push("'context' must be a key-value object if provided");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    handoff: {
      task: raw.task.trim(),
      constraints: raw.constraints?.trim(),
      expecting: raw.expecting?.trim(),
      context: raw.context,
    },
  };
}

/**
 * Formats a refusal as a structured response rather than an unhandled error.
 * "Every refusal is an answer, not an error" — ensures calling pods receive conversational
 * explanations to gracefully adapt or escalate instead of crashing the run.
 */
export function formatRefusal(
  reason: string,
  options?: {
    code?: string;
    remediation?: string;
    details?: Record<string, any>;
  },
): PodRefusal {
  return {
    ok: false,
    refusal: true,
    code: options?.code || "POD_REFUSAL",
    reason,
    remediation: options?.remediation,
    timestamp: Date.now(),
    details: options?.details,
  };
}
