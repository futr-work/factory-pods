# Model Governor Pod

> Edge-native AI model router, rate-limit failover engine, and cost-optimization sentinel on Cloudflare Workers + D1.

The **Model Governor Pod** provides intelligent, low-latency LLM routing across multiple providers (OpenRouter, Cloudflare Workers AI, Anthropic, OpenAI). It monitors model availability, intercepts HTTP 429 rate limits, and automatically fails over to pre-qualified fallback models. Failover latency has not been benchmarked.

---

## 🏗️ Architecture

```
                       Inbound Request
                (Task Prompt / Inference Query)
                               │
                               ▼
 ┌─────────────────────────────────────────────────────────────┐
 │           Model Governor Pod (Cloudflare Worker)            │
 │                                                             │
 │   ┌─────────────────┐       ┌───────────────────────────┐   │
 │   │  Live Routing   │       │  Honest Catalog Probing   │   │
 │   │  API (/route)   │       │  (Deterministic Rubric)   │   │
 │   └────────┬────────┘       └─────────────┬─────────────┘   │
 │            │                              │                 │
 │            ▼                              ▼                 │
 │   ┌─────────────────────────────────────────────────────┐   │
 │   │      Fastest / Lowest Cost Qualified Model          │   │
 │   │      (Fallback on HTTP 429 Rate Limits)       │   │
 │   └──────────────────────────┬──────────────────────────┘   │
 │                              │                              │
 │                      ┌───────▼───────┐                      │
 │                      │ Cloudflare D1 │                      │
 │                      │ Model Catalog │                      │
 │                      └───────────────┘                      │
 └─────────────────────────────────────────────────────────────┘
```

---

## ⚡ Core Capabilities

1. **HTTP 429 Failover**:
   - Detects upstream provider throttling, outages, or credit exhaustion.
   - Instantly reroutes active requests to alternative models within the same capability tier.

2. **Honest Model Catalog**:
   - One scheduled smoke suite measures a newly discovered or materially changed model. Production receipts measure task-level performance.
   - Tracks real-time pricing and latency metrics in local SQLite D1.

3. **Daily Model Radar**:
   - Discovers new models from the OpenRouter and OrcaRouter catalogs once a day (a failed run retries hourly)
     and publishes `model.discovered` to the hub. Existing routes establish the baseline on upgrade. Subsequent
     catalog changes to model creation time, context, tool support, or tier queue one smoke suite. An explicit
     per-model admin probe can recheck an unchanged route. All Worker probe paths share `PROBE_REQUESTS_DAILY`
     (default 20 upstream requests per UTC day; 0 disables probes). Each smoke suite can use five requests.
     The independent `PROBE_BUDGET_USD_DAILY` bounds scheduled paid testing. Read authenticated
     `GET /api/governor/probe-status` for the daily request allowance, reservations, and queued changes.
     On rollout legacy suites from the current day are conservatively charged their full request count.
     An OpenRouter daily free-pool rejection suspends free OpenRouter probes and inference until UTC rollover.

4. **Daily Usage Analysis**:
   - Stores one report per UTC day of what pods actually spent: calls, failures, 429s, tokens, cost, and
     p50/p95 latency of successful calls, set beside each model's probe results.
   - Findings are rule-based and carry their numbers: high error rate, production latency far above the probe
     average, models with usage but no probe, PAID-tier calls that recorded no cost (spend the analyzer cannot
     see), and a qualified model that is at least as good and cheaper for the same tokens (an estimate from
     catalog prices, not a measured saving).
   - Publishes a `model.usage_report` summary to the hub and renders the latest report on the cockpit.

5. **Multi-Provider Agnostic Routing**:
   - Integrates with OpenRouter, Cloudflare Workers AI, local Ollama endpoints, and direct provider APIs.

---

6. **Google Gemini (direct)**:
   - With `GEMINI_API_KEY` set, discovery lists Gemini chat models from Google's OpenAI-compatible endpoint
     (`generativelanguage.googleapis.com/v1beta/openai`), and probes and inference call that endpoint directly.
   - Google publishes no prices through the API. Set `GEMINI_FREE_TIER=1` while the key is on Google's free tier:
     rows are then free (zero cost, quota-limited, 429s fall back down the chain). Without it, rows are paid with
     unknown prices and stay unprobed until priced. Override the endpoint with `GEMINI_BASE_URL`.

