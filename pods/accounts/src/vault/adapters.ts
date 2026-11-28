import type { VaultDriver } from "../types.js";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ParsedVaultUri {
  raw: string;
  backendId: string;
  locator: string;
  segments: string[];
  fragment: string | null;
}

export interface ResolvedSecret {
  value: string;
  driver: VaultDriver;
  backendId: string;
  version?: string;
}

export interface VaultHealthResult {
  ok: boolean;
  driver: VaultDriver;
  backendId: string;
  detail?: string;
}

export interface VaultAdapter {
  readonly driver: VaultDriver;
  readonly backendId: string;
  resolveSecret(vaultUri: string, opts?: { signal?: AbortSignal }): Promise<ResolvedSecret>;
  putSecret?(vaultUri: string, value: string, opts?: { signal?: AbortSignal }): Promise<void>;
  healthCheck(opts?: { signal?: AbortSignal }): Promise<VaultHealthResult>;
}

const MAX_VAULT_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_VAULT_TIMEOUT_MS = 10_000;

export const FORBIDDEN_IDENTIFIER_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const FORBIDDEN_SECRET_FIELD_RE =
  /(?:^|_|-)(?:secret|password|passwd|token|private.?key|api.?key|credential|auth.?header|cookie|session.?id|access.?key|refresh.?token|bearer)(?:$|_|-)|(?:secret|password|passwd|token|privatekey|apikey|credential)/i;

const PEM_PRIVATE_KEY_RE = /-----BEGIN\s+[A-Z0-9 ]*PRIVATE KEY-----/;
const BITWARDEN_CIPHERTEXT_RE =
  /^(?:[0-2]\.[A-Za-z0-9+/=]{4,}\|[A-Za-z0-9+/=]{4,}(?:\|[A-Za-z0-9+/=]{4,})?|[3-6]\.[A-Za-z0-9+/=]{4,}(?:\|[A-Za-z0-9+/=]{4,})?)$/;
const CREDENTIAL_QUERY_RE =
  /[?&](?:apikey|api_key|access_token|refresh_token|client_secret|token|password|passwd|secret)=[^&\s#]+/i;
const CREDENTIAL_USERINFO_RE = /[a-z][a-z0-9+.-]*:\/\/[^/\s@]+:[^/\s@]+@/i;
const VAULT_SEGMENT_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const VAULT_FRAGMENT_RE = /^[A-Za-z0-9._-]{1,64}$/;

const RESERVED_OAUTH_PARAMS = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = String(text || "");
  const variants = new Set<string>();
  for (const s of knownSecrets) {
    if (typeof s !== "string") continue;
    if (s.length > 0) variants.add(s);
    const trimmed = s.trim();
    if (trimmed.length > 0) variants.add(trimmed);
  }
  // Redact longest secrets first so shorter substrings do not leave partial fragments
  const ordered = [...variants].sort((a, b) => b.length - a.length);
  for (const secret of ordered) {
    out = out.split(secret).join("[REDACTED]");
    const enc = encodeURIComponent(secret);
    if (enc !== secret) out = out.split(enc).join("[REDACTED]");
  }
  out = out.replace(/-----BEGIN\s+[A-Z0-9 ]*-----[\s\S]*?-----END\s+[A-Z0-9 ]*-----/g, "[REDACTED_PEM]");
  out = out.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]");
  out = out.replace(/([?&](?:apikey|api_key|access_token|refresh_token|client_secret|token)=)[^&\s]+/gi, "$1[REDACTED]");
  return out.length > 500 ? out.slice(0, 500) : out;
}

/**
 * Recursively reject embedded credentials, secret-named keys, prototype keys, or PEM private keys
 * across ANY string, array, or object persisted into D1.
 */
