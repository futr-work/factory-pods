import type { PodStorage } from "@futr-work/pod-kernel/storage";
import { EvidenceError, evidenceHash, evidenceLabel } from "./evidence.js";

const DAY = 86_400_000;

function integer(p: URLSearchParams, key: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = p.get(key);
  if (value === null) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n > max) throw new EvidenceError(400, `invalid ${key}`);
  return n;
}

// Expand both arms of blind comparisons, but only the reviewed artifact of a measured or judged outcome.
// All aggregates run in SQLite; detail pagination never changes the scorecard denominators.
const summarize = `
  , arms AS (
    SELECT s.*, side.value AS side,
        json_extract(doc, '$.' || side.value || '.workflow') AS workflow,
        json_extract(doc, '$.' || side.value || '.artifactSha256') AS artifact,
        json_extract(doc, '$.choice') AS choice,
        json_extract(doc, '$.left.workflow') = json_extract(doc, '$.right.workflow') AS same_workflow
    FROM scope s, json_each(CASE json_extract(doc, '$.kind')
      WHEN 'blind_preference' THEN '["left","right"]' ELSE '["artifact"]' END) side
  ), page AS (
    SELECT DISTINCT workflow FROM arms WHERE workflow > ? ORDER BY workflow LIMIT ?
  ), metrics AS (
    SELECT arms.*,
      CASE WHEN same_workflow THEN 'within'
           WHEN side = choice THEN 'win'
           WHEN choice IN ('left','right') THEN 'loss'
           ELSE choice END AS vote,
      json_array_length(doc,'$.checks') AS checks,
      (SELECT COUNT(*) FROM json_each(doc,'$.checks') c WHERE json_extract(c.value,'$.passed') = 0) AS failed_checks,
      json_extract(doc,'$.publishApproved') AS approved,
      json_extract(doc,'$.editMinutes') AS minutes,
      json_extract(doc,'$.judge') IS NOT NULL AS judged
    FROM arms JOIN page USING (workflow)
  ), by_task AS (
    SELECT workflow, task_ref,
      MAX(vote = 'win') AS won, MAX(vote = 'loss') AS lost, MAX(vote = 'tie') AS tied,
      MAX(vote = 'abstain') AS abstained, MAX(vote = 'within') AS within_workflow,
      SUM(checks) AS checks, SUM(failed_checks) AS failed_checks,
      MIN(approved) AS min_approved, MAX(approved) AS max_approved,
      AVG(minutes) AS task_edit_minutes, SUM(judged) AS judges
    FROM metrics GROUP BY workflow, task_ref
  ), counts AS (
    SELECT workflow, COUNT(DISTINCT seq) AS observations, COUNT(DISTINCT brief_sha256) AS distinctBriefs,
      COUNT(DISTINCT artifact) AS distinctArtifacts FROM metrics GROUP BY workflow
  )
  SELECT t.workflow, c.observations, c.distinctBriefs, c.distinctArtifacts, COUNT(*) AS distinctTasks,
    COUNT(*) FILTER (WHERE won OR lost OR tied) AS blindDecidedTasks,
    COUNT(*) FILTER (WHERE won AND NOT lost AND NOT tied) AS blindWinTasks,
    COUNT(*) FILTER (WHERE lost AND NOT won AND NOT tied) AS blindLossTasks,
    COUNT(*) FILTER (WHERE tied AND NOT won AND NOT lost) AS blindTieTasks,
    COUNT(*) FILTER (WHERE won + lost + tied > 1) AS blindMixedTasks,
    COUNT(*) FILTER (WHERE abstained AND NOT (won OR lost OR tied)) AS blindAbstainOnlyTasks,
    COUNT(*) FILTER (WHERE within_workflow) AS withinWorkflowComparisonTasks,
    COALESCE(SUM(checks),0) AS measuredCheckObservations, COALESCE(SUM(failed_checks),0) AS failedCheckObservations,
    COUNT(*) FILTER (WHERE checks > 0) AS measuredTasks,
    COUNT(*) FILTER (WHERE checks > 0 AND failed_checks = 0) AS allObservedChecksPassedTasks,
    COUNT(*) FILTER (WHERE failed_checks > 0) AS tasksWithFailedChecks,
    COUNT(*) FILTER (WHERE judges > 0) AS subjectivelyJudgedTasks, SUM(judges) AS subjectiveJudgeObservations,
    COUNT(max_approved) AS publicationDecisionTasks,
    COUNT(*) FILTER (WHERE min_approved = 1) AS publicationApprovedTasks,
    COUNT(*) FILTER (WHERE max_approved = 0) AS publicationDeclinedTasks,
    COUNT(*) FILTER (WHERE min_approved != max_approved) AS publicationMixedTasks,
    COUNT(task_edit_minutes) AS editTimeObservedTasks, AVG(task_edit_minutes) AS meanEditMinutesPerObservedTask
  FROM by_task t JOIN counts c USING (workflow) GROUP BY t.workflow ORDER BY t.workflow`;

