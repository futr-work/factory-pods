// Shared pod access gate (C1 containment). Single source for every pod; fix auth bugs here only.
//   - GET /health: open (liveness only, no data).
//   - Everything else: Authorization Bearer <FACTORY_HUB_TOKEN>, or HTTP Basic with password = FACTORY_HUB_TOKEN
//     for the operator browser (cockpit).
// Fails closed: without FACTORY_HUB_TOKEN only /health is served.

export interface PodAuthEnv {
  FACTORY_HUB_TOKEN?: string;
  SCOPED_CALLER_GRANTS?: string;
}

export interface CallerGrant {
  tenantId: string;
  /** Specific resource IDs permitted, or "*" for all resources within `tenantId`. */
  resourceIds: string[];
  /** Permitted actions (e.g. "read", "write", "evidence:read", "admin"), or "*". */
  actions: string[];
}

export interface ScopedCallerConfig {
  callerId: string;
  /** Hex-encoded SHA-256 fingerprint of the caller's scoped bearer secret. Never store raw secrets in D1 or logs. */
  tokenSha256: string;
  grants: CallerGrant[];
}

export interface ResolvedCaller {
  callerId: string;
  grants: CallerGrant[];
}

export interface ScopedAuthRequest {
  tenantId: string;
  resourceId?: string;
  action: string;
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

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

/**
 * Parse a JSON-encoded list of ScopedCallerConfig entries (e.g. from env.SCOPED_CALLER_GRANTS).
 * Fails closed on malformed input by returning an empty list.
 */
export function parseScopedCallerGrants(raw: string | undefined): ScopedCallerConfig[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ScopedCallerConfig[] = [];
    for (const entry of parsed) {
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.callerId !== "string" ||
        !entry.callerId.trim() ||
        typeof entry.tokenSha256 !== "string" ||
        !/^[0-9a-f]{64}$/i.test(entry.tokenSha256) ||
        !Array.isArray(entry.grants)
      ) {
        return [];
      }
      const grants: CallerGrant[] = [];
      for (const g of entry.grants) {
        if (
          !g ||
          typeof g !== "object" ||
          typeof g.tenantId !== "string" ||
          !g.tenantId.trim() ||
          !Array.isArray(g.resourceIds) ||
          !g.resourceIds.every((r: unknown) => typeof r === "string" && r.trim().length > 0) ||
          !Array.isArray(g.actions) ||
          !g.actions.every((a: unknown) => typeof a === "string" && a.trim().length > 0)
        ) {
          return [];
        }
        grants.push({
          tenantId: g.tenantId.trim(),
          resourceIds: g.resourceIds.map((r: string) => r.trim()),
          actions: g.actions.map((a: string) => a.trim()),
        });
      }
      out.push({
        callerId: entry.callerId.trim(),
        tokenSha256: entry.tokenSha256.toLowerCase(),
        grants,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Resolve a trusted caller identity strictly from the presented credential's SHA-256 fingerprint
 * against server-configured grants. Never trusts client-supplied tenant/resource/caller headers or body fields.
 * An unconfigured or shared hub token has NO tenant grants by default (fails closed -> null).
 */
export async function resolveScopedCaller(
  request: Request,
  configuredCallers: readonly ScopedCallerConfig[]
): Promise<ResolvedCaller | null> {
  if (!configuredCallers || configuredCallers.length === 0) return null;
  const secret = presentedSecret(request.headers.get("Authorization"));
  if (!secret) return null;
  const presentedHash = await sha256Hex(secret);

  let matched: ScopedCallerConfig | null = null;
  for (const cfg of configuredCallers) {
    if (timingSafeEqual(presentedHash, cfg.tokenSha256.toLowerCase())) {
      matched = cfg;
    }
  }
  if (!matched) return null;
  return {
    callerId: matched.callerId,
    grants: matched.grants.map((g) => ({
      tenantId: g.tenantId,
      resourceIds: [...g.resourceIds],
      actions: [...g.actions],
    })),
  };
}

/**
 * Pure fail-closed authorization check against a resolved caller's server-side grants.
 * Checks tenantId, optional resourceId, and action. Wildcard "*" is supported on resourceIds and actions,
 * never on tenantId (tenants are always explicit).
 */
export function isCallerAuthorized(
  caller: ResolvedCaller | null,
  req: ScopedAuthRequest
): boolean {
  if (!caller || !req.tenantId || !req.action) return false;
  for (const grant of caller.grants) {
    if (grant.tenantId !== req.tenantId) continue;
    const actionAllowed = grant.actions.includes("*") || grant.actions.includes(req.action);
    if (!actionAllowed) continue;
    if (req.resourceId === undefined) return true;
    if (grant.resourceIds.includes("*") || grant.resourceIds.includes(req.resourceId)) {
      return true;
    }
  }
  return false;
}

/**
 * Convenience HTTP gate that returns a 401/403 Response if the caller is unauthenticated or lacks the required grant,
 * or null if authorized. Never leaks credential values or fingerprints.
 */
export function authorizeScopedCaller(
  caller: ResolvedCaller | null,
  req: ScopedAuthRequest,
  realm = "factory-pod"
): Response | null {
  if (!caller) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": `Basic realm="${realm}"` },
    });
  }
  if (!isCallerAuthorized(caller, req)) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}