export function assertNoEmbeddedSecretPayload(value: unknown, _path = "$"): void {
  if (typeof value === "string") {
    if (PEM_PRIVATE_KEY_RE.test(value)) {
      throw new Error("Embedded PEM private key material is forbidden");
    }
    if (/\bBearer\s+\S+/i.test(value)) {
      throw new Error("Embedded Bearer credential is forbidden");
    }
    if (CREDENTIAL_QUERY_RE.test(value)) {
      throw new Error("Embedded credential query parameter is forbidden");
    }
    if (CREDENTIAL_USERINFO_RE.test(value)) {
      throw new Error("Embedded URL credential userinfo is forbidden");
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoEmbeddedSecretPayload(value[i]);
    }
    return;
  }
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_IDENTIFIER_KEYS.has(key)) {
      throw new Error("Forbidden object key detected");
    }
    if (FORBIDDEN_SECRET_FIELD_RE.test(key)) {
      throw new Error("Embedded secret field is forbidden");
    }
    assertNoEmbeddedSecretPayload(val);
  }
}

/**
 * Parse and strictly validate a vault-agnostic pointer URI:
 *   vault://<backendId>/<segment1>[/<segment2>...][#<fieldLabel>]
 */
export function parseVaultUri(rawUri: string): ParsedVaultUri {
  if (!isNonEmptyString(rawUri)) {
    throw new Error("vaultUri must be a non-empty string");
  }
  if (rawUri !== rawUri.trim() || /[\s\r\n\0]/.test(rawUri)) {
    throw new Error("vaultUri must not contain whitespace or control characters");
  }
  if (rawUri.includes("*") || rawUri.includes("?") || rawUri.includes("=")) {
    throw new Error("vaultUri must not contain wildcards, query strings, or key=value pairs");
  }
  if (!rawUri.startsWith("vault://")) {
    throw new Error("vaultUri must use the vault:// scheme");
  }
  const withoutScheme = rawUri.slice("vault://".length);
  const hashIdx = withoutScheme.indexOf("#");
  const pathPart = hashIdx >= 0 ? withoutScheme.slice(0, hashIdx) : withoutScheme;
  const fragment = hashIdx >= 0 ? withoutScheme.slice(hashIdx + 1) : null;
  if (hashIdx >= 0) {
    if (!fragment || !VAULT_FRAGMENT_RE.test(fragment) || FORBIDDEN_IDENTIFIER_KEYS.has(fragment)) {
      throw new Error("vaultUri fragment must be a simple field identifier");
    }
  }
  const slashIdx = pathPart.indexOf("/");
  if (slashIdx <= 0) {
    throw new Error("vaultUri must be formatted as vault://<backendId>/<locator>");
  }
  const backendId = pathPart.slice(0, slashIdx);
  const locator = pathPart.slice(slashIdx + 1);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(backendId) || FORBIDDEN_IDENTIFIER_KEYS.has(backendId)) {
    throw new Error("vaultUri contains an invalid backendId");
  }
  if (!locator || locator.startsWith("/") || locator.endsWith("/")) {
    throw new Error("vaultUri locator must be a clean slash-delimited path");
  }
  const segments = locator.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === ".." || !VAULT_SEGMENT_RE.test(seg) || FORBIDDEN_IDENTIFIER_KEYS.has(seg)) {
      throw new Error("vaultUri contains an invalid path segment");
    }
  }
  return { raw: rawUri, backendId, locator, segments, fragment };
}

function validateVaultEndpointUrl(
  rawUrl: string,
  opts: { allowLoopbackHttp?: boolean; allowedHosts?: readonly string[]; preserveExactPath?: boolean } = {}
): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Endpoint URL is invalid");
  }
  const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(opts.allowLoopbackHttp && parsed.protocol === "http:" && isLoopback)) {
    throw new Error("Endpoint URL must use https://");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Endpoint URL must not include credentials, query, or fragment");
  }
  if (opts.allowedHosts && opts.allowedHosts.length > 0 && !opts.allowedHosts.includes(parsed.hostname)) {
    throw new Error("Endpoint URL host is not allowlisted");
  }
  return opts.preserveExactPath ? rawUrl.trim() : parsed.toString().replace(/\/+$/, "");
}

