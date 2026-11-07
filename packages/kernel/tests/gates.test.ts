import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkBlockedPaths, computeDiffHash } from "../src/gates.js";

describe("pod-kernel gates", () => {
  test("checkBlockedPaths detects blocked filenames", () => {
    const files = [
      "src/index.ts",
      ".github/workflows/deploy.yml",
      ".env",
      "server.key",
      "secrets/token.json",
      ".factory/verify.json",
      "README.md",
    ];

    const blocked = checkBlockedPaths(files);
    assert.deepEqual(blocked, [
      ".github/workflows/deploy.yml",
      ".env",
      "server.key",
      "secrets/token.json",
      ".factory/verify.json",
    ]);
  });

  test("computeDiffHash produces deterministic SHA256", () => {
    const diff = "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const h1 = computeDiffHash(diff);
    const h2 = computeDiffHash(diff);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
  });
});
