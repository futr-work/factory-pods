# Domain Scout empty-output recovery

Run from the pod directory with Python 3.9+ on macOS or Linux. The command reads two existing snapshots; it does not scrape listings, install schedules or change agent settings. Supply a fresh run directory and the original stable task reference. Keep its trusted HTTPS governor origin and credentials local.

```sh
python3 bin/run-domain-extraction.py \
  --park park.csv --dynadot dynadot.csv \
  --task-ref domain-scout:my-snapshot --out ./extraction-run \
  --origin "$GOVERNOR_ORIGIN" --caller "$FREE_CALLER" \
  --admin-token-file "$ADMIN_TOKEN_FILE" --client-token-file "$CLIENT_TOKEN_FILE" \
  --oauth-on-empty
```

The default primary is `openrouter:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`. An override must be an exact free OpenRouter catalog ID. The runner verifies the selected caller has a $0 budget and tier-zero policy before requesting one streamed completion with low requested effort, 12,000 maximum output tokens and `X-Governor-Require-Output: text`. It checks the returned caller, tier, single attempt, model identity, generation ID and provider counters. All primary and recovery inputs share the exact frozen UTF-8 prompt, CSV snapshots, task reference and composite rubric hash.

Omit `--oauth-on-empty` to disable the native generation. When enabled, recovery requires a terminal Worker `empty_output` event with no visible output, a normal stop or length finish, complete provider counts and explicit zero cost. The terminal must be followed by SSE `[DONE]`. The runner reads the event's D1 usage row by immutable ID using the admin token and verifies its task, caller, model, tier, empty-output status, cost and counts before invoking the native helper. This permits exactly one local first-party Claude subscription generation on the same brief. A quota debit is unknown unless independently measured. No alternate API credential, provider or repair turn is used.

A nonempty result is retained byte-for-byte in each attempt's `inventory.csv`. The existing collector validates coverage, attribution and close data. Additional contract checks enforce the exact column order, lowercase domains, Park.io primary on overlap, the captured URLs as the complete evidence set, and the verbatim close string for the selected primary. The composite run rubric has its own digest and references the original collector rubric. Malformed CSVs and nonempty rubric failures stop on that attempt. HTTP errors, filters, tools, refusals, mismatched or missing empty-output receipts and broken streams never authorize recovery.

`summary.json` records the actual stages, timestamps, measured usage and acceptance. Partial or unavailable totals remain unknown. `frozen.json`, the original inputs, step receipts, the linked D1 row on empty output, native receipt (when reached), and per-artifact measurements allow offline review. `batch.json` is a compatible evidence-import batch; posting to D1 is a separate explicit action. Exit code 0 indicates an accepted final artifact, 1 an unsuccessful run, and 2 an invalid setup or already claimed run directory. An interrupted run directory cannot be resumed or reused to make a second generation.
