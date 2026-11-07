// Test preload for packages that start their own loopback server (kernel MCP contract test): non-loopback
// fetches fail immediately. Pods use no-network.mjs, which also blocks loopback.
const realFetch = globalThis.fetch;
const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

globalThis.fetch = function guardedFetch(input, init) {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let host = "";
  try { host = new URL(raw).hostname; } catch { /* relative URL: the real fetch rejects it */ }
  if (host && !loopback.has(host)) return Promise.reject(new TypeError(`network disabled in tests: ${raw}`));
  return realFetch(input, init);
};