export async function evidenceScorecard(db: PodStorage, p: URLSearchParams) {
  const taskClass = evidenceLabel(p.get("taskClass"), "taskClass");
  const rubricSha256 = evidenceHash(p.get("rubricSha256"), "rubricSha256");
  const briefSha256 = p.has("briefSha256") ? evidenceHash(p.get("briefSha256"), "briefSha256") : null;
  const toMs = integer(p, "toMs", Date.now() + 1);
  const fromMs = integer(p, "fromMs", Math.max(0, toMs - 30 * DAY));
  if (fromMs >= toMs || toMs - fromMs > 90 * DAY) throw new EvidenceError(400, "select a positive receipt-time window of at most 90 days");
  const before = integer(p, "before", Number.MAX_SAFE_INTEGER);
  const afterWorkflow = p.has("afterWorkflow") ? evidenceLabel(p.get("afterWorkflow"), "afterWorkflow") : "";
  const limit = integer(p, "limit", 25, 100), workflowLimit = integer(p, "workflowLimit", 25, 100);
  if (!limit || !workflowLimit) throw new EvidenceError(400, "page sizes must be positive");
  if ((p.has("before") || p.has("afterWorkflow")) && ["asOf", "fromMs", "toMs"].some(k => !p.has(k))) {
    throw new EvidenceError(400, "pagination requires the original asOf, fromMs and toMs");
  }

  const filter = `task_class = ? AND rubric_sha256 = ? AND created_at >= ? AND created_at < ?
    ${briefSha256 ? "AND brief_sha256 = ?" : ""}`;
  const params: (string | number)[] = [taskClass, rubricSha256, fromMs, toMs];
  if (briefSha256) params.push(briefSha256);
  // The ledger is append-only. Reuse the last visible sequence so concurrent new feedback stays on the next snapshot.
  const ceiling = integer(p, "asOf", Number.MAX_SAFE_INTEGER);
  const totals = await db.prepare(`SELECT COALESCE(MAX(seq),0) AS asOf, COUNT(*) AS observations,
    COUNT(DISTINCT task_ref) AS distinctTasks, COUNT(DISTINCT brief_sha256) AS distinctBriefs
    FROM task_evidence WHERE ${filter} AND seq <= ?`).bind(...params, ceiling)
    .first<{ asOf: number; observations: number; distinctTasks: number; distinctBriefs: number }>();
  if (!totals) throw new Error("missing evidence aggregate");
  const asOf = totals.asOf;
  const scope = { taskClass, rubricSha256, briefSha256, fromMs, toMs, asOf };
  const summary = await db.prepare(`WITH scope AS (SELECT seq, task_ref, brief_sha256, payload_json AS doc
    FROM task_evidence WHERE ${filter} AND seq <= ?) ${summarize}`)
    .bind(...params, asOf, afterWorkflow, workflowLimit + 1).all<{ workflow: string }>();
  const detail = await db.prepare(`SELECT seq, created_at, payload_json FROM task_evidence
    WHERE ${filter} AND seq <= ? AND seq < ? ORDER BY seq DESC LIMIT ?`)
    .bind(...params, asOf, before, limit + 1).all<{ seq: number; created_at: number; payload_json: string }>();
  const workflows = summary.results.slice(0, workflowLimit);
  const observations = detail.results.slice(0, limit).map(r => ({ seq: r.seq, recordedAt: r.created_at, ...JSON.parse(r.payload_json) }));
  return {
    attestation: "governor_admin", scope, totals, workflows, observations,
    nextBefore: detail.results.length > limit ? observations.at(-1).seq : null,
    nextAfterWorkflow: summary.results.length > workflowLimit ? workflows.at(-1)!.workflow : null,
  };
}
