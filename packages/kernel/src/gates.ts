// @futr-work/pod-kernel: Gates module
// Immune gates: blocked paths, empty diff rejection, .factory/verify.json checks, diff hashing

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GateResult, GateSpec } from "./types.js";

export const BLOCKED_PATHS: RegExp[] = [
  /^\.github\/workflows\//,
  /(^|\/)\.env(\.|$)/,
  /\.(pem|key)$/,
  /(^|\/)secrets?(\/|$)/,
  /^\.factory\//,
];

export function checkBlockedPaths(files: string[]): string[] {
  return files.filter((f) => BLOCKED_PATHS.some((rx) => rx.test(f)));
}

export function computeDiffHash(rawDiff: string): string {
  return createHash("sha256").update(rawDiff).digest("hex");
}

export function runVerifyGates(cwd: string, baseCommit: string): GateResult {
  const sh = (cmd: string, args: string[]) =>
    execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 << 20 }).trim();

  // Stage changes to inspect complete diff
  sh("git", ["add", "-A"]);
  const numStat = sh("git", ["diff", "--cached", "--numstat", baseCommit]);
  const changedFiles = numStat
    .split("\n")
    .map((line) => line.trim().split("\t")[2])
    .filter(Boolean);

  if (changedFiles.length === 0) {
    return {
      ok: false,
      checks: ["FAIL: empty diff (zero files changed)"],
      diffHash: "",
      error: "empty diff",
    };
  }

  const blocked = checkBlockedPaths(changedFiles);
  if (blocked.length > 0) {
    return {
      ok: false,
      checks: [`FAIL: blocked paths modified: ${blocked.join(", ")}`],
      diffHash: "",
      error: `blocked_paths: ${blocked.join(", ")}`,
    };
  }

  const rawDiff = sh("git", ["diff", "--cached", baseCommit]);
  const diffHash = computeDiffHash(rawDiff);

  // Load verify specification
  const vf = join(cwd, ".factory", "verify.json");
  let verifyCmds: Array<string | string[]> = [];

  if (existsSync(vf)) {
    try {
      const spec = JSON.parse(readFileSync(vf, "utf8")) as GateSpec;
      verifyCmds = spec.verify ?? [];
    } catch (e: any) {
      return {
        ok: false,
        checks: [`FAIL: invalid .factory/verify.json: ${e.message}`],
        diffHash,
        error: "invalid_verify_spec",
      };
    }
  } else if (existsSync(join(cwd, "package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
      if (pkg.scripts?.check) verifyCmds.push("npm run check");
      if (pkg.scripts?.test) verifyCmds.push("npm test");
    } catch {}
  }

  const checks: string[] = [];
  for (const cmd of verifyCmds) {
    const cmdStr = Array.isArray(cmd) ? cmd.join(" ") : cmd;
    try {
      sh("bash", ["-lc", cmdStr]);
      checks.push(`PASS ${cmdStr}`);
    } catch (e: any) {
      checks.push(`FAIL ${cmdStr}`);
      return {
        ok: false,
        checks,
        diffHash,
        error: `command_failed: ${cmdStr}`,
      };
    }
  }

  return {
    ok: true,
    checks,
    diffHash,
  };
}
