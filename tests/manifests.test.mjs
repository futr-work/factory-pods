// Every pod ships a pod.toml that matches what the code actually deploys and exposes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const podsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "pods");
const pods = readdirSync(podsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

for (const pod of pods) {
  test(`${pod}: pod.toml matches wrangler name and exposed MCP tools`, () => {
    const dir = join(podsDir, pod);
    assert.ok(existsSync(join(dir, "pod.toml")), "pod.toml missing");
    const toml = readFileSync(join(dir, "pod.toml"), "utf8");
    const name = toml.match(/^name = "([^"]+)"/m)?.[1];
    const role = toml.match(/^role = "([^"]+)"/m)?.[1];
    const declared = [...(toml.match(/^mcp = \[(.*)\]/m)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    assert.ok(role, "role missing");
    const wranglerName = readFileSync(join(dir, "wrangler.jsonc"), "utf8").match(/"name":\s*"([^"]+)"/)?.[1];
    assert.equal(name, wranglerName, "pod.toml name must equal the deployed worker name");
    const mcpSrc = join(dir, "src", "mcp.ts");
    const actual = existsSync(mcpSrc)
      ? [...new Set([...readFileSync(mcpSrc, "utf8").matchAll(/name: "([a-z_]+)"/g)].map((m) => m[1]))].sort()
      : [];
    assert.deepEqual(declared, actual, "declared MCP tools must equal the tools registered in src/mcp.ts");
  });
}

test("README fleet table lists every pod directory", () => {
  const readme = readFileSync(join(podsDir, "..", "README.md"), "utf8");
  for (const pod of pods) assert.ok(readme.includes(`](pods/${pod})`), `README fleet table is missing pods/${pod}`);
});