async function fetchBoundedVaultJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  knownSecrets: readonly string[],
  opts: { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<{ status: number; ok: boolean; json: any }> {
  const maxBytes = opts.maxBytes ?? MAX_VAULT_RESPONSE_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, { ...init, redirect: "manual", signal: controller.signal });
    if (resp.status >= 300 && resp.status < 400) {
      await resp.body?.cancel?.().catch(() => {});
      throw new Error(`Vault HTTP redirect blocked (HTTP ${resp.status})`);
    }
    let text = "";
    if (resp.body && typeof resp.body.getReader === "function") {
      const reader = resp.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            controller.abort();
            throw new Error(`Vault response exceeded ${maxBytes}-byte limit`);
          }
          chunks.push(value);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      text = new TextDecoder().decode(merged);
    } else {
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > maxBytes) {
        throw new Error(`Vault response exceeded ${maxBytes}-byte limit`);
      }
      text = new TextDecoder().decode(buf);
    }
    let json: any = null;
    if (text.trim().length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: resp.status, ok: resp.ok, json };
  } catch (err: any) {
    throw new Error(redactSecrets(err?.message || String(err), knownSecrets));
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * 1. Infisical HTTP API VaultAdapter
 * URI format: vault://<backendId>/<folderPath...>/<SECRET_NAME>
 */
export class InfisicalVaultAdapter implements VaultAdapter {
  public readonly driver: VaultDriver = "infisical";
  public readonly backendId: string;
  private readonly baseUrl: string;
  private readonly projectId: string;
  private readonly environment: string;
  private readonly bearerToken: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: {
    backendId: string;
    baseUrl?: string;
    projectId: string;
    environment: string;
    bearerToken: string;
    fetchImpl?: FetchLike;
    allowLoopbackHttp?: boolean;
  }) {
    this.backendId = opts.backendId;
    this.baseUrl = validateVaultEndpointUrl(opts.baseUrl || "https://app.infisical.com", {
      allowLoopbackHttp: opts.allowLoopbackHttp,
    });
    if (!isNonEmptyString(opts.projectId) || !isNonEmptyString(opts.environment) || !isNonEmptyString(opts.bearerToken)) {
      throw new Error("InfisicalVaultAdapter requires projectId, environment, and bearerToken");
    }
    this.projectId = opts.projectId.trim();
    this.environment = opts.environment.trim();
    this.bearerToken = opts.bearerToken.trim();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public async resolveSecret(vaultUri: string, opts?: { signal?: AbortSignal }): Promise<ResolvedSecret> {
    const parsed = parseVaultUri(vaultUri);
    if (parsed.backendId !== this.backendId) {
      throw new Error("Vault URI backend does not match adapter");
    }
    const secretName = parsed.segments[parsed.segments.length - 1];
    const secretPath = parsed.segments.length > 1 ? `/${parsed.segments.slice(0, -1).join("/")}` : "/";
    const url =
      `${this.baseUrl}/api/v3/secrets/raw/${encodeURIComponent(secretName)}` +
      `?workspaceId=${encodeURIComponent(this.projectId)}` +
      `&environment=${encodeURIComponent(this.environment)}` +
      `&secretPath=${encodeURIComponent(secretPath)}`;

    const res = await fetchBoundedVaultJson(
      this.fetchImpl,
      url,
      { method: "GET", headers: { Authorization: `Bearer ${this.bearerToken}`, Accept: "application/json" } },
      [this.bearerToken],
      { signal: opts?.signal }
    );
    if (!res.ok) {
      throw new Error(`Infisical secret lookup failed (HTTP ${res.status})`);
    }
    const secretValue = res.json?.secret?.secretValue;
    if (!isNonEmptyString(secretValue)) {
      throw new Error("Infisical response omitted secretValue");
    }
    return {
      value: secretValue,
      driver: this.driver,
      backendId: this.backendId,
      version: res.json?.secret?.version !== undefined ? String(res.json.secret.version) : undefined,
    };
  }

  public async putSecret(vaultUri: string, value: string, opts?: { signal?: AbortSignal }): Promise<void> {
    const parsed = parseVaultUri(vaultUri);
    if (parsed.backendId !== this.backendId) {
      throw new Error("Vault URI backend does not match adapter");
    }
    const secretName = parsed.segments[parsed.segments.length - 1];
    const secretPath = parsed.segments.length > 1 ? `/${parsed.segments.slice(0, -1).join("/")}` : "/";
    const url = `${this.baseUrl}/api/v3/secrets/raw/${encodeURIComponent(secretName)}`;
    const res = await fetchBoundedVaultJson(
      this.fetchImpl,
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.bearerToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          workspaceId: this.projectId,
          environment: this.environment,
          secretPath,
          secretValue: value,
          type: "shared",
        }),
      },
      [this.bearerToken, value],
      { signal: opts?.signal }
    );
    if (!res.ok) {
      throw new Error(`Infisical secret write failed (HTTP ${res.status})`);
    }
  }

  public async healthCheck(opts?: { signal?: AbortSignal }): Promise<VaultHealthResult> {
    const url =
      `${this.baseUrl}/api/v3/secrets/raw` +
      `?workspaceId=${encodeURIComponent(this.projectId)}&environment=${encodeURIComponent(this.environment)}&secretPath=%2F`;
    try {
      const res = await fetchBoundedVaultJson(
        this.fetchImpl,
        url,
        { method: "GET", headers: { Authorization: `Bearer ${this.bearerToken}`, Accept: "application/json" } },
        [this.bearerToken],
        { signal: opts?.signal }
      );
      return { ok: res.ok, driver: this.driver, backendId: this.backendId, detail: `HTTP ${res.status}` };
    } catch (err: any) {
      return { ok: false, driver: this.driver, backendId: this.backendId, detail: redactSecrets(err?.message || String(err), [this.bearerToken]) };
    }
  }
}

