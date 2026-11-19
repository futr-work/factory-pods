// Governor access gate. Mirrors factory-hub src/auth.ts.
//   - GET /health: open.
//   - Everything else: Authorization Bearer <FACTORY_HUB_TOKEN> (pods, runners, CLIs), or HTTP Basic with
//     password = FACTORY_HUB_TOKEN (operator browser).
//   - Client routes only (chat completions, model list): also Bearer <GOVERNOR_CLIENT_TOKEN>, so an outside OpenAI
//     client such as OpenBot can use the governor without holding the mesh-wide hub token.
//   - Admin routes (approve a paid model, set caller budgets, trigger discovery and probes): Bearer
//     <GOVERNOR_ADMIN_TOKEN> only. Pods share FACTORY_HUB_TOKEN, so a pod must never be able to approve spend (ruling #1).
//   - Spend reads (GET /api/governor/callers, /api/governor/usage-report): the hub token or the admin token, so the
//     operator who sets budgets can see what they are spent on without holding the mesh-wide hub token.
// Fails closed: without FACTORY_HUB_TOKEN only /health is served (plus client routes if GOVERNOR_CLIENT_TOKEN is set);
// without GOVERNOR_ADMIN_TOKEN no admin route is.

import { authGate as baseAuthGate, presentedSecret, timingSafeEqual } from "@futr-work/pod-kernel/auth";

export interface GovAuthEnv {
  FACTORY_HUB_TOKEN?: string;
  GOVERNOR_ADMIN_TOKEN?: string;
  GOVERNOR_CLIENT_TOKEN?: string;
}

export { timingSafeEqual, presentedSecret };

/** Upstream model names often contain a slash. Authorization and dispatch share this exact matcher. */
export function modelApprovalRoute(pathname: string) {
  return /^\/api\/models\/(.+)\/(approve|revoke)$/.exec(pathname);
}

export function isAdminRoute(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  return modelApprovalRoute(pathname) !== null || pathname.startsWith("/api/governor/");
}

const CLIENT_POST = new Set(["/v1/chat/completions", "/chat/completions", "/api/inference/chat/completions"]);
const CLIENT_GET = new Set(["/v1/models", "/models", "/api/inference/models"]);

/** The OpenAI-compatible surface: what an outside client needs, and nothing that reads or changes governor state. */
export function isClientRoute(method: string, pathname: string): boolean {
  return (method === "POST" && CLIENT_POST.has(pathname)) || (method === "GET" && CLIENT_GET.has(pathname));
}

const ADMIN_READ_GET = new Set(["/api/governor/callers", "/api/governor/usage-report"]);

/** Read-only spend views the admin token may open in addition to the hub token. */
export function isAdminReadRoute(method: string, pathname: string): boolean {
  return method === "GET" && ADMIN_READ_GET.has(pathname);
}

/** Returns a rejection Response, or null if the request may proceed. */
export function isPrivateLedgerRoute(path: string): boolean {
  return path === "/api/governor/evidence" || path === "/api/governor/scorecard" || path === "/api/governor/usage-receipts";
}

export function authGate(request: Request, env: GovAuthEnv): Response | null {
  const url = new URL(request.url);
  const evidenceRoute = isPrivateLedgerRoute(url.pathname);
  if (evidenceRoute || isAdminRoute(request.method, url.pathname)) {
    const secret = presentedSecret(request.headers.get("Authorization"));
    const bearer = /^Bearer /i.test(request.headers.get("Authorization") ?? "");
    if ((!evidenceRoute || bearer) && env.GOVERNOR_ADMIN_TOKEN && secret !== null && timingSafeEqual(secret, env.GOVERNOR_ADMIN_TOKEN)) return null;
    return new Response(JSON.stringify({ error: "admin credential required" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (env.GOVERNOR_ADMIN_TOKEN && isAdminReadRoute(request.method, url.pathname)) {
    const secret = presentedSecret(request.headers.get("Authorization"));
    if (secret !== null && timingSafeEqual(secret, env.GOVERNOR_ADMIN_TOKEN)) return null;
  }
  if (env.GOVERNOR_CLIENT_TOKEN && isClientRoute(request.method, url.pathname)) {
    const secret = presentedSecret(request.headers.get("Authorization"));
    if (secret !== null && timingSafeEqual(secret, env.GOVERNOR_CLIENT_TOKEN)) return null;
  }
  return baseAuthGate(request, env, "model-governor");
}
