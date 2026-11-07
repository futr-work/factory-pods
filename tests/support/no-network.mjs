// Test preload: pod tests must be hermetic. Every global fetch fails immediately with a clear message,
// loopback included, so a test can never reach a live hub, Orrery, provider, or a dev server the operator
// happens to be running on :8787/:4950. Tests that need a response inject a fetcher or service binding,
// or assign globalThis.fetch for the duration of the test.
globalThis.fetch = function guardedFetch(input) {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return Promise.reject(new TypeError(`network disabled in tests: ${raw}`));
};
