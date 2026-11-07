#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const self = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const TEMPLATES = ["starter", "model-governor", "sentinel-radar", "authority-seo"];

function printUsage() {
  console.log(`
🏭 create-factory-pod v${self.version}
Scaffold an edge-native autonomous worker pod on Cloudflare Workers.

Usage:
  npm create @futr-work/factory-pod@latest <project-name> -- [options]
  npx @futr-work/create-factory-pod <project-name> [options]

Options:
  --role <role>         Functional role (default: "custom-worker")
  --template <template> ${TEMPLATES.join(" | ")} (default: "starter")
  --help, -h            Show this help message

Examples:
  npx @futr-work/create-factory-pod billing-auditor --role auditor
  npx @futr-work/create-factory-pod model-router --template model-governor
`);
}

// Templates ship inside the published package (templates/<name>, copied at prepack).
// Inside the monorepo they are read straight from pods/<name>.
function resolveTemplate(template) {
  const packaged = join(pkgRoot, "templates", template);
  if (existsSync(packaged)) return { dir: packaged, monorepo: false };
  const local = resolve(pkgRoot, "..", "..", "pods", template);
  if (existsSync(local)) return { dir: local, monorepo: true };
  return null;
}

function resolveTestSupport(monorepo) {
  return monorepo
    ? resolve(pkgRoot, "..", "..", "tests", "support", "no-network.mjs")
    : join(pkgRoot, "templates", "_support", "no-network.mjs");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  let targetDir = "";
  let role = "custom-worker";
  let template = "starter";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--role" && args[i + 1]) {
      role = args[++i];
    } else if (arg === "--template" && args[i + 1]) {
      template = args[++i];
    } else if (!arg.startsWith("-") && !targetDir) {
      targetDir = arg;
    }
  }

  if (!targetDir) {
    console.error("❌ Error: Missing project name or destination directory.");
    printUsage();
    process.exit(1);
  }

  if (!TEMPLATES.includes(template)) {
    console.error(`❌ Error: Unknown template "${template}". Choose one of: ${TEMPLATES.join(", ")}.`);
    process.exit(1);
  }

  const destPath = resolve(process.cwd(), targetDir);
  const podName = basename(destPath);

  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(podName)) {
    console.error(`❌ Error: "${podName}" is not a valid Worker name (lowercase letters, digits and dashes).`);
    process.exit(1);
  }

  if (existsSync(destPath)) {
    console.error(`❌ Error: Directory "${destPath}" already exists.`);
    process.exit(1);
  }

  const source = resolveTemplate(template);
  if (!source) {
    console.error(`❌ Error: Template "${template}" is missing from this installation.`);
    process.exit(1);
  }

  console.log(`\n🚀 Scaffolding autonomous pod "${podName}" using template "${template}"...`);

  mkdirSync(destPath, { recursive: true });
  cpSync(source.dir, destPath, {
    recursive: true,
    filter: (src) => {
      const rel = relative(source.dir, src);
      return !/(^|[\\/])(node_modules|\.wrangler|\.git|\.dev\.vars)($|[\\/])/.test(rel) && !rel.endsWith("package-lock.json");
    },
  });

  // Tests stay hermetic outside the monorepo: ship the network guard with the pod.
  const supportDir = join(destPath, "tests", "support");
  mkdirSync(supportDir, { recursive: true });
  cpSync(resolveTestSupport(source.monorepo), join(supportDir, "no-network.mjs"));

  // Customize package.json
  const pkgPath = join(destPath, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.name = podName;
  pkg.description = `Autonomous worker pod: ${podName} (${role})`;
  pkg.scripts = {
    ...(pkg.scripts || {}),
    dev: "wrangler dev --port 8787",
    deploy: "wrangler deploy",
    test: "tsx --import ./tests/support/no-network.mjs --test tests/**/*.test.ts",
  };
  delete pkg.scripts.scaffold;
  pkg.dependencies = {
    ...(pkg.dependencies || {}),
    "@futr-work/pod-kernel": source.monorepo
      ? `file:${relative(destPath, resolve(pkgRoot, "..", "kernel"))}`
      : `^${self.kernelVersion ?? self.version}`,
  };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // Local development auth: the cockpit and MCP endpoint fail closed without a token.
  writeFileSync(join(destPath, ".dev.vars"), `FACTORY_HUB_TOKEN=${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });

  // Customize wrangler.jsonc: worker name and D1 database name follow the pod name.
  const wranglerPath = join(destPath, "wrangler.jsonc");
  if (existsSync(wranglerPath)) {
    let content = readFileSync(wranglerPath, "utf8");
    content = content.replace(/"name":\s*"[^"]+"/, `"name": "${podName}"`);
    content = content.replace(/"database_name":\s*"[^"]+"/, `"database_name": "${podName}-db"`);
    writeFileSync(wranglerPath, content);
  }

  // Rewrite the pod.toml name; keep the template's declared tools so manifest tests stay meaningful.
  const tomlPath = join(destPath, "pod.toml");
  if (existsSync(tomlPath)) {
    let toml = readFileSync(tomlPath, "utf8");
    toml = toml.replace(/^name\s*=\s*"[^"]*"/m, `name = "${podName}"`);
    toml = toml.replace(/^role\s*=\s*"[^"]*"/m, `role = "${role}"`);
    writeFileSync(tomlPath, toml);
  }

  console.log(`\n✅ Pod created at: ${destPath}\n`);
  console.log(`Next steps:`);
  console.log(`  1. cd ${targetDir}`);
  console.log(`  2. npm install`);
  console.log(`  3. npm run dev     # local edge runtime + cockpit on http://localhost:8787`);
  console.log(`     (cockpit password: the FACTORY_HUB_TOKEN in .dev.vars)`);
  console.log(`  4. npx wrangler d1 create ${podName}-db   # paste the id into wrangler.jsonc`);
  console.log(`  5. npx wrangler secret put FACTORY_HUB_TOKEN && npx wrangler deploy\n`);
}

main().catch((err) => {
  console.error("Fatal error during scaffolding:", err);
  process.exit(1);
});