## 🚀 Quickstart

### 1. Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:8787` to explore the Model Governor cockpit and test real-time model routing.

### 2. Deploy to Cloudflare Workers

1. Create your dedicated D1 SQLite database:
   ```bash
   npx wrangler d1 create model-governor-pod-db
   ```
2. Paste the generated `database_id` into `wrangler.jsonc`.
3. Apply the database migrations:
   ```bash
   npx wrangler d1 execute model-governor-pod-db --local --file=schema.sql
   npx wrangler d1 execute model-governor-pod-db --remote --file=schema.sql
   ```
4. Deploy globally:
   ```bash
   npx wrangler deploy
   ```

---

## 📡 API Endpoints

### 1. Route a Model Request
```bash
curl "https://<your-pod-subdomain>.workers.dev/api/models/route?category=general_reasoning&prefer_free=true"
```

**Response** (abbreviated; `recommendedModel` is the full catalog entry, and is `null` with a `reason` and
404 when nothing in that category is qualified):

```json
{
  "recommendedModel": {
    "id": "openrouter:meta-llama/llama-3.3-70b-instruct:free",
    "provider": "openrouter",
    "modelName": "meta-llama/llama-3.3-70b-instruct:free",
    "family": "meta",
    "category": "general_reasoning",
    "tier": "FREE_TIER",
    "lifecycle": "qualified",
    "qualityScore": 100
  }
}
```

### 2. Log Telemetry
`podId` and `modelId` are required. Send `"status": "error"` or `"status": "rate_limited"` for a failed call —
that is what lets the daily analyzer measure failure and 429 rates.

```bash
curl -X POST "https://<your-pod-subdomain>.workers.dev/api/telemetry/log" \
  -H "Authorization: Bearer $FACTORY_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"podId": "pm-pod", "modelId": "openrouter:meta-llama/llama-3.3-70b-instruct:free",
       "provider": "openrouter", "promptTokens": 1200, "completionTokens": 300,
       "latencyMs": 420, "status": "success"}'
```

### 3. Governor-Mediated Inference

Pods hold no provider keys. They ask the governor, which owns the credential, picks a model it has measured
(a free/qualified one unless the caller names an approved model), records the usage, and returns the text.

```bash
curl -sS -X POST -H "Authorization: Bearer $FACTORY_HUB_TOKEN" -H "Content-Type: application/json" \
  -d '{"podId": "egm-spec-pod", "category": "coding",
       "messages": [{"role": "user", "content": "Review this diff for scope creep"}],
       "temperature": 0.2, "maxTokens": 800}' \
  https://<your-pod-subdomain>.workers.dev/api/inference
```

A catalog ID pins both provider and model. An upstream name allows any eligible provider of that exact model.
Use `auto`, `auto:<category>`, or omit `model` for automatic cross-model fallback. Empty or non-string
selectors return HTTP 400. Named requests retain the caller's budget, approval, tool and health checks.
Errors include the requested selector, a reason, and the attempted provider routes. Unknown names return
404, retired models return 409, and spent budgets blocking paid requests return 429.

## Provider keys

The governor holds the provider credentials every pod used to duplicate. `OPENROUTER_API_KEY` is set; add
`ORCAROUTER_API_KEY` (and `ORCAROUTER_BASE_URL` if it is not `https://api.orcarouter.ai/v1`) as a worker secret
to serve OrcaRouter models. Without that key, an `orcarouter` model answers `503` and routing skips the provider,
so the fleet runs on OpenRouter alone. The governor records every call either way, so a failed request stays
visible instead of disappearing.

### 4. Daily Usage Report

```bash
# Latest stored report (hub token)
curl -sS -H "Authorization: Bearer $FACTORY_HUB_TOKEN" \
  "https://<your-pod-subdomain>.workers.dev/api/governor/usage-report"
# One specific UTC day
curl -sS -H "Authorization: Bearer $FACTORY_HUB_TOKEN" \
  "https://<your-pod-subdomain>.workers.dev/api/governor/usage-report?date=2026-11-02"
# Analyze a day now (admin token); force re-analyzes a day that already has a report
curl -sS -X POST -H "Authorization: Bearer $GOVERNOR_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"date": "2026-11-02", "force": true}' \
  "https://<your-pod-subdomain>.workers.dev/api/governor/analyze"
```

