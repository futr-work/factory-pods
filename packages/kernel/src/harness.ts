// @futr-work/pod-kernel: Harness module
// Adapters for opencode, codex, and faux test harnesses

import { execFileSync } from "node:child_process";
import type { HarnessExecutionOptions, HarnessResult } from "./types.js";

export interface HarnessAdapter {
  name: string;
  run(options: HarnessExecutionOptions): Promise<HarnessResult>;
}

export class OpencodeHarness implements HarnessAdapter {
  name = "opencode";
  private binaryPath: string;

  constructor(binaryPath = process.env.OPENCODE_BIN || "opencode") {
    this.binaryPath = binaryPath;
  }

  async run(options: HarnessExecutionOptions): Promise<HarnessResult> {
    const prompt = [
      `You are working in a git checkout at ${options.cwd}. Resolve this issue with the smallest correct change.`,
      `Do not modify .github/workflows, .factory/, or any secret files. Do not commit or push; the pod does that.`,
      `# ${options.title}`,
      "",
      options.body,
    ].join("\n");

    try {
      execFileSync(
        this.binaryPath,
        ["run", "--pure", "--auto", "--dir", options.cwd, prompt],
        { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: options.timeoutMs ?? 300_000 },
      );
      return { exitCode: 0, lastMessage: "opencode completed", usage: "unknown" };
    } catch (e: any) {
      return { exitCode: e.status ?? 1, error: e.message, lastMessage: e.stderr || e.stdout };
    }
  }
}

export class CodexHarness implements HarnessAdapter {
  name = "codex";

  async run(options: HarnessExecutionOptions): Promise<HarnessResult> {
    const prompt = [
      `You are working in a git checkout at ${options.cwd}. Resolve this issue with the smallest correct change.`,
      `# ${options.title}`,
      "",
      options.body,
    ].join("\n");

    try {
      execFileSync(
        "codex",
        ["exec", "--model", options.model ?? "gpt-5", prompt],
        { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: options.timeoutMs ?? 300_000 },
      );
      return { exitCode: 0, lastMessage: "codex completed", usage: "unknown" };
    } catch (e: any) {
      return { exitCode: e.status ?? 1, error: e.message };
    }
  }
}

export function createHarness(engine: string): HarnessAdapter {
  if (engine === "opencode") return new OpencodeHarness();
  if (engine === "codex") return new CodexHarness();
  throw new Error(`unsupported_harness_engine: ${engine}`);
}
