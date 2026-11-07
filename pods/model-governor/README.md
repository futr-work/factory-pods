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

`model` is a preference: the named model serves the request when it is callable and allowed (a PAID model counts
as allowed only once approved), and otherwise the request is routed, with the served model reported back. An
unknown name is `404`; a name nothing else can replace is `409` with the reason.

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
