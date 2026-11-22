# Measurement Pod (`measurement-pod`)

Autonomous low-frequency measurement and evidence worker pod built on `@futr-work/pod-kernel` (Cloudflare Workers + D1 / local SQLite via `PodStorage`), implementing:

- **Typed 4-family normalized schema** (`schema.sql`): Site/SEO, Analytics (with numerator, eligible denominator, and exclusions), Paid-Ad Spend (exact canonical decimal strings — never binary float — plus currency, billing timezone, gross/net, refunds/credits/taxes, and separate collection request budget), and Server Telemetry rollups (CPU gauge with explicit reducer + cumulative counter with reset semantics).
- **Immutable safe evidence handles**: stores URI pointers, SHA-256 digests, media types, privacy/retention classes, and adapter provenance without leaking raw payload bytes or credentials.
- **Explicit coverage & reconciliation**: `planned`, `attempted`, `successful`, `zero`, `partial`, `failed`, `blocked`, `not-collected`, and `stale`. Missing never synthesizes zero.
- **Fail-closed scoped-caller isolation**: shared `authGate` for cockpit/mesh routes plus SHA-256 fingerprint scoped caller grants (`SCOPED_CALLER_GRANTS`) across REST, MCP v2, and Code Mode.
- **Cloudflare MCP v2 (`2026-07-28`) + Code Mode (`search` / `execute`)**: supports stateless `server/discover`, `Mcp-Method`/`Mcp-Name` header validation, isolated JSON-RPC batches, `io.modelcontextprotocol/tasks`, `resources/*`, and sandboxed `pod.*` queries.
- **Worldview-ready projection**: deterministic `entity_urn` (`<resourceType>:<tenantId>:<resourceId>`), non-causal work annotations (`ms_annotations`), and monotonic cursor delta feed (`GET /api/measurement/events?since_cursor=...`).

## Quickstart

```bash
npm run check
npm test
npm run smoke:runtime
```

## Endpoints

| Endpoint | Auth | Purpose |
| :--- | :--- | :--- |
| `GET /health` | Open | Liveness probe (no tenant data) |
| `POST /api/measurement/resources` | Scoped `write` | Register/update tenant resource + `entity_urn` |
| `POST /api/measurement/definitions` | Scoped `write` (`*`) | Define versioned metric semantics |
| `POST /api/measurement/runs` | Scoped `write` | Idempotent run creation |
| `POST /api/measurement/runs/:runId/attempts` | Scoped `write` | Record attempt & checkpoint cursor |
| `POST /api/measurement/ingest` | Scoped `write` | Atomic evidence + observations + coverage ingest |
| `POST /api/measurement/annotations` | Scoped `write` | Non-causal work/deploy annotation |
| `GET /api/measurement/runs/:runId` | Scoped `read` | Inspect run and attempt history |
| `GET /api/measurement/series` | Scoped `read` | Query compatible revisioned series + correction lineage |
| `GET /api/measurement/coverage` | Scoped `read` | Coverage, lag, freshness & reconciliation matrix |
| `GET /api/measurement/evidence/:evidenceId` | Scoped `read` | Safe immutable evidence metadata (never raw bytes) |
| `GET /api/measurement/events` | Scoped `read` | Worldview-ready monotonic cursor delta feed |
| `GET/POST /mcp` | Hub or Scoped | Stateless MCP v2 (`2026-07-28`) + Code Mode (`search`/`execute`) |
| `GET /` | `authGate` | Dark-mode operator Cockpit UI |