Each finding names the model it concerns and the numbers behind it. Latency percentiles use successful calls
only, so a fast rejection never improves a model's record.

### 5. OpenAI-Compatible Backend for Agents (tools, streaming, budgets)

Any OpenAI client can use the governor as its model backend. Set the base URL to
`https://<your-pod-subdomain>.workers.dev/api/inference` (or `.../v1`) and the model to `auto`. The client calls
`POST {base}/chat/completions` and `GET {base}/models`.

The request body is forwarded **unchanged except `model`**. That covers `tools`, `tool_choice`,
`parallel_tool_calls`, `response_format`, array content, assistant `tool_calls`, and `tool` messages with
`tool_call_id`. The provider's JSON comes back verbatim, `choices[].message.tool_calls` and `finish_reason`
included. Response headers say what served the request: `X-Governor-Model`, `X-Governor-Tier`,
`X-Governor-Caller`, `X-Governor-Attempts`.

For named requests, the governor checks the provider's returned `model` against the selected upstream name.
A missing or different identity yields a provider error. For SSE the first data event must identify the
model before the governor opens the stream. Later events may omit the identity. A changed identity terminates
the stream before that event reaches the client. Named streams drop leading keepalive comments during
verification. The Worker requests final usage and records it in D1 before forwarding terminal events. Delivery of earlier
content streams normally. A Worker lifetime task can finish the receipt when the client stops reading.
A client cancellation during generation stops the provider reader. Once the provider finishes, the Worker
allows up to three seconds and 128 KiB for its usage trailer. Slow readers have bounded read-ahead.

A stream receipt uses the reported model, token counts and provider cost when available. With no provider
cost, the catalog supplies the price estimate. A completed stream missing final counts has status
`usage_unavailable`. An early client cancellation has status `cancelled`. Their numeric totals contain only
observed usage (zero for absent counts), so the resulting spend can understate actual provider charges.

**Auth.** Send `Authorization: Bearer <token>`, where the token is one of:

| Token | Opens |
|-------|-------|
| `GOVERNOR_CLIENT_TOKEN` (optional secret) | Only `POST /v1/chat/completions`, `/chat/completions`, `/api/inference/chat/completions` and `GET /v1/models`, `/models`, `/api/inference/models`. Give this one to outside clients. |
| `FACTORY_HUB_TOKEN` | Everything except admin routes (pods, cockpit, the legacy `/api/inference`). |
| `GOVERNOR_ADMIN_TOKEN` | Admin `POST` routes: model approval, caller policies, discovery, probes. |

A wrong or missing token is `401 {"error":"unauthorized"}`. That is also the answer when the worker has no
`FACTORY_HUB_TOKEN` at all, because it fails closed.

**Caller headers.**

| Header | Meaning |
|--------|---------|
| `X-Governor-Caller` | Who pays: `agent-<id>`, `team:<name>`, anything up to 200 chars. Usage is recorded under it (`llm_usage_events.pod_id`), and its policy and budget apply. Falls back to `podId`, then `openbot`. |
| `X-Governor-Category` | Ranking category (`general_reasoning`, `coding`, `deep_audit`, `fast_classification`). Also accepted as the body field `category` or as `model: "auto:<category>"`. |

**Routing policy.** Only qualified models are candidates: measured by probes, approved by an admin if paid, and
on an API-key provider (OpenRouter, OrcaRouter, Fireworks, Cerebras, OpenScale, Google Gemini). OAuth and
consumer-subscription logins are never called. Each model's tier comes from its catalog price:

| Tier | Models |
|------|--------|
| 0 | free (`FREE_TIER`, zero price), e.g. OpenRouter `:free` |
| 1 | paid with output price ≤ `TIER1_MAX_OUTPUT_COST_PER_1M` (default `4`), e.g. DeepSeek, GPT-OSS, Gemini Flash |
| 2 | pricier paid, or paid with an unknown price, e.g. Claude, GPT |

