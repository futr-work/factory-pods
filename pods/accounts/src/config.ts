import type { PodConfig } from "./types.js";

export function loadPodConfig(env: Record<string, any> = {}): PodConfig {
  const procEnv = typeof process !== "undefined" ? process.env : {};
  const get = (k: string, fallback: string) =>
    (typeof env[k] === "string" && env[k]) || (typeof procEnv[k] === "string" && procEnv[k]) || fallback;

  return {
    id: get("POD_ID", "accounts-pod"),
    name: get("POD_NAME", "Accounts Pod"),
    role: get("POD_ROLE", "accounts"),
    lob: get("POD_LOB", "identity-access-registry"),
    hubUrl: get("FACTORY_HUB_URL", "http://127.0.0.1:8787"),
    hubToken: get("FACTORY_HUB_TOKEN", ""),
    port: Number.parseInt(get("PORT", "8792"), 10) || 8792,
    capabilities: [
      "account-graph",
      "vault-agnostic-adapters",
      "asset-ownership-matrix",
      "overlap-and-gap-detection",
      "oauth2-pkce-broker",
      "mcp-2026-07-28",
      "code-mode",
    ],
  };
}
