# Domain Scout deliverable recovery

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

With neither OAuth option, there is no native generation. With `--oauth-on-empty`, recovery requires a terminal Worker `empty_output` event with no visible output, a normal stop or length finish, complete provider counts and explicit zero cost. The terminal must be followed by SSE `[DONE]`. The runner reads the event's D1 usage row by immutable ID using the admin token and verifies its task, caller, model, tier, empty-output status, cost and counts before invoking the native helper. This permits exactly one local first-party Claude subscription generation on the same brief. A quota debit is unknown unless independently measured. No alternate API credential, provider or repair turn is used.

A nonempty result is retained byte-for-byte in each attempt's `inventory.csv`. The existing collector validates coverage, attribution and close data. Additional contract checks enforce the exact column order, lowercase domains, Park.io primary on overlap, the captured URLs as the complete evidence set, and the verbatim close string for the selected primary. The composite run rubric has its own digest and references the original collector rubric. Malformed CSVs and nonempty rubric failures stop on that attempt. Generic HTTP errors, filters, tools, refusals, mismatched or missing receipts and broken streams never authorize recovery.

`summary.json` records the actual stages, timestamps, measured usage and acceptance. Partial or unavailable totals remain unknown. `frozen.json`, the original inputs, step receipts, the linked D1 row on empty output, native receipt (when reached), and per-artifact measurements allow offline review. `batch.json` is a compatible evidence-import batch; posting to D1 is a separate explicit action. Exit code 0 indicates an accepted final artifact, 1 an unsuccessful run, and 2 an invalid setup or already claimed run directory. An interrupted run directory cannot be resumed or reused to make a second generation.


## Optional upstream timeout recovery

Add `--oauth-on-timeout` to accept an authenticated, Governor-owned upstream deadline failure that produced no visible artifact. This option can stand alone or accompany `--oauth-on-empty`. They share one recovery slot and one claim for the frozen run. Both requests use the original brief bytes. The primary token cap stays at 12,000.

The primary normally uses the Worker’s 120,000 ms deadline. For a bounded verification run, `--upstream-timeout-ms N` (1000–120000) changes only that request’s upstream deadline and requires `--oauth-on-timeout`. A deliberately shortened deadline proves the mechanism; it cannot measure the normal timeout rate. Client socket errors and local wall-clock deadlines do not qualify.

The runner accepts the terminal as HTTP 504 JSON before streaming starts, or as an SSE error followed by `[DONE]`. It verifies the free route headers, request-bound deadline and identities and requires a matching D1 row whose timeout metadata agrees with the terminal fields. It retains visible whitespace bytes exactly, rejects partial visible text, and stores only the sanitized error envelope and its fingerprint. A preheader timeout can attest an attempted route while leaving the provider reply model and generation ID unknown.

For a timed-out primary, exact task token and cost totals remain null. `observedTokenSubtotals` combines only explicitly observed values (including a separately reported total); it is not a billing total. Legacy D1 numeric placeholders for absent fields do not enter the subtotals. `observedPrimaryCostUsd` preserves any provider-reported partial cost; unknown subscription quota remains null. `firstPass`, `accepted`, `finalQuality`, per-attempt `quality`, elapsed times and `acceptedDomainsPerSecond` distinguish artifact usability from availability. A timeout with no deliverable receives no row-level quality score. Throughput uses accepted distinct captured domains divided by the whole run’s elapsed time.
