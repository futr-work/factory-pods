# Sentinel Radar Pod

> Autonomous Edge Sentinel for Proactive Anomaly Detection, AI Crawler Governance & Threat Monitoring on Cloudflare Workers + D1.

The **Sentinel Radar Pod** is an edge-native micro-worker that shifts the agent factory from *reactive* (waiting for human prompts) to *proactive* (scanning for search engine policy changes, SSL certificate drift, and security anomalies 24/7).

---

## 🏗️ Architecture

```
 ┌────────────────────────────────────────────────────────┐
 │                    External Hub / Mesh                 │
 │                  https://hub.example.com               │
 └─────────────┬────────────────────────────▲─────────────┘
               │ sentinel.signal            │ heartbeat
               │ (Proactive Event Envelope) │ task.completed
               ▼                            │
 ┌──────────────────────────────────────────┴─────────────┐
 │         Sentinel Radar Pod (Cloudflare Worker)         │
 │                                                        │
 │  ┌──────────────┐   ┌───────────────┐  ┌─────────────┐ │
 │  │ / (Cockpit)  │   │  Event Mesh   │  │ Cron / 15m  │ │
 │  │ Dark Mode UI │   │  Client Node  │  │ Radar Probe │ │
 │  └──────────────┘   └───────┬───────┘  └──────┬──────┘ │
 │                             │                 │        │
 │                     ┌───────▼─────────────────▼──────┐ │
 │                     │    Proactive Probe Engine      │ │
 │                     │  (Robots / SSL / Headers)      │ │
 │                     └───────────────┬────────────────┘ │
 │                                     │                  │
 │                             ┌───────▼───────┐          │
 │                             │ Cloudflare D1 │          │
 │                             │ Target State  │          │
 │                             └───────────────┘          │
 └────────────────────────────────────────────────────────┘
```

---

## 🛰️ Proactive Hunting Capabilities

1. **2026 AI Search Crawler Governance**:
   - Continuously monitors target domains for explicit directives for major AI search engines:
     - `GPTBot` (OpenAI / SearchGPT)
     - `ClaudeBot` (Anthropic)
     - `PerplexityBot` (Perplexity)
     - `Google-Extended` (Gemini)
     - `Applebot-Extended` (Apple Intelligence)
   - Emits immediate proactive alert envelopes when search engine policies drift.

2. **Security & Header Drift Detection**:
   - Automated parsing and validation of RFC 9116 `/.well-known/security.txt`.
   - Checks expiry dates, encryption keys, and mandatory reporting channels.

3. **Edge execution**:
   - Runs as a Cloudflare Worker on V8 isolates, with no always-on server to pay for while idle.

---

## ⚡ Quickstart

### 1. Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:8787` to view the local dark-mode Cockpit dashboard and target watchlist.

### 2. Deploy to Cloudflare Workers

1. Create a dedicated D1 SQLite database:
   ```bash
   npx wrangler d1 create sentinel-radar-pod-db
   ```
2. Copy the resulting `database_id` into `wrangler.jsonc`.
3. Apply the schema:
   ```bash
   npx wrangler d1 execute sentinel-radar-pod-db --local --file=schema.sql
   npx wrangler d1 execute sentinel-radar-pod-db --remote --file=schema.sql
   ```
4. Deploy globally:
   ```bash
   npx wrangler deploy
   ```

---

## 📡 API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | `GET` | Web Cockpit UI displaying target health and radar signals |
| `/health` | `GET` | Pod liveness and capability probe |
| `/api/task` | `POST` | Ingest and execute an on-demand radar scanning task |
| `/api/targets` | `GET` | Fetch list of active monitored targets and their status |
