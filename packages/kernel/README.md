# pod-kernel

The small, versioned library every compute pod is built on. **This is not an app.** The factory is the set of pods that factory-hub composes. This kernel is only what *every* pod needs.


## The pod contract (this is the product)
Anything that meets this contract is a pod, whether built on this kernel or bought (an outside MCP v2 server registered through a manifest and adapter).

1. **Manifest:** `pod.toml` with name, role, capabilities, triggers, harness, model, repos, tools.
2. **Interface:** a stateless MCP (spec 2026-07-28) endpoint with these tools:
   - `submit_task`: idempotent via `requestId`
   - `task_status`
   - `approve`: MRTR `input_required`, then a durable `await-approval` phase
   - `cancel`
   - `get_receipt`: diff hash, verify results, harness, model/provider, usage or `unknown`
3. **Mesh:** registers with factory-hub and sends a heartbeat.

## What belongs in the kernel
| Module | Job |
|---|---|
| `jobs` | SQLite phase table (task, requestId, phase, approval, receipt). Phases: `intake → worktree → build → verify → await-approval → PR` |
| `harness` | `run(prompt, cwd) → {exit, lastMessage, usage}`, with adapters for codex, claude and pi |
| `gates` | `.factory/verify.json`, blocked paths, empty-diff rejection, receipt hash |
| `approve` | durable approval that survives a restart |
| `mcp` | the contract endpoint |
| `hub` | registration and heartbeat |
| `auth` | the shared pod access gate (`/health` open; Bearer or Basic `FACTORY_HUB_TOKEN`; fails closed). Import `@futr-work/pod-kernel/auth`; never copy it into a pod |
| `tincan` | `TincanClient` (publish, poll, ack, heartbeat) and `TincanMeshClient` (heartbeat-only). Import `@futr-work/pod-kernel/tincan` |
| `storage` | `PodStorage` contract, `D1Storage` adapter, `toPodStorage` utility. Cloudflare Workers edge-safe (no `node:sqlite`). Import `@futr-work/pod-kernel/storage` |
| `storage/sqlite` | `SqliteFileStorage` persistent local-file SQLite adapter backed by Node built-in `node:sqlite` (Node.js >= 22.16.0+ with statement column metadata / LTS). Node-only scope (does not imply Bun compatibility); edge-isolated subpath. Import `@futr-work/pod-kernel/storage/sqlite` |

## Rules
1. **Admission:** a feature goes into the kernel only if *every* pod needs it. Business-specific logic is a new pod.
2. **Budget:** about 1,500 lines. Past that, the next job is refactoring, not features.
3. **Versioned:** pods pin a kernel version and upgrade on purpose.
4. **Gates are immune:** no pod may change `gates`, `verify.json` or the blocked-path list in a normal task. Changing them needs a `gate-change` label and line-by-line human review.
5. **Nothing modifies itself live:** a pod runs a pinned tag and builds the next version in a worktree. Promotion means a human merges, tags and restarts.
6. **No test data:** every receipt, verdict and metric comes from real execution. A model never assigns its own confidence.
7. **Model-agnostic:** the auditor's model family must differ from the family on the receipt, enforced in code for every run.