A caller's policy has a preferred tier, a maximum tier and a daily budget. Without a stored policy, the stored
`*` default applies, then the environment defaults (`DEFAULT_CALLER_TIER=0`, `DEFAULT_CALLER_MAX_TIER=1`,
`DEFAULT_CALLER_DAILY_BUDGET_USD=1`). Candidates are visited in this order: the preferred tier, then cheaper tiers,
then pricier tiers up to the maximum. Within a tier they rank by probe score, then price, then speed
(`fast_classification` ranks speed first). Named requests limit this order to the selected model.

On `429`, `402`, `401`/`403`, `404`/`410`, `408`, `5xx`, a network error or timeout, the next candidate is tried, up to 6.
A `402` parks the provider. An OpenRouter daily free-pool rejection pauses all OpenRouter free routes and their probes until the UTC reset. A model-specific `429` marks the affected model `rate_limited`. Any other `4xx` is the
caller's error and is returned as-is.

For callers that handle their own subscription fallback, set `GOVERNOR_QUOTA_FAILOVER_CALLERS` to their comma-separated caller IDs. A confirmed OpenRouter daily free-pool denial returns HTTP 429 with `error.type=insufficient_quota`, `error.code=free_pool_exhausted`, and `x-should-retry: false` so the client can move immediately to its next route. Transient throttles retain their usual retry behavior.

**A request with `tools` only goes to models known to support tools.** Support comes from OpenRouter's
`supported_parameters` at discovery. When a provider answers "no endpoints support tool use", the model is
marked unsupported and skipped from then on. Unknown support never qualifies a model for a tools request.

**Budgets.** Today's spend is the caller's summed `cost_usd` since 00:00 UTC. At or over the cap, paid tiers are
off for the rest of the day. Automatic requests route on tier 0. A named paid request returns a budget error. If no tier-0
model qualifies (for example, none supports tools), the answer is `429` with
`error.code = "budget_exceeded"`, `type = "insufficient_quota"`, and a message naming the spend and the cap. The
check happens before each call, so one call can overshoot the cap by its own cost.

The caller header is trusted. A client holding a token can name any caller, so per-caller caps are cost control
for cooperating callers, not a security boundary. Set `GOVERNOR_DAILY_BUDGET_USD` for a fleet-wide cap that holds
whatever caller ids a client sends. Over it, every caller is limited to tier 0 for the rest of the day.

```bash
# Set a policy (admin token). Caller "*" sets the default for callers without their own row.
curl -sS -X POST -H "Authorization: Bearer $GOVERNOR_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"preferredTier": 1, "maxTier": 2, "dailyBudgetUsd": 5, "category": "coding"}' \
  "https://<your-pod-subdomain>.workers.dev/api/governor/callers/agent-grandmaster"
# Live spend against budget per caller (hub token or admin token). Also included as callersToday in /api/governor/usage-report,
# whose report.pods[] is the per-caller breakdown for the reported day.
curl -sS -H "Authorization: Bearer $FACTORY_HUB_TOKEN" "https://<your-pod-subdomain>.workers.dev/api/governor/callers"
```

Schema: this version adds `model_catalog.supports_tools` and `caller_policies` (`migrations/0007_tools_and_caller_budgets.sql`).
The Worker also applies these additive steps to its own D1 binding on the first authenticated request
(`src/schema.ts`), so a deploy works even when the deploying credential has no D1 API permission.

## Task evidence and workflow scorecards

An operator can record evidence about completed work using `Authorization: Bearer <GOVERNOR_ADMIN_TOKEN>`. The ledger accepts human blind comparisons, independent measurements, subjective judgments, and editorial outcomes. Hub and inference client credentials cannot access either endpoint. The governor records every entry as admin-attested. A reference identifies external evidence and is never fetched by the Worker. The operator verifies its provenance and ensures a blind reviewer did not see the workflow identities.

### Record evidence

`POST /api/governor/evidence` accepts one JSON object, up to 16 KiB. The following fields are required for both kinds.

| Field | Meaning |
|---|---|
| `evidenceId` | Stable idempotency key for this observation. A first write returns 201, an identical normalized replay returns 200, and a different payload using the same ID returns 409. |
| `taskClass`, `taskRef` | Task family and original assignment ID. Reuse the task reference across retries, candidate outputs, measurements and reviews of that same assignment. |
| `briefSha256`, `rubricSha256` | Lowercase SHA-256 hex of the original brief and exact evaluation rubric. |
| `sourceRef` | Source ballot, evaluation record, or other immutable reference that the operator checked. |
| `kind` | `blind_preference` or `artifact_review`. |

