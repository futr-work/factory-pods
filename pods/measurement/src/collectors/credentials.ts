import type { CollectorConnector } from "../types.js";

export type CollectorCredentialEntry =
  | {
      kind: "gsc_service_account";
      tenantId: string;
      allowedProperties: Record<string, string[]>;
      clientEmail: string;
      privateKeyPem: string;
      tokenUri?: string;
    }
  | {
      kind: "gsc_oauth_refresh";
      tenantId: string;
      allowedProperties: Record<string, string[]>;
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      tokenUri?: string;
    }
  | {
      kind: "bing_api_key";
      tenantId: string;
      allowedProperties: Record<string, string[]>;
      apiKey: string;
      apiBaseUrl?: string;
    };

export type CollectorCredentialResolution =
  | { ok: true; credential: CollectorCredentialEntry; secretsToRedact: string[] }
  | {
      ok: false;
      errorClass: "credential_unconfigured" | "credential_scope_denied" | "credential_connector_mismatch";
      reason: string;
    };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parse authoritative server-side resourceId -> provider sourceResourceId[] mapping.
 * Fail-closed: rejects wildcards ("*"), empty mappings, or non-string entries.
 */
function parseAllowedProperties(raw: unknown): Record<string, string[]> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return null;

  const out: Record<string, string[]> = {};
  for (const [rawRid, rawProps] of entries) {
    const rid = rawRid.trim();
    if (!rid || rid === "*") return null;
    if (!Array.isArray(rawProps) || rawProps.length === 0) return null;
    const props: string[] = [];
    for (const p of rawProps) {
      if (!isNonEmptyString(p)) return null;
      const trimmed = p.trim();
      if (trimmed === "*") return null;
      props.push(trimmed);
    }
    out[rid] = props;
  }
  return out;
}

/**
 * Parse server-side COLLECTOR_CREDENTIALS JSON map fail-closed.
 * Malformed JSON or invalid entries are ignored rather than throwing raw secret-bearing messages.
 * Every credential MUST bind an explicit tenantId and authoritative resourceId -> sourceResourceId[] map.
 */
export function parseCollectorCredentials(raw: string | undefined): Record<string, CollectorCredentialEntry> {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const out: Record<string, CollectorCredentialEntry> = {};
  for (const [ref, entry] of Object.entries(parsed as Record<string, any>)) {
    if (!ref.trim() || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (!isNonEmptyString(entry.tenantId)) continue;
    const allowedProperties = parseAllowedProperties(entry.allowedProperties);
    if (!allowedProperties) continue;

    const tenantId = entry.tenantId.trim();

    if (entry.kind === "gsc_service_account") {
      if (!isNonEmptyString(entry.clientEmail) || !isNonEmptyString(entry.privateKeyPem)) continue;
      out[ref.trim()] = {
        kind: "gsc_service_account",
        tenantId,
        allowedProperties,
        clientEmail: entry.clientEmail.trim(),
        privateKeyPem: entry.privateKeyPem.trim(),
        tokenUri: isNonEmptyString(entry.tokenUri) ? entry.tokenUri.trim() : undefined,
      };
    } else if (entry.kind === "gsc_oauth_refresh") {
      if (
        !isNonEmptyString(entry.clientId) ||
        !isNonEmptyString(entry.clientSecret) ||
        !isNonEmptyString(entry.refreshToken)
      ) {
        continue;
      }
      out[ref.trim()] = {
        kind: "gsc_oauth_refresh",
        tenantId,
        allowedProperties,
        clientId: entry.clientId.trim(),
        clientSecret: entry.clientSecret.trim(),
        refreshToken: entry.refreshToken.trim(),
        tokenUri: isNonEmptyString(entry.tokenUri) ? entry.tokenUri.trim() : undefined,
      };
    } else if (entry.kind === "bing_api_key") {
      if (!isNonEmptyString(entry.apiKey)) continue;
      out[ref.trim()] = {
        kind: "bing_api_key",
        tenantId,
        allowedProperties,
        apiKey: entry.apiKey.trim(),
        apiBaseUrl: isNonEmptyString(entry.apiBaseUrl) ? entry.apiBaseUrl.trim() : undefined,
      };
    }
  }
  return out;
}

export function extractCredentialSecrets(entry: CollectorCredentialEntry): string[] {
  if (entry.kind === "gsc_service_account") return [entry.privateKeyPem];
  if (entry.kind === "gsc_oauth_refresh") return [entry.clientSecret, entry.refreshToken];
  return [entry.apiKey];
}

/**
 * Validate the full (credentialRef, connector, tenantId, resourceId, sourceResourceId) tuple
 * against the authoritative server-side COLLECTOR_CREDENTIALS mapping before any network request.
 */
export function resolveCollectorCredential(
  credentialsMap: Record<string, CollectorCredentialEntry>,
  params: {
    credentialRef: string;
    connector: CollectorConnector;
    tenantId: string;
    resourceId: string;
    sourceResourceId: string;
  }
): CollectorCredentialResolution {
  const entry = credentialsMap[params.credentialRef.trim()];
  if (!entry) {
    return {
      ok: false,
      errorClass: "credential_unconfigured",
      reason: `Collector credential '${params.credentialRef}' is not configured on server`,
    };
  }

  const connectorMatches =
    (params.connector === "gsc" && (entry.kind === "gsc_service_account" || entry.kind === "gsc_oauth_refresh")) ||
    (params.connector === "bing_webmaster" && entry.kind === "bing_api_key");
  if (!connectorMatches) {
    return {
      ok: false,
      errorClass: "credential_connector_mismatch",
      reason: `Credential '${params.credentialRef}' does not match connector '${params.connector}'`,
    };
  }

  const resourceAllowed =
    entry.tenantId === params.tenantId &&
    Object.prototype.hasOwnProperty.call(entry.allowedProperties, params.resourceId);
  if (!resourceAllowed) {
    return {
      ok: false,
      errorClass: "credential_scope_denied",
      reason: `Credential '${params.credentialRef}' is not authorized for tenant '${params.tenantId}' resource '${params.resourceId}'`,
    };
  }

  const allowedSourceProps = entry.allowedProperties[params.resourceId];
  if (!allowedSourceProps.includes(params.sourceResourceId)) {
    return {
      ok: false,
      errorClass: "credential_scope_denied",
      reason: `Credential '${params.credentialRef}' is not authorized for provider property '${params.sourceResourceId}' on resource '${params.resourceId}'`,
    };
  }

  return { ok: true, credential: entry, secretsToRedact: extractCredentialSecrets(entry) };
}

/**
 * Strip any known secrets (raw & URL-encoded), Bearer tokens, PEM blocks, and apikey query params from diagnostic text.
 */
export function redactCollectorSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = String(text || "");
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 6) {
      out = out.split(secret).join("[REDACTED]");
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) {
        out = out.split(encoded).join("[REDACTED]");
      }
    }
  }
  out = out.replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, "[REDACTED_PEM]");
  out = out.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]");
  out = out.replace(/([?&](?:apikey|api_key|access_token|refresh_token|client_secret)=)[^&\s]+/gi, "$1[REDACTED]");
  if (out.length > 500) {
    out = out.slice(0, 500);
  }
  return out;
}