/**
 * 2. 1Password Connect Server VaultAdapter
 * URI format: vault://<backendId>/<vaultId>/<itemId>[#<fieldLabel>]
 */
export class OnePasswordConnectVaultAdapter implements VaultAdapter {
  public readonly driver: VaultDriver = "onepassword_connect";
  public readonly backendId: string;
  private readonly connectUrl: string;
  private readonly connectToken: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: {
    backendId: string;
    connectUrl: string;
    connectToken: string;
    fetchImpl?: FetchLike;
    allowLoopbackHttp?: boolean;
  }) {
    this.backendId = opts.backendId;
    this.connectUrl = validateVaultEndpointUrl(opts.connectUrl, { allowLoopbackHttp: opts.allowLoopbackHttp });
    if (!isNonEmptyString(opts.connectToken)) {
      throw new Error("OnePasswordConnectVaultAdapter requires connectToken");
    }
    this.connectToken = opts.connectToken.trim();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public async resolveSecret(vaultUri: string, opts?: { signal?: AbortSignal }): Promise<ResolvedSecret> {
    const parsed = parseVaultUri(vaultUri);
    if (parsed.backendId !== this.backendId) {
      throw new Error("Vault URI backend does not match adapter");
    }
    if (parsed.segments.length < 2) {
      throw new Error("1Password vaultUri must be formatted as vault://<backendId>/<vaultId>/<itemId>[#<field>]");
    }
    const [vaultId, itemId] = parsed.segments;
    const fieldName = parsed.fragment || "credential";
    const url = `${this.connectUrl}/v1/vaults/${encodeURIComponent(vaultId)}/items/${encodeURIComponent(itemId)}`;
    const res = await fetchBoundedVaultJson(
      this.fetchImpl,
      url,
      { method: "GET", headers: { Authorization: `Bearer ${this.connectToken}`, Accept: "application/json" } },
      [this.connectToken],
      { signal: opts?.signal }
    );
    if (!res.ok) {
      throw new Error(`1Password Connect lookup failed (HTTP ${res.status})`);
    }
    const fields = Array.isArray(res.json?.fields) ? res.json.fields : [];
    const match =
      fields.find((f: any) => f && (f.label === fieldName || f.id === fieldName)) ??
      (!parsed.fragment ? fields.find((f: any) => f && (f.label === "password" || f.purpose === "PASSWORD")) : null);
    if (!match || !isNonEmptyString(match.value)) {
      throw new Error("1Password item did not contain requested non-empty field");
    }
    return {
      value: match.value,
      driver: this.driver,
      backendId: this.backendId,
      version: res.json?.version !== undefined ? String(res.json.version) : undefined,
    };
  }

  public async healthCheck(opts?: { signal?: AbortSignal }): Promise<VaultHealthResult> {
    try {
      const res = await fetchBoundedVaultJson(
        this.fetchImpl,
        `${this.connectUrl}/v1/vaults`,
        { method: "GET", headers: { Authorization: `Bearer ${this.connectToken}`, Accept: "application/json" } },
        [this.connectToken],
        { signal: opts?.signal }
      );
      return { ok: res.ok, driver: this.driver, backendId: this.backendId, detail: `HTTP ${res.status}` };
    } catch (err: any) {
      return { ok: false, driver: this.driver, backendId: this.backendId, detail: redactSecrets(err?.message || String(err), [this.connectToken]) };
    }
  }
}

