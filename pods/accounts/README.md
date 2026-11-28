# `accounts-pod` — Vault-Agnostic Account, Connection & Asset Ownership Registry

Autonomous edge pod for eliminating "account blindness" across multi-account, multi-provider, multi-agent portfolios.

## Design Principles

- **Zero raw secrets in D1 or Git**: Stores only the structured ownership graph (`Principals → Provider Accounts → Connections → Assets & Bindings`) plus non-secret `vault://<backendId>/<locator>` pointers.
- **Pluggable secret backends**: Swap connections between `infisical`, `onepassword_connect`, `lastpass`, `bitwarden`, `cf_secret`, and `oauth_broker` via one atomic `switch-vault` call without modifying consumer pods.
- **Canonical ownership & overlap tracking**: Database-enforced unique canonical binding per `(tenant, asset, provider)`, while preserving every discovered secondary/overlapping account so dual-account conflicts and missing grants are visible instead of silently overwritten.
- **Scoped caller authorization**: Enforces `SCOPED_CALLER_GRANTS` (SHA-256 token hashes + explicit tenant/resource/action grants) across both HTTP `/api/accounts/*` and MCP v2 + Code Mode (`acc_*` tools).

## Quickstart

```bash
npm install
npm run check
npm test
npm run dev
```

## Endpoints

- `GET /health` — open liveness probe
- `GET /` — dark-mode operator cockpit (`FACTORY_HUB_TOKEN`)
- `POST /mcp` — MCP 2026-07-28 + Code Mode (`acc_who_owns`, `acc_query_matrix`, `acc_overlaps_and_gaps`, `acc_upsert_binding`, `acc_switch_vault`, `acc_ingest_discovery`)
- `GET/POST /api/accounts/vault-backends`
- `GET/POST /api/accounts/principals`
- `GET/POST /api/accounts/provider-accounts`
- `GET/POST /api/accounts/connections` and `POST /api/accounts/connections/:id/switch-vault`
- `GET/POST /api/accounts/assets`
- `POST /api/accounts/bindings` and `POST /api/accounts/bindings/:id/canonical`
- `POST /api/accounts/discover`
- `GET /api/accounts/who-owns?tenantId=...&assetId=...`
- `GET /api/accounts/matrix?tenantId=...`
- `GET /api/accounts/overlaps-and-gaps?tenantId=...`
- `GET /api/accounts/audit?tenantId=...`
