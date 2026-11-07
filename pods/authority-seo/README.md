# Authority SEO Pod

> AI Search Engine Optimization (AEO), Crawler Governance & Structured Data Worker on Cloudflare Workers + D1.

The **Authority SEO Pod** optimizes web properties for the 2026 AI search landscape. It automatically generates AI crawler directives for citation search engines (Perplexity, SearchGPT, Claude-Web) while gating scraping bots (Bytespider, CCBot), generates Schema.org JSON-LD structured data, and audits on-page metadata.

---

## 🏗️ Architecture

```
 ┌────────────────────────────────────────────────────────┐
 │                    External Hub / Mesh                 │
 │                  https://hub.example.com               │
 └─────────────┬────────────────────────────▲─────────────┘
               │ task.assigned              │ heartbeat
               │ (SEO Audit Task)           │ task.completed
               ▼                            │
 ┌──────────────────────────────────────────┴─────────────┐
 │         Authority SEO Pod (Cloudflare Worker)          │
 │                                                        │
 │  ┌──────────────┐   ┌───────────────┐  ┌─────────────┐ │
 │  │ / (Cockpit)  │   │ MCP Protocol  │  │ Cron / 24h  │ │
 │  │ Dark Mode UI │   │  JSON-RPC     │  │ Site Audit  │ │
 │  └──────────────┘   └───────┬───────┘  └──────┬──────┘ │
 │                             │                 │        │
 │                     ┌───────▼─────────────────▼──────┐ │
 │                     │     SEO / AEO Engine           │ │
 │                     │  (Robots / Schema / Meta)      │ │
 │                     └───────────────┬────────────────┘ │
 │                                     │                  │
 │                             ┌───────▼───────┐          │
 │                             │ Cloudflare D1 │          │
 │                             │ Audit History │          │
 │                             └───────────────┘          │
 └────────────────────────────────────────────────────────┘
```

---

## 🔍 Core Capabilities

1. **2026 AI Search Crawler Governance**:
   - Generates tailored `robots.txt` that allows search citation bots (`OAI-SearchBot`, `PerplexityBot`, `ClaudeBot`) while blocking aggressive training scrapers.

2. **Schema.org Structured Data Generation**:
   - Generates validated JSON-LD for Organizations, Medical Businesses, Financial Services, and Local Businesses.

3. **On-Page Metadata Optimization**:
   - Generates high-clickthrough title tags, OpenGraph summaries, and keyword-targeted descriptions.

4. **MCP 2026-07-28 Endpoint**:
   - Exposes tools via the Model Context Protocol (`generate_ai_robots_txt`, `generate_schema_jsonld`, `optimize_metadata`, `generate_sample_fixpack`).

---

## ⚡ Quickstart

### 1. Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:8787` to view the Cockpit dashboard.

### 2. Deploy to Cloudflare Workers

1. Create a D1 database:
   ```bash
   npx wrangler d1 create authority-seo-pod-db
   ```
2. Paste the `database_id` into `wrangler.jsonc`.
3. Apply migrations:
   ```bash
   npx wrangler d1 execute authority-seo-pod-db --local --file=schema.sql
   npx wrangler d1 execute authority-seo-pod-db --remote --file=schema.sql
   ```
4. Deploy globally:
   ```bash
   npx wrangler deploy
   ```
