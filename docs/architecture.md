# Architecture: Why Edge Pods Beat Heavy Browser Bots

Many AI agent systems wrap a headless browser inside a container. They carry slow starts, CAPTCHA stalls, always-on hosting, and awkward state synchronization.

**Factory Pods** use an entirely different architectural paradigm: **autonomous micro-workers executing directly inside V8 isolates on the Cloudflare Workers global edge**, paired with dedicated SQLite persistence (Cloudflare D1).

---

## Properties

These are architectural properties, not benchmarks. This repository contains no latency or failover measurements, so none are claimed.

| Property | Browser-automation agents | Factory Pods |
|---|---|---|
| **Runtime** | Headless browser and DOM scraping | Deterministic API calls and MCP tools in a Cloudflare Workers V8 isolate |
| **Hosting** | Container or VM you operate | No server to operate; usage-billed Workers and D1 |
| **State** | Ephemeral mounts or remote DB trips | One Cloudflare D1 (SQLite) database per pod |
| **Protocol** | Proprietary webhooks or sockets | MCP (Model Context Protocol 2026-07-28) |
| **Shared code** | Per project | `@futr-work/pod-kernel`: one auth gate, one Tincan client |

---

## The Edge Pod Topology

```
                   Inbound Trigger
        (Webhook / Cron / Mesh / MCP Client)
                         │
                         ▼
  ┌─────────────────────────────────────────────────────────┐
  │         Autonomous Worker Pod (Edge V8 Isolate)         │
  │                                                         │
  │   ┌────────────────────┐      ┌─────────────────────┐   │
  │   │  /health & Status  │      │ Stateless MCP v2    │   │
  │   │  (Public Endpoint) │      │ (Bearer Auth Gate)  │   │
  │   └────────────────────┘      └──────────┬──────────┘   │
  │                                          │              │
  │                    ┌─────────────────────▼──────────┐   │
  │                    │ Domain Task Handler (Custom)   │   │
  │                    └─────────────────────┬──────────┘   │
  │                                          │              │
  │         ┌────────────────────────────────┴──────────┐   │
  │         ▼                                           ▼   │
  │   ┌──────────────┐                            ┌─────────┴─────┐
  │   │ Dedicated D1 │                            │  External API │
  │   │ SQLite State │                            │ / LLM Gateway │
  │   └──────────────┘                            └───────────────┘
  └─────────────────────────────────────────────────────────┘
```

---

## Key Design Principles

1. **Deterministic Gates First**: Every action is gated by immutable rules before and after model invocation. A model never verifies itself.
2. **Crash Resilience**: State is committed atomically in SQLite. A killed task resumes seamlessly at its last valid checkpoint.
3. **Stateless Protocol**: Communicates via the standardized Model Context Protocol (`submit_task`, `task_status`, `approve`, `cancel`, `get_receipt`).
4. **Single-File Business Logic**: To write a custom pod, developers only implement [`src/handler.ts`](../pods/starter/src/handler.ts). Transport, SQLite migrations, auth gates, and dark-mode cockpits are handled by the chassis.
