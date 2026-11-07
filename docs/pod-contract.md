# The Pod Contract (MCP v2 Specification)

The **Pod Contract** is the interface a pod implements so that any MCP client (Claude Code, Pi-Durable, custom scripts, or orchestrator hubs) can interact with it. The `starter` and `egm-spec` pods implement the five core tools below. Domain pods (`pm`, `git-operator`, `reception`, ...) register their own tools, and `model-governor`, `sentinel-radar` and `pod-optimizer` expose an HTTP API only. Each pod's `pod.toml` lists exactly what it registers; `tests/manifests.test.mjs` enforces it.

---

## 1. Manifest: `pod.toml`

Every pod declares its identity in `pod.toml`. The example is the `starter` pod's real manifest:

```toml
[pod]
name = "worker-pod-template"
role = "worker"
version = "1.0.0"

[harness]
runtime = "cloudflare-worker"
engine = "edge-v8"

[tools]
mcp = ["submit_task", "task_status", "approve", "cancel", "get_receipt"]
```

---

## 2. Stateless MCP 2026-07-28 Tools

A pod that exposes MCP serves a stateless endpoint at `/mcp` with Bearer authentication. The core tools are:

### `submit_task`
Idempotent task submission keyed by `requestId`. If the `requestId` has already been submitted, the pod returns the existing task status without re-executing.
- **Parameters**: `repo` (string), `issue` (number), `requestId` (string), `title` (optional), `body` (optional).
- **Returns**: `{ taskId, requestId, phase, status, existing }`.

### `task_status`
Polls the execution phase and outcome of a task.
- **Parameters**: `taskId` (string/number) or `requestId` (string).
- **Returns**: `{ taskId, phase, status, checks, diffHash, error }`.

### `approve`
Submits a human-in-the-loop decision for tasks paused in `await_approval`.
- **Parameters**: `taskId` (string/number), `decision` ("approve" | "reject").
- **Returns**: `{ ok, decision }`.

### `cancel`
Durably aborts a running or pending task and halts external tool calls.
- **Parameters**: `taskId` (string/number).
- **Returns**: `{ ok, status: "aborted" }`.

### `get_receipt`
Retrieves the cryptographic evidence receipt of a completed task.
- **Parameters**: `taskId` (string/number).
- **Returns**:
  ```json
  {
    "taskId": "task-42",
    "pr": "https://github.com/org/repo/pull/1",
    "commit": "11223344556677889900aabbccddeeff11223344",
    "diffHash": "7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
    "checks": ["PASS npm run check", "PASS npm test"],
    "model": "gpt-6.1-sol",
    "provider": "opencode",
    "family": "opencode",
    "runtime": "pod-kernel",
    "durationMs": 4210
  }
  ```

---

## 3. Immune Gates & Security

1. **Blocked Paths**: Modifications targeting `.github/workflows/`, `.env`, keys, secrets, or `.factory/` are rejected before code is pushed.
2. **Deterministic Verification**: Code must pass all verify commands declared in `.factory/verify.json` or `package.json` scripts.
3. **Non-Empty Diff**: Tasks resulting in an empty git diff are rejected as failures.
4. **Cross-Family Audit**: When audited by an external verifier, the auditor's model family must differ from the producer's model family.

---

## 4. AG-UI Interaction Protocol (Edge SSE Streaming)

Pods expose an AG-UI Server-Sent Events (SSE) stream (`/events` or `/ag-ui`) providing real-time cockpit updates and human-in-the-loop interaction:

- **Streaming Events**: `run_started`, `text_message_chunk`, `tool_call_start`, `tool_call_result`, `step_finished`, `run_finished`.
- **Human-In-The-Loop Interrupts (`interrupt`)**: When a sensitive task requires operator permission or input, the pod emits an `interrupt` event with an `interruptId`, `prompt`, and allowed options (`allow_once`, `allow_always`, `deny`, `handled`).
- **Resuming Work (`resume`)**: The client submits a `resume` payload to continue execution from the checkpoint saved in D1 SQLite.

---

## 5. Pre-Action Policy Gate

Actions are evaluated against a pure, deterministic policy before tool execution:

- **Ranked Behaviors**:
  1. `allow` (0): Executes without prompt (e.g. read-only inspections).
  2. `pre_approved` (1): Executes only if explicitly requested in this run.
  3. `ask` (2): Emits an AG-UI interrupt before acting (e.g. billing, writes).
  4. `hand_off` (3): Hands the task directly to the human operator (e.g. secrets, credentials).
- **Rule Resolution**: Matches `[botId, toolRef, effect, scope]` glob patterns. Ties resolve to the strictest matching rule.

---

## 6. Structured Inter-Pod Handoff Envelopes

Inter-pod task delegation across the Tincan mesh must use typed parameters rather than unstructured text to prevent semantic drift:

```typescript
export interface PodHandoffEnvelope {
  task: string;        // Explicit verb + noun assignment
  constraints?: string; // Bounds: time budgets, quota limits, forbidden paths
  expecting?: string;  // Exact definition of success: receipt or schema
  context?: Record<string, any>;
}
```

### Conversational Refusals
*"Every refusal is an answer, not an error."* When a pod cannot execute a handoff due to quotas, missing capabilities, or policy refusals, it returns a structured `PodRefusal` object with an explanation and remediation advice rather than crashing the relay.

