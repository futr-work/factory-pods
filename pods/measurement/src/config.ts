import type { PodConfig } from "./types.js";

export function loadPodConfig(env: Record<string, any> = {}): PodConfig {
  const procEnv = typeof process !== "undefined" ? process.env : {};
  const get = (k: string, fallback: string) =>
    (typeof env[k] === "string" && env[k]) || (typeof procEnv[k] === "string" && procEnv[k]) || fallback;

  return {
    id: get("POD_ID", "measurement-pod"),
    name: get("POD_NAME", "Measurement Pod"),
    role: get("POD_ROLE", "measurement"),
    lob: get("POD_LOB", "measurement-evidence"),
    hubUrl: get("FACTORY_HUB_URL", "http://127.0.0.1:8787"),
    hubToken: get("FACTORY_HUB_TOKEN", ""),
    port: Number.parseInt(get("PORT", "8791"), 10) || 8791,
    capabilities: [
      "typed-observations",
      "immutable-provenance",
      "coverage-reconciliation",
      "mcp-2026-07-28",
      "code-mode",
      "worldview-projection",
    ],
  };
}
