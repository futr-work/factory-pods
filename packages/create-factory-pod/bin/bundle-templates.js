#!/usr/bin/env node
// prepack: copy the reference pods into templates/ so the published scaffolder is self-contained.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const repoRoot = resolve(pkgRoot, "..", "..");
const out = join(pkgRoot, "templates");
const TEMPLATES = ["starter", "model-governor", "sentinel-radar", "authority-seo"];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const name of TEMPLATES) {
  const src = join(repoRoot, "pods", name);
  if (!existsSync(src)) throw new Error(`missing template source: ${src}`);
  cpSync(src, join(out, name), {
    recursive: true,
    filter: (p) => {
      const rel = relative(src, p);
      return !/(^|[\\/])(node_modules|\.wrangler|\.git|\.dev\.vars)($|[\\/])/.test(rel) && !rel.endsWith("package-lock.json");
    },
  });
}

mkdirSync(join(out, "_support"), { recursive: true });
cpSync(join(repoRoot, "tests", "support", "no-network.mjs"), join(out, "_support", "no-network.mjs"));
console.log(`bundled ${TEMPLATES.length} templates into ${relative(repoRoot, out)}`);
