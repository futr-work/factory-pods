// Governor access gate. Mirrors factory-hub src/auth.ts.
//   - GET /health: open.
//   - Everything else: Authorization Bearer <FACTORY_HUB_TOKEN> (pods, runners, CLIs), or HTTP Basic with
//     password = FACTORY_HUB_TOKEN (operator browser).
//   - Client routes only (chat completions, model list): also Bearer <GOVERNOR_CLIENT_TOKEN>, so an outside OpenAI
//     client such as OpenBot can use the governor without holding the mesh-wide hub token.
//   - Admin routes (approve a paid model, set caller budgets, trigger discovery and probes): Bearer
//     <GOVERNOR_ADMIN_TOKEN> only. Pods share FACTORY_HUB_TOKEN, so a pod must never be able to approve spend (ruling #1).
// Fails closed: without FACTORY_HUB_TOKEN only /health is served (plus client routes if GOVERNOR_CLIENT_TOKEN is set);
// without GOVERNOR_ADMIN_TOKEN no admin route is.

import { authGate as baseAuthGate, presentedSecret, timingSafeEqual } from "@futr-work/pod-kernel/auth";

export interface GovAuthEnv {
  FACTORY_HUB_TOKEN?: string;
  GOVERNOR_ADMIN_TOKEN?: string;
  GOVERNOR_CLIENT_TOKEN?: string;
}

export { timingSafeEqual, presentedSecret };

export function isAdminRoute(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  return /^\/api\/models\/[^/]+\/(approve|revoke)$/.test(pathname) || pathname.startsWith("/api/governor/");
}

const CLIENT_POST = new Set(["/v1/chat/completions", "/chat/completions", "/api/inference/chat/completions"]);
const CLIENT_GET = new Set(["/v1/models", "/models", "/api/inference/models"]);

/** The OpenAI-compatible surface: what an outside client needs, and nothing that reads or changes governor state. */
export function isClientRoute(method: string, pathname: string): boolean {
  return (method === "POST" && CLIENT_POST.has(pathname)) || (method === "GET" && CLIENT_GET.has(pathname));
}

/** Returns a rejection Response, or null if the request may proceed. */
export function authGate(request: Request, env: GovAuthEnv): Response | null {
  const url = new URL(request.url);
  if (isAdminRoute(request.method, url.pathname)) {
    const secret = presentedSecret(request.headers.get("Authorization"));
    if (env.GOVERNOR_ADMIN_TOKEN && secret !== null && timingSafeEqual(secret, env.GOVERNOR_ADMIN_TOKEN)) return null;
    return new Response(JSON.stringify({ error: "admin credential required" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (env.GOVERNOR_CLIENT_TOKEN && isClientRoute(request.method, url.pathname)) {
    const secret = presentedSecret(request.headers.get("Authorization"));
    if (secret !== null && timingSafeEqual(secret, env.GOVERNOR_CLIENT_TOKEN)) return null;
  }
  return baseAuthGate(request, env, "model-governor");
}
