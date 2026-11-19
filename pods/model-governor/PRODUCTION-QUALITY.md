# Measuring task quality in production

Use a completed deliverable or decision as the unit of evaluation. A session can contain several tasks, and retries, fallbacks and tool calls can all belong to one task. Keep a stable task reference across those attempts. Preserve the workflow and stage receipts, artifact digest, task class, rubric version, model version, requested effort, and separately any observed effort. Distinguish recommendation, actual execution, and downstream outcome.

## Establish the denominator

For OpenBot, run the local, read-only sampler against a projection database:

```sh
python3 bin/sample-openbot-tasks.py /path/to/openbot.db --hours 24 --random 8 --failures 4
```

It groups a message by recipient and links its distinct turns to usage records. It emits an unweighted probability sample of the production population and a separate failure-only supplement, plus source records for authorized reviewers to open locally. No prompt bodies or model calls are required. A source message is a proxy: use the owning business system's job ID when one job spans multiple messages or agents. Window membership is by first delivery; status is the latest observed in the local projection. Reproduce the cohort boundary with `--before` and selection with `--seed`. Late usage and status updates can change a subsequent snapshot.

Do not mix the failure supplement into the population pass rate. Supply a JSON mapping from taskRef to an externally assigned class via `--class-map` to stratify the population sample. The sampler reserves one slot per nonempty class, then allocates remaining slots to the lowest-coverage class. If the budget cannot cover every class, it falls back to a uniform population draw. Each sampled task includes its inclusion probability. Shared turns can link the same usage record to multiple tasks; the report counts unique usage records and links separately. Weight samples back to the production mix for portfolio rates. Report attempted jobs, distinct jobs with delivery, with a label, and accepted on first attempt. Missing usage, missing labels, unfinished tasks, and delayed business outcomes need separate counts.

## Define independent evidence per task family

| Family | Routine verification | Where judgment is needed |
| --- | --- | --- |
| Data extraction | Schema, required fields, source-span match, unit normalization | Ambiguous sources; audit a sample of apparent passes for omissions |
| Coding | Build and tests on the exact patch; hidden tests and a seeded defect for reviewers | Regressions outside test coverage, maintainability, security-sensitive changes |
| Research | Source opens, quotation exists, reported number matches dated source | Whether the source supports the conclusion and covers counterevidence |
| Creative production | Measured read duration, total timeline, missing assets, working CTA | Audience fit, natural delivery, amount of editing and actual acceptance |

A producing model can flag uncertainty or propose a check. A deterministic validator must measure the artifact, and an independent judge must cite a concrete defect. Store judge opinions separately from human preference and operational acceptance. Qualify each judge against blinded, held-out human decisions for that task class; track its false-pass rate, including on examples from its own model family. Agreement between two similar judges can share the same error. Treat silence and lack of complaints as unknown.

## Optimize within a task class

Use eligibility and constraints first: approved provider path, trust/risk, data handling, capability, quota, budgets and named-model requirements. Among eligible workflows, compare the fraction of independent tasks accepted on the first attempt, delivery reliability, rework, p95 latency and resource use. Distinguish incremental API cost from included subscription usage. Include all stages and retries. Attribute a multistage result to the workflow unless a controlled comparison isolates a stage.

Before changing defaults, define the rubric, quality floor and acceptable regression in advance. Compare candidates on the same representative tasks, hold out unseen briefs, and cluster repeated runs by original task. Show counts and uncertainty alongside rates. Require enough independent tasks for the decision's risk and the effect size; one preferred artifact cannot establish a reusable winner. Escalate critical decisions, uncertain cases, reviewer disagreements, and a random sample of apparently good work for human review.

Recommended rollout: evaluate in shadow from recorded outcomes, review a proposed per-class policy, then canary a bounded share of eligible live tasks and retain a rollback rule. Keep exact requested models pinned. A model/version, evaluator/rubric, account restriction, or major workload change should expire or qualify older evidence. A single cached routing policy per task class can serve normal requests without invoking a second model to choose a model. These are rollout recommendations; evidence ingestion alone does not enact a routing policy or schedule recurring evaluation.
