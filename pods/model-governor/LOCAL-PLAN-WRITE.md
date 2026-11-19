# Local Antigravity plan-and-write workflow

Run this workflow once to turn an approved brief into a plan and a written deliverable. It uses the local Google Antigravity CLI's consumer OAuth session. It runs independently of the Cloudflare Worker, OpenBot's provider settings and the fleet scheduler.

From the Model Governor pod directory, use Python 3.9+ on macOS or Linux with a signed-in `agy` CLI on PATH. The CLI and native conversation receipt layout were checked against version 1.5.11.

```sh
python3 bin/agy-plan-write.py \
  --task-ref editorial/brief-17 \
  --task-class seo-video \
  --brief /path/to/approved-brief.txt \
  --out /path/to/private/workflow-runs
```

Use the same task reference on retries. Each invocation prints its new receipt path and runs at most two CLI calls, once per stage. The default deadline is 180 seconds per call, adjustable with `--timeout` up to 300 seconds. A failed check ends that run. Use UTF-8 text with a 48 KiB maximum. Google receives the supplied brief in both calls and the verified plan in the second. Use briefs approved for that service.

| Stage | Selector | Required native label | Required response model |
| --- | --- | --- | --- |
| Plan | `gemini-4-argon-medium` | Gemini 4 Argon (Medium) | `gemini-4-argon-trial` |
| Write | `gemini-4-hydrogen-low` | Gemini 4 Hydrogen (Low) | `gemini-4-hydrogen` |

Each call has a fresh temporary working directory, closed standard input, strict tool review and explicit denials for command, file, URL and MCP operations. Session settings disable additional AI-credit spending. The wrapper forwards an allowlist of ordinary OS environment variables and lets the native CLI handle sign-in. Session flags and permissions are documented by [Google](https://antigravity.google/docs/settings?tab=cli).

The wrapper verifies one native generation and exactly one user step followed by one completed assistant step. It requires the recorded input, selected model, returned model, effort label, Google stream response ID and final text to agree. A changed native schema, a tool step or an unverified model stops the workflow. The CLI retains its native conversation history according to its own settings.

## Artifacts and feedback

The private run directory contains `plan.txt`, `write.txt` and `receipt.json`. Only a completed run has a final `artifact`. Copy `taskRef`, `taskClass`, `briefSha256` and `artifact` from this receipt when preparing an independent artifact review or blind preference. The workflow does not submit feedback.

The workflow ID names this specific pair and order. The run ID identifies one invocation. Each call has its own ID, model receipt, recorded input hash, response hash and any native token counts. The write call references the plan call ID and exact plan hash. The artifact reference resolves to `<out>/<receiptRef>/receipt.json`; the artifact hash covers the exact UTF-8 bytes of `write.txt`.

`attemptedCalls` counts stage attempts. `verifiedGenerations` counts completed native generations that passed verification. A failed stage may have consumed quota even if no receipt passed. The returned model identifies the backend; the native label attests to the selected effort. The provider does not expose a separate effective-effort field or per-call subscription quota debit in these receipts. Missing usage remains unknown.

Run the offline fixtures without a provider account:

```sh
python3 -B tests/test_agy_plan_write.py
```
