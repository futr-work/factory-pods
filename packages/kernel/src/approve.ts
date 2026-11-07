// @futr-work/pod-kernel: Durable approval module
// Durable approval that survives restarts across file, GitHub, and MCP mechanisms

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalDecision } from "./types.js";

export function readApprovalState(
  taskId: string | number,
  options: {
    mode: "file" | "github" | "mcp";
    stateDir: string;
    repo?: string;
    issue?: number;
    trustedUsers?: string[];
  },
): ApprovalDecision {
  const { mode, stateDir, repo, issue } = options;
  // Only these GitHub logins can approve. Fail closed: no configured users means no GitHub approvals.
  const trustedUsers =
    options.trustedUsers ??
    (process.env.FACTORY_TRUSTED_USERS ?? "").split(",").map((u) => u.trim()).filter(Boolean);

  // File-based approval
  const f = join(stateDir, "approvals", `${taskId}.status.json`);
  if (existsSync(f)) {
    try {
      const parsed = JSON.parse(readFileSync(f, "utf8"));
      const v = parsed.status ?? parsed.decision;
      if (v === "approve" || v === "reject") return v;
    } catch {}
  }

  // GitHub comment approval
  if (mode === "github" && repo && issue) {
    try {
      const raw = execFileSync(
        "gh",
        ["issue", "view", String(issue), "--repo", repo, "--json", "comments"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const comments = JSON.parse(raw).comments ?? [];
      for (const c of comments) {
        if (!trustedUsers.includes(c.author?.login)) continue;
        const text = String(c.body).trim();
        if (text === `/approve ${taskId}`) return "approve";
        if (text === `/reject ${taskId}`) return "reject";
      }
    } catch {}
  }

  return "pending";
}

export function writeApprovalState(
  taskId: string | number,
  decision: "approve" | "reject",
  stateDir: string,
): void {
  const approvalsDir = join(stateDir, "approvals");
  mkdirSync(approvalsDir, { recursive: true });
  const f = join(approvalsDir, `${taskId}.status.json`);
  writeFileSync(f, JSON.stringify({ decision, status: decision, timestamp: new Date().toISOString() }));
}
