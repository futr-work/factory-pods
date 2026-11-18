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
   - Automated periodic probing verifies that free/cheap models genuinely pass capability benchmarks.
   - Tracks real-time pricing and latency metrics in local SQLite D1.

3. **Daily Model Radar**:
   - Discovers new models from the OpenRouter and OrcaRouter catalogs once a day (a failed run retries hourly)
     and publishes `model.discovered` to the hub. Capability probes still run on every 5-minute tick, capped
     by `PROBE_BUDGET_USD_DAILY`.

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
verification. Automatic streams pass through byte-for-byte. The governor requests streamed usage and records
it before the stream closes.

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
on a pay-per-use API provider (OpenRouter, OrcaRouter, Fireworks, Cerebras, OpenScale). OAuth and
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
A `402` parks the provider. A `429` marks the model `rate_limited` until its next probe. Any other `4xx` is the
caller's error and is returned as-is.

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
