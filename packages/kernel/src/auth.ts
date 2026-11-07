// Shared pod access gate (C1 containment). Single source for every pod; fix auth bugs here only.
//   - GET /health: open (liveness only, no data).
//   - Everything else: Authorization Bearer <FACTORY_HUB_TOKEN>, or HTTP Basic with password = FACTORY_HUB_TOKEN
//     for the operator browser (cockpit).
// Fails closed: without FACTORY_HUB_TOKEN only /health is served.

export interface PodAuthEnv {
  FACTORY_HUB_TOKEN?: string;
}

const encoder = new TextEncoder();

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export function presentedSecret(header: string | null): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(/\s+/, 2);
  if (!scheme || !value) return null;
  if (scheme.toLowerCase() === "bearer") return value;
  if (scheme.toLowerCase() === "basic") {
    try {
      const decoded = atob(value);
      const idx = decoded.indexOf(":");
      return idx >= 0 ? decoded.slice(idx + 1) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Returns a rejection Response, or null if the request may proceed. `realm` names the Basic-auth challenge. */
export function authGate(request: Request, env: PodAuthEnv, realm = "factory-pod"): Response | null {
  const url = new URL(request.url);
  if (url.pathname === "/health") return null;
  const secret = presentedSecret(request.headers.get("Authorization"));
  if (env.FACTORY_HUB_TOKEN && secret !== null && timingSafeEqual(secret, env.FACTORY_HUB_TOKEN)) return null;
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": `Basic realm="${realm}"` },
  });
}
