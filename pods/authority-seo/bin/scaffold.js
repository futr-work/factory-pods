#!/usr/bin/env node

/**
 * ============================================================================
 * FACTORY POD SCAFFOLDER
 * ============================================================================
 * Rapidly spins up a dedicated, edge-first Factory Pod for any Line of Business.
 *
 * Usage:
 *   node bin/scaffold.js --name <pod-name> --role <role> --lob <line-of-business> [--out <dir>]
 *
 * Example:
 *   node bin/scaffold.js --name authority-seo-pod --role seo --lob authority-network
 */

import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {
    name: "",
    role: "generic",
    lob: "default",
    out: "",
    createDb: true,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) params.name = args[++i];
    if (args[i] === "--role" && args[i + 1]) params.role = args[++i];
    if (args[i] === "--lob" && args[i + 1]) params.lob = args[++i];
    if (args[i] === "--out" && args[i + 1]) params.out = args[++i];
    if (args[i] === "--no-db") params.createDb = false;
  }

  if (!params.name) {
    console.error("❌ Error: Missing --name argument.");
    console.log("Usage: node bin/scaffold.js --name <pod-name> --role <role> --lob <lob> [--out <dir>]");
    process.exit(1);
  }

  if (!params.out) {
    params.out = resolve(process.cwd(), "..", params.name);
  } else {
    params.out = resolve(params.out);
  }

  return params;
}

function main() {
  const { name, role, lob, out, createDb } = parseArgs();
  const templateDir = resolve(import.meta.dirname, "..");

  console.log(`\n======================================================`);
  console.log(`🏭 FACTORY POD SCAFFOLDER`);
  console.log(`======================================================`);
  console.log(`📦 Pod Name:         ${name}`);
  console.log(`🎭 Role:             ${role}`);
  console.log(`🏢 Line of Business: ${lob}`);
  console.log(`📁 Destination:      ${out}`);
  console.log(`======================================================\n`);

  if (existsSync(out)) {
    console.error(`❌ Target directory already exists: ${out}`);
    process.exit(1);
  }

  mkdirSync(out, { recursive: true });

  // 1. Copy template files (exclude git, modules, builds)
  console.log("Copying chassis template files...");
  cpSync(templateDir, out, {
    recursive: true,
    filter: (src) => {
      return !src.includes("node_modules") &&
             !src.includes(".git") &&
             !src.includes("dist") &&
             !src.includes(".wrangler") &&
             !src.endsWith(".sqlite");
    },
  });

  // 2. Customize package.json
  const pkgPath = join(out, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.name = name;
    pkg.description = `Autonomous ${role.toUpperCase()} Pod for Line of Business: ${lob}`;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }

  // 3. Customize config defaults in src/config.ts
  const configPath = join(out, "src", "config.ts");
  if (existsSync(configPath)) {
    let content = readFileSync(configPath, "utf8");
    content = content.replace(`get("POD_ID", "template-pod")`, `get("POD_ID", "${name}")`);
    content = content.replace(`get("POD_NAME", "Template Pod")`, `get("POD_NAME", "${name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}")`);
    content = content.replace(`get("POD_ROLE", "generic")`, `get("POD_ROLE", "${role}")`);
    content = content.replace(`get("POD_LOB", "default")`, `get("POD_LOB", "${lob}")`);
    writeFileSync(configPath, content);
  }

  // 4. Customize wrangler.jsonc
  const wranglerPath = join(out, "wrangler.jsonc");
  if (existsSync(wranglerPath)) {
    let content = readFileSync(wranglerPath, "utf8");
    content = content.replace(/"name":\s*"factory-pod-template"/g, `"name": "${name}"`);
    content = content.replace(/"database_name":\s*"pod-template-db"/g, `"database_name": "${name}-db"`);
    writeFileSync(wranglerPath, content);
  }

  // 5. Create Cloudflare D1 Database if requested
  if (createDb) {
    console.log(`\nCreating Cloudflare D1 database: ${name}-db...`);
    try {
      // Uses your wrangler login, or CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID from the environment.
      const authCmd = `npx wrangler d1 create ${name}-db --json`;

      const outJson = execSync(authCmd, { encoding: "utf8", timeout: 15000 });
      const parsed = JSON.parse(outJson.slice(outJson.indexOf("{")));

      if (parsed.database_id) {
        console.log(`✅ Created D1 database ID: ${parsed.database_id}`);
        // Update wrangler.jsonc with new DB ID
        let wranglerContent = readFileSync(wranglerPath, "utf8");
        wranglerContent = wranglerContent.replace(/"database_id":\s*"[^"]*"/, `"database_id": "${parsed.database_id}"`);
        writeFileSync(wranglerPath, wranglerContent);
      }
    } catch (dbErr) {
      console.warn("⚠️ Could not auto-create D1 database (create manually or authenticate wrangler).");
    }
  }

  console.log(`\n🎉 Successfully scaffolded ${name}!`);
  console.log(`\nNext steps:`);
  console.log(`  cd ${out}`);
  console.log(`  npm install`);
  console.log(`  # Customize business logic in src/handler.ts`);
  console.log(`  just cf-schema    # apply D1 tables`);
  console.log(`  just cf-deploy    # deploy to Cloudflare\n`);
}

main();
