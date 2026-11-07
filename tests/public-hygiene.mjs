#!/usr/bin/env node
// Public-repo hygiene gate. Fails if any tracked file carries operator-private details:
// absolute home paths, the upstream maintainer's personal handle, tailnet hostnames,
// a Cloudflare account subdomain, or a real D1 database id.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RULES = [
  { name: "absolute home path", re: /\/Users\/[A-Za-z0-9._-]+|\/home\/[a-z][a-z0-9_-]*\/(?!runner\b)/ },
  { name: "personal GitHub handle", re: /hdiesel323/i },
  { name: "tailnet hostname", re: /\b[a-z0-9-]+\.(?:tail[0-9a-f]{4,}\.)?ts\.net\b|\btail[0-9a-f]{6}\b/i },
  { name: "Cloudflare account subdomain", re: /\.[a-z0-9-]+\d+\.workers\.dev\b/i },
  { name: "real D1 database id", re: /"database_id"\s*:\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/i },
  { name: "secrets manager project id", re: /--projectId=[0-9a-f-]{36}/i },
];

const SELF = "tests/public-hygiene.mjs";
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const hits = [];

for (const file of files) {
  if (file === SELF) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue; // binary
  text.split("\n").forEach((line, i) => {
    for (const rule of RULES) if (rule.re.test(line)) hits.push(`${file}:${i + 1}: ${rule.name}: ${line.trim().slice(0, 120)}`);
  });
}

if (hits.length) {
  console.error(`public-hygiene: ${hits.length} finding(s)\n` + hits.join("\n"));
  process.exit(1);
}
console.log(`public-hygiene: ${files.length} tracked files clean`);
