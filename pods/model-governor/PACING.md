# Director narration pacing

Before rendering, measure each spoken line using the production voice and its normal synthesis pace. Record the duration after trimming leading/trailing silence and before speed fitting. Run the gate from the pod directory:

```sh
node bin/check-script-pacing.mjs shots.json timings.json
```

The shot manifest is the complete ordered timeline. Gaps are allowed; a deliberately silent shot has an empty `vo`. Times and durations are seconds.

```json
[{"start":0,"end":5,"vo":"Which cable powers the lamp?"},{"start":5,"end":8,"vo":""}]
```

The measured take ledger uses one-based shot numbers and the exact narration text measured. Director's existing `nativeSeconds` field is accepted as an alias for `naturalSeconds`.

```json
[{"shot":1,"vo":"Which cable powers the lamp?","naturalSeconds":6.5}]
```

The gate reserves 0.18 seconds per voiced shot, matching Director's existing 0.13-second placement and 0.05-second fitting allowances. Required speed is the measured duration divided by the remaining shot time, with a floor of 1×. A line passes at up to and including 1.25×. This example has 4.82 seconds available and needs 1.35×; shorten it to a natural take of at most 6.025 seconds or extend the shot.

Read the JSON result and exit status:

| Exit | Result | Action |
|---|---|---|
| 0 | `pass` | Proceed with this pacing check satisfied. |
| 1 | `needs_rewrite` | Address each line in `rewrite`, then remeasure changed narration and rerun. |
| 2 | `unknown` or `invalid` | Supply missing measurements, correct mismatched text or repair the input timeline. |

`maxSpeed` covers measured lines only, and is null when there are none. The calculation uses original take durations; fitted audio timestamps, saved playback rates and word-count estimates cannot establish a pass. Pacing is one pre-render criterion. Factual correctness, shot feasibility and actual playback still need review.
