import { PodConfig } from "./types.js";

export function loadPodConfig(env?: Record<string, any>): PodConfig {
  const get = (key: string, fallback: string): string => {
    if (env && env[key]) return String(env[key]);
    if (typeof process !== "undefined" && process.env && process.env[key]) {
      return String(process.env[key]);
    }
    return fallback;
  };

  const id = get("POD_ID", "worker-pod-01");
  const name = get("POD_NAME", "Worker Pod");
  const role = get("POD_ROLE", "worker");
  const lob = get("POD_DOMAIN", get("POD_LOB", "default"));

  // Smart default: use Cloudflare edge hub when running on edge/worker, local hub when in Node
  const isCloudflareWorker =
    (env && typeof env.DB !== "undefined") ||
    typeof (globalThis as any).WebSocketPair !== "undefined" ||
    (typeof navigator !== "undefined" && (navigator as any).userAgent?.includes("Cloudflare"));

  const defaultHubUrl = isCloudflareWorker
    ? "" // set FACTORY_HUB_URL in wrangler.jsonc vars
    : "http://127.0.0.1:4950";

  const hubUrl = get("HUB_URL", get("FACTORY_HUB_URL", defaultHubUrl));
  const hubToken = get("FACTORY_HUB_TOKEN", "");
  const apiKey = get("API_KEY", "");
  const port = parseInt(get("PORT", "5100"), 10);

  let capabilities: string[] = ["task_execution", "event_messaging", "health_reporting"];
  const rawCaps = get("POD_CAPABILITIES", "");
  if (rawCaps) {
    try {
      capabilities = JSON.parse(rawCaps);
    } catch {
      capabilities = rawCaps.split(",").map((c) => c.trim()).filter(Boolean);
    }
  }

  return {
    id,
    name,
    role,
    lob,
    capabilities,
    hubUrl,
    hubToken,
    apiKey,
    port,
  };
}