/**
 * 3. LastPass Trusted Bridge VaultAdapter
 * URI format: vault://<backendId>/<itemLocator>[#<field>]
 */
export class LastPassVaultAdapter implements VaultAdapter {
  public readonly driver: VaultDriver = "lastpass";
  public readonly backendId: string;
  private readonly bridgeUrl: string;
  private readonly authToken: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: {
    backendId: string;
    bridgeUrl: string;
    authToken: string;
    fetchImpl?: FetchLike;
    allowLoopbackHttp?: boolean;
  }) {
    this.backendId = opts.backendId;
    this.bridgeUrl = validateVaultEndpointUrl(opts.bridgeUrl, { allowLoopbackHttp: opts.allowLoopbackHttp });
    if (!isNonEmptyString(opts.authToken)) {
      throw new Error("LastPassVaultAdapter requires authToken");
    }
    this.authToken = opts.authToken.trim();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public async resolveSecret(vaultUri: string, opts?: { signal?: AbortSignal }): Promise<ResolvedSecret> {
    const parsed = parseVaultUri(vaultUri);
    if (parsed.backendId !== this.backendId) {
      throw new Error("Vault URI backend does not match adapter");
    }
    const field = parsed.fragment || "password";
    const url = `${this.bridgeUrl}/v1/items/${encodeURIComponent(parsed.locator)}?field=${encodeURIComponent(field)}`;
    const res = await fetchBoundedVaultJson(
      this.fetchImpl,
      url,
      { method: "GET", headers: { Authorization: `Bearer ${this.authToken}`, Accept: "application/json" } },
      [this.authToken],
      { signal: opts?.signal }
    );
    if (!res.ok) {
      throw new Error(`LastPass lookup failed (HTTP ${res.status})`);
    }
    if (!isNonEmptyString(res.json?.value)) {
      throw new Error("LastPass response omitted secret value");
    }
    return { value: res.json.value, driver: this.driver, backendId: this.backendId };
  }

  public async healthCheck(opts?: { signal?: AbortSignal }): Promise<VaultHealthResult> {
    try {
      const res = await fetchBoundedVaultJson(
        this.fetchImpl,
        `${this.bridgeUrl}/v1/health`,
        { method: "GET", headers: { Authorization: `Bearer ${this.authToken}`, Accept: "application/json" } },
        [this.authToken],
        { signal: opts?.signal }
      );
      return { ok: res.ok, driver: this.driver, backendId: this.backendId, detail: `HTTP ${res.status}` };
    } catch (err: any) {
      return { ok: false, driver: this.driver, backendId: this.backendId, detail: redactSecrets(err?.message || String(err), [this.authToken]) };
    }
  }
}

/**
 * 4. Bitwarden Secrets Manager Trusted Decryption Bridge VaultAdapter
 * Note: Raw Bitwarden API `/secrets/{id}` returns end-to-end encrypted ciphertexts (`2.<iv>|<ct>|<mac>`)
 * requiring the official Bitwarden SDK + organization key to decrypt. This adapter talks to a trusted
 * SDK-backed decryption bridge (`bridgeUrl/v1/secrets/{id}` returning `{ value, decrypted: true }`) and
 * fails closed if an encrypted Bitwarden CipherString is ever returned.
 */
