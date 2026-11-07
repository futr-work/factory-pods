// @futr-work/pod-kernel: Canonical types and contracts

export type TaskPhase =
  | "fetch"
  | "worktree"
  | "build"
  | "verify"
  | "await_approval"
  | "publish"
  | "terminal";

export type ApprovalDecision = "approve" | "reject" | "pending";

export interface PodReceipt {
  taskId: string | number;
  pr: string;
  commit: string;
  checks: string[];
  diffHash: string;
  model: string;
  provider: string;
  family: string;
  runtime: string;
  durationMs?: number;
  usage?: Record<string, any> | "unknown";
}

export interface PodManifest {
  pod: {
    name: string;
    role: string;
    version: string;
    port?: number;
  };
  capabilities: {
    tasks: string[];
    interface: string;
  };
  triggers?: {
    events: string[];
  };
  harness: {
    runtime: string;
    engine: string;
    model: string;
    approval: "file" | "github" | "mcp";
    publish: "local" | "github";
  };
  repos: {
    allowed: string[];
  };
  tools: {
    mcp: string[];
  };
}

export interface GateSpec {
  verify: Array<string | string[]>;
  install?: Array<string | string[]>;
}

export interface GateResult {
  ok: boolean;
  checks: string[];
  diffHash: string;
  error?: string;
}

export interface HarnessExecutionOptions {
  cwd: string;
  title: string;
  body: string;
  model?: string;
  provider?: string;
  timeoutMs?: number;
}

export interface HarnessResult {
  exitCode: number;
  lastMessage?: string;
  usage?: Record<string, any> | "unknown";
  error?: string;
}