A workflow artifact is an object containing `workflow` (stable workflow/version label), `receiptRef` (workflow or route execution receipt ID or immutable reference), and `artifactSha256` (exact reviewed bytes). Multi-stage work should reference a workflow receipt identifying its component routes.

For `blind_preference`, provide the two artifacts as `left` and `right` and the human `choice` of `left`, `right`, `tie`, or `abstain`. Each alternative needs its own artifact hash. Preserve the original ballot and the blinded-to-workflow mapping behind the source reference.

For `artifact_review`, provide `artifact` and at least one of these observations.

| Field | Meaning |
|---|---|
| `checks` | Up to 16 independently measured results, each with a unique `name`, boolean `passed`, and its own `measurementRef`. A deterministic timing validator is an example. |
| `judge` | Optional subjective assessment with `name`, numeric `score`, positive `maxScore`, and `receiptRef`. The judge must be distinct from the workflow it evaluates. |
| `publishApproved` | An observed boolean decision. Omitted or null means no decision was recorded. |
| `editMinutes` | Observed non-negative editing time. Zero records a measured zero. Omitted or null means unmeasured. |

### Read a scorecard

`GET /api/governor/scorecard?taskClass=editing&rubricSha256=<hash>` returns scope, totals, workflow summaries and a page of source observations. Add `briefSha256` to inspect a single brief. The receipt-time interval is `fromMs` inclusive to `toMs` exclusive, in UTC Unix milliseconds. It defaults to the last 30 days and may span up to 90. Date and scope filters have database indexes.

Both summaries and counts cover the entire selected cohort. The detail page defaults to 25 records and the workflow page defaults to 25 workflows. Set `limit` and `workflowLimit` to integers from 1 to 100. For further pages, repeat the returned scope (omit a null `briefSha256`) with `before=nextBefore` and/or `afterWorkflow=nextAfterWorkflow` for the list being advanced. A null cursor means the end of that list. Keep `asOf`, `fromMs`, and `toMs` fixed so later writes do not move the snapshot.

Each workflow summary counts original tasks, briefs, artifacts, and observations separately. Repeated comparisons on one task count once in its blind outcome. Conflicting judgments are mixed, ties and abstentions are explicit, and comparisons of two outputs of the same workflow are counted separately. Publication decisions use the same task-level treatment. Only measured editing time contributes to the mean: the scorecard averages within each task, then across observed tasks. A task passes its observed checks only when each recorded measurement passes. Subjective judge counts and raw scores are separate from measured check results.

These are outcomes for labeled work. Unlabeled traffic is outside the denominator. A multistage result describes the observed workflow as a whole. It cannot identify the contribution of one component model. The scorecard has no automatic winner or path into model qualification, pricing, routing, or budgets.

### Local tools

- [Production sampling and routing evaluation](PRODUCTION-QUALITY.md) describes an on-demand task sample and quality measures for different task families.
- [Local plan/write workflow](LOCAL-PLAN-WRITE.md) produces linked OAuth stage receipts for one explicit task.
- [Narration pacing check](PACING.md) measures one creative-production constraint before rendering.

### Empty-output recovery for local extraction jobs

A local Domain Scout run can opt in with `X-Governor-Require-Output: text`. On a completed text-only response with no visible answer, the Worker records `empty_output` and returns the usage event ID. The on-device runner checks that D1 row against the attempt before invoking an explicitly authorized subscription recovery. The OAuth credential stays on the device. A normal chat request uses the existing behavior.

See [the one-shot extraction runbook](EMPTY-RECOVERY.md) for inputs, the recovery switch, failure conditions and receipts. For authorized diagnostics, `GET /api/governor/usage-receipts?id=<event-id>` reads a single usage row by primary key and requires an admin bearer token.

For eligible named free extraction streams, the local runner can also explicitly authorize a single OAuth recovery on a governor-owned upstream deadline. See the [recovery runbook](EMPTY-RECOVERY.md). Newly generated daily usage reports expose per-route transport status counts, successful-call and all-attempt p95 latency, and counts of upstream timeouts with partial or unknown usage. Cost and token sums cannot recover a provider usage trailer that never arrived. Use task evidence and validated artifacts to compare result quality.