export class BitwardenVaultAdapter implements VaultAdapter {
  public readonly driver: VaultDriver = "bitwarden";
  public readonly backendId: string;
  private readonly bridgeUrl: string;
  private readonly accessToken: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: {
    backendId: string;
    bridgeUrl: string;
    accessToken: string;
    fetchImpl?: FetchLike;
    allowLoopbackHttp?: boolean;
  }) {
    this.backendId = opts.backendId;
    this.bridgeUrl = validateVaultEndpointUrl(opts.bridgeUrl, { allowLoopbackHttp: opts.allowLoopbackHttp });
    if (!isNonEmptyString(opts.accessToken)) {
      throw new Error("BitwardenVaultAdapter requires accessToken");
    }
    this.accessToken = opts.accessToken.trim();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public async resolveSecret(vaultUri: string, opts?: { signal?: AbortSignal }): Promise<ResolvedSecret> {
    const parsed = parseVaultUri(vaultUri);
    if (parsed.backendId !== this.backendId) {
      throw new Error("Vault URI backend does not match adapter");
    }
    const secretId = parsed.segments[parsed.segments.length - 1];
    const url = `${this.bridgeUrl}/v1/secrets/${encodeURIComponent(secretId)}`;
    const res = await fetchBoundedVaultJson(
      this.fetchImpl,
      url,
      { method: "GET", headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" } },
      [this.accessToken],
      { signal: opts?.signal }
    );
    if (!res.ok) {
      throw new Error(`Bitwarden bridge lookup failed (HTTP ${res.status})`);
    }
    if (res.json?.decrypted !== true || !isNonEmptyString(res.json?.value)) {
      throw new Error("Bitwarden bridge response must provide a decrypted plaintext value");
    }
    if (BITWARDEN_CIPHERTEXT_RE.test(res.json.value.trim())) {
      throw new Error("Bitwarden bridge returned undecrypted CipherString envelope");
    }
    return { value: res.json.value, driver: this.driver, backendId: this.backendId };
  }

  public async healthCheck(opts?: { signal?: AbortSignal }): Promise<VaultHealthResult> {
    try {
      const res = await fetchBoundedVaultJson(
        this.fetchImpl,
        `${this.bridgeUrl}/v1/health`,
        { method: "GET", headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" } },
        [this.accessToken],
        { signal: opts?.signal }
      );
      return { ok: res.ok, driver: this.driver, backendId: this.backendId, detail: `HTTP ${res.status}` };
    } catch (err: any) {
      return { ok: false, driver: this.driver, backendId: this.backendId, detail: redactSecrets(err?.message || String(err), [this.accessToken]) };
    }
  }
}

/**
 * 5. Cloudflare Worker Secret Binding VaultAdapter
 * URI format: vault://<backendId>/<key>[#<nestedField>]
 */
export class CloudflareSecretVaultAdapter implements VaultAdapter {
  public readonly driver: VaultDriver = "cf_secret";
  public readonly backendId: string;
  private readonly secretsMap: Record<string, unknown>;

  constructor(opts: { backendId: string; rawJson: string }) {
    this.backendId = opts.backendId;
    let parsed: unknown;
    try {
      parsed = JSON.parse(opts.rawJson || "{}");
    } catch {
      throw new Error("CloudflareSecretVaultAdapter requires valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("CloudflareSecretVaultAdapter JSON must be an object map");
    }
    this.secretsMap = Object.assign(Object.create(null), parsed);
  }

  public async resolveSecret(vaultUri: string): Promise<ResolvedSecret> {
    const parsed = parseVaultUri(vaultUri);
    if (parsed.backendId !== this.backendId) {
      throw new Error("Vault URI backend does not match adapter");
    }
    const entry = Object.prototype.hasOwnProperty.call(this.secretsMap, parsed.locator)
      ? this.secretsMap[parsed.locator]
      : undefined;
    if (entry === undefined || entry === null) {
      throw new Error("Secret locator not found in Cloudflare secret binding");
    }
    if (parsed.fragment) {
      if (typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Secret locator is not an object for requested fragment");
      }
      const nested = Object.prototype.hasOwnProperty.call(entry, parsed.fragment)
        ? (entry as Record<string, unknown>)[parsed.fragment]
        : undefined;
      if (!isNonEmptyString(nested)) {
        throw new Error("Secret fragment is missing or empty");
      }
      return { value: nested, driver: this.driver, backendId: this.backendId };
    }
    const value = typeof entry === "string" ? entry : JSON.stringify(entry);
    if (!isNonEmptyString(value)) {
      throw new Error("Secret locator is empty");
    }
    return { value, driver: this.driver, backendId: this.backendId };
  }

  public async healthCheck(): Promise<VaultHealthResult> {
    return {
      ok: true,
      driver: this.driver,
      backendId: this.backendId,
      detail: `${Object.keys(this.secretsMap).length} entries bound`,
    };
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function createPkcePair(): Promise<{ codeVerifier: string; codeChallenge: string; method: "S256" }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const codeVerifier = base64UrlEncode(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)));
  return { codeVerifier, codeChallenge: base64UrlEncode(digest), method: "S256" };
}

export function buildOAuthAuthorizeUrl(params: {
  authorizeEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  extraParams?: Record<string, string>;
}): string {
  const endpoint = validateVaultEndpointUrl(params.authorizeEndpoint, { preserveExactPath: true });
  const redirect = validateVaultEndpointUrl(params.redirectUri, { allowLoopbackHttp: true, preserveExactPath: true });
  if (!isNonEmptyString(params.clientId) || !isNonEmptyString(params.state) || !isNonEmptyString(params.codeChallenge)) {
    throw new Error("OAuth authorize URL requires clientId, state, and codeChallenge");
  }
  const url = new URL(endpoint);
  if (params.extraParams) {
    for (const [k, v] of Object.entries(params.extraParams)) {
      if (RESERVED_OAUTH_PARAMS.has(k.toLowerCase())) {
        throw new Error(`extraParams must not override reserved OAuth parameter '${k}'`);
      }
      if (isNonEmptyString(k) && isNonEmptyString(v)) {
        url.searchParams.set(k, v);
      }
    }
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId.trim());
  url.searchParams.set("redirect_uri", redirect);
  if (params.scopes.length > 0) {
    url.searchParams.set("scope", params.scopes.join(" "));
  }
  url.searchParams.set("state", params.state.trim());
  url.searchParams.set("code_challenge", params.codeChallenge.trim());
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export class VaultAdapterRegistry {
  private readonly adapters = new Map<string, VaultAdapter>();

  public register(adapter: VaultAdapter): this {
    if (!isNonEmptyString(adapter.backendId) || FORBIDDEN_IDENTIFIER_KEYS.has(adapter.backendId)) {
      throw new Error("Invalid VaultAdapter backendId");
    }
    this.adapters.set(adapter.backendId, adapter);
    return this;
  }

  public get(backendId: string): VaultAdapter | undefined {
    return this.adapters.get(backendId);
  }

  public listBackendIds(): string[] {
    return [...this.adapters.keys()].sort();
  }

  public async resolve(vaultUri: string, opts?: { fallbackVaultUri?: string | null; signal?: AbortSignal }): Promise<ResolvedSecret> {
    const primary = parseVaultUri(vaultUri);
    const primaryAdapter = this.adapters.get(primary.backendId);
    if (primaryAdapter) {
      try {
        return await primaryAdapter.resolveSecret(primary.raw, { signal: opts?.signal });
      } catch (primaryErr) {
        if (opts?.fallbackVaultUri) {
          const fb = parseVaultUri(opts.fallbackVaultUri);
          const fbAdapter = this.adapters.get(fb.backendId);
          if (fbAdapter) {
            return await fbAdapter.resolveSecret(fb.raw, { signal: opts?.signal });
          }
        }
        throw primaryErr;
      }
    }
    if (opts?.fallbackVaultUri) {
      const fb = parseVaultUri(opts.fallbackVaultUri);
      const fbAdapter = this.adapters.get(fb.backendId);
      if (fbAdapter) {
        return await fbAdapter.resolveSecret(fb.raw, { signal: opts?.signal });
      }
    }
    throw new Error("No vault adapter registered for requested backend");
  }
}
