#!/usr/bin/env bash
# Quickstart end to end, exactly as a new user runs it, from an empty directory.
#   default:                packs the kernel and scaffolder from this checkout (pre-publish gate)
#   QUICKSTART_REGISTRY=1:  uses the published @futr-work packages from npm (post-publish check)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
TEMPLATE="${TEMPLATE:-starter}"

if [[ "${QUICKSTART_REGISTRY:-0}" == "1" ]]; then
  echo "== scaffolding from the npm registry"
  (cd "$WORK" && npm create --yes @futr-work/factory-pod@latest my-pod -- --template "$TEMPLATE")
else
  echo "== packing kernel and scaffolder"
  mkdir -p "$WORK/pack"
  (cd "$ROOT/packages/kernel" && npm pack --silent --pack-destination "$WORK/pack" >/dev/null)
  (cd "$ROOT/packages/create-factory-pod" && npm pack --silent --pack-destination "$WORK/pack" >/dev/null)
  KERNEL_TGZ="$(ls "$WORK"/pack/futr-work-pod-kernel-*.tgz)"
  CLI_TGZ="$(ls "$WORK"/pack/futr-work-create-factory-pod-*.tgz)"
  echo "== scaffolding from the packed CLI in an empty directory"
  (cd "$WORK" && npx --yes --package "$CLI_TGZ" create-factory-pod my-pod --template "$TEMPLATE")
  # Pre-publish only: resolve the kernel from the packed tarball instead of the registry.
  (cd "$WORK/my-pod" && node -e '
    const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
    p.dependencies["@futr-work/pod-kernel"] = "file:" + process.argv[1];
    fs.writeFileSync("package.json", JSON.stringify(p, null, 2));' "$KERNEL_TGZ")
fi

cd "$WORK/my-pod"
test -f .dev.vars || { echo "missing .dev.vars"; exit 1; }
grep -q '"name": "my-pod"' wrangler.jsonc || { echo "wrangler name not rewritten"; exit 1; }
grep -q '^name = "my-pod"' pod.toml || { echo "pod.toml name not rewritten"; exit 1; }

echo "== npm install"
npm install --no-audit --no-fund --loglevel=error
echo "== type check"
npx tsc --noEmit
echo "== tests"
npm test
echo "== deploy dry run (bundles the worker; needs no Cloudflare account)"
npx wrangler deploy --dry-run --outdir "$WORK/dist" >/dev/null
echo "quickstart-e2e: OK ($TEMPLATE)"
