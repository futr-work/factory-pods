# Factory Pods: Autonomous Edge Workers on Cloudflare

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP Spec](https://img.shields.io/badge/MCP-2026--07--28-orange.svg)](docs/pod-contract.md)
[![npm](https://img.shields.io/npm/v/@futr-work/pod-kernel.svg?label=%40futr-work%2Fpod-kernel)](https://www.npmjs.com/package/@futr-work/pod-kernel)
[![CI](https://github.com/futr-work/factory-pods/actions/workflows/ci.yml/badge.svg)](https://github.com/futr-work/factory-pods/actions/workflows/ci.yml)
[![futr.work](https://img.shields.io/badge/by-futr.work-black.svg)](https://futr.work)

> **Autonomous edge workers with durable state, a shared auth gate, and an MCP interface, deployed to Cloudflare with no servers to run.**

Factory Pods is the open-source micro-worker chassis from [futr.work](https://futr.work). Instead of running heavy, fragile 500MB browser bots in multi-gigabyte Docker containers, Factory Pods execute as lightweight micro-agents directly inside V8 isolates on the Cloudflare Workers global edge, paired with isolated SQLite persistence (Cloudflare D1).

---

## ⚡ 60-Second Quickstart

Scaffold a new edge worker pod using the interactive CLI:

```bash
npm create @futr-work/factory-pod@latest my-worker
cd my-worker
npm install
npm run dev
```

Visit `http://localhost:8787` to see your pod's live dark-mode cockpit (HTTP Basic Auth password: the random `FACTORY_HUB_TOKEN` the scaffolder wrote to `.dev.vars`) and MCP tools.

To deploy globally to your Cloudflare account:
```bash
npx wrangler deploy
```

---

## 🚀 Why Edge Pods

Factory Pods run as Cloudflare Workers (V8 isolates) rather than wrapping a headless browser in a container. The properties below are architectural; none is a benchmark.

| Property | How Factory Pods provide it |
|---|---|
| **Idle cost** | No always-on server. Cloudflare bills Workers and D1 by usage; see Cloudflare's current pricing. |
| **Execution model** | Deterministic API calls and MCP tools, not DOM scraping or browser automation. |
| **State** | One Cloudflare D1 (SQLite) database per pod. |
| **Footprint** | One small bundle per pod. `npx wrangler deploy --dry-run` reports 20–40 KiB gzipped for `starter`, `model-governor` and `reception` at the time of writing. |
| **Protocol** | MCP (Model Context Protocol 2026-07-28), see [Pod Contract](docs/pod-contract.md). |
| **Shared security** | One auth gate and one Tincan mesh client in `@futr-work/pod-kernel`, used by every pod. |

Latency and failover timings are **not** claimed here: no benchmark exists in this repository. Add one before publishing a number.

---

## 🧭 The Reference Pods

Every pod lives in `pods/<name>` and ships a `pod.toml` manifest that tests keep in sync with its `wrangler.jsonc` name and registered MCP tools. Each one is also a scaffolder template: `npm create @futr-work/factory-pod@latest my-pod -- --template <name>`.

| Pod | Role | What it does |
|---|---|---|
| [`starter`](pods/starter) | Chassis | Blank canvas: D1 state, the five core MCP tools, cockpit UI. The default template. |
| [`model-governor`](pods/model-governor) | AI routing | Model radar: daily discovery of new models (OpenRouter, OrcaRouter), budget-capped capability probes, a stored daily usage analysis (calls, failures, p50/p95 latency, cost), plus 429 failover, cost telemetry and subscription routing advice. HTTP API; no MCP endpoint. |
| [`sentinel-radar`](pods/sentinel-radar) | Sentinel | Proactive anomaly, AI-crawler and security probes. HTTP API; no MCP endpoint. |
| [`authority-seo`](pods/authority-seo) | SEO governance | Site audits, AI-crawler robots.txt, Schema.org JSON-LD, metadata, IndexNow. |

---

## <a id="building-custom-pods"></a>🛠️ Building Custom Pods

You can use the lightweight TypeScript chassis to create custom micro-workers for proprietary billing audits, compliance checks, or custom deal scanners.

### 1. The Pod Structure

Every pod conforms to the [Pod Contract](docs/pod-contract.md):
- **`pod.toml`**: Manifest declaring name, role, harness, and the MCP tools the pod registers.
- **`src/handler.ts`**: The single file where you implement your custom logic.
- **`schema.sql`**: SQLite D1 schema for persistent state.
- **`wrangler.jsonc`**: Cloudflare deployment configuration.

### 2. Implementing Your Custom Logic

In [`src/handler.ts`](pods/starter/src/handler.ts), implement the `TaskHandler` interface. Cloudflare Workers edge composition wraps storage at the worker boundary with `toPodStorage(env.DB)` (or `new D1Storage(env.DB)`), ensuring domain logic and custom handlers interact strictly with the composed, branded `PodStorage` seam (`@futr-work/pod-kernel/storage`) without raw D1 coupling or backend branching:

```typescript
import { TaskRecord, HandlerContext, TaskHandler } from "./types.js";
import { PodStorage } from "@futr-work/pod-kernel/storage";

export class MyCustomHandler implements TaskHandler {
  public name = "my-custom-handler";

  public canHandle(topic: string, _spec: any): boolean {
    return topic === "audit.run";
  }

  public async handle(task: TaskRecord, context: HandlerContext): Promise<any> {
    const { podConfig, now, storage } = context;

    // 1. Read persistent state through the shared PodStorage seam
    const results = storage
      ? (await storage.prepare("SELECT * FROM audits WHERE target = ?").bind(task.spec.target).all()).results
      : [];

    // 2. Perform sub-second deterministic checks or AI calls
    const output = await performAudit(task.spec);

    // 3. Atomically write results through PodStorage
    if (storage) {
      await storage.prepare(
        "INSERT INTO audits (id, target, status, created_at) VALUES (?, ?, ?, ?)"
      ).bind(task.taskId, task.spec.target, "completed", now).run();
    }
    // 4. Return structured receipt
    return {
      status: "completed",
      receipt: { taskId: task.taskId, output, auditCount: results.length },
    };
  }
}
```

The `starter` pod implements the five core MCP tools (`submit_task`, `task_status`, `approve`, `cancel`, `get_receipt`) with Bearer-token auth and an HTML cockpit. Domain pods register their own tools; see each `pod.toml`.

---

## 🏛️ Monorepo Architecture

This repository is organized as an npm workspaces monorepo:

```text
factory-pods/
├── packages/
│   ├── kernel/                    # @futr-work/pod-kernel: shared contract types, durable jobs, gates, MCP,
│                                  #   plus the auth gate and Tincan mesh clients every pod imports
│   └── create-factory-pod/        # @futr-work/create-factory-pod: the CLI scaffolder
├── pods/                          # The four reference pods (see table above)
├── tests/                         # Repository checks: pod.toml manifests, public hygiene
├── docs/
│   ├── architecture.md            # Why edge pods beat browser bots
│   ├── pod-contract.md            # MCP 2026-07-28 specification
│   └── self-hosting.md            # Self-hosting on Cloudflare
```

### Running Tests Across All Pods

```bash
npm install
npm test
```

Runs every package's and pod's tests plus the `pod.toml` manifest checks. Tests are hermetic: they never contact a live hub or any external endpoint.

---

## 🔒 What CI enforces

Every push and pull request runs, and must pass:

- **gitleaks** over the full history, failing the build on any finding.
- **Public hygiene** (`npm run check:public`): no absolute home paths, personal handles, tailnet hostnames, Cloudflare account subdomains or real D1 database ids in tracked files.
- **Build, type check and tests** for every package and pod.
- **Quickstart end to end**: packs the kernel and scaffolder, scaffolds a pod in an empty directory, installs it from the packed tarballs, type-checks and tests it.

---

## ☁️ futr.work

Factory Pods are MIT-licensed and free to self-host. [futr.work](https://futr.work) builds and runs autonomous worker fleets on top of them.

---

## 📄 License

MIT © [futr.work](https://futr.work)
