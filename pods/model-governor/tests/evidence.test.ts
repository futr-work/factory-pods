import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteFileStorage } from "@futr-work/pod-kernel/storage/sqlite";
import worker from "../src/worker.js";
import { resetSchemaCache } from "../src/schema.js";

const read = (path: string) => readFileSync(new NodeURL(path, import.meta.url), "utf8");
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(read("../schema.sql"));
  const DB = new SqliteFileStorage(sqlite);
  const env = { DB, GOVERNOR_ADMIN_TOKEN: "admin", GOVERNOR_CLIENT_TOKEN: "client", FACTORY_HUB_TOKEN: "hub" };
  function request(method: string, path: string, auth = "Bearer admin", body?: unknown) {
    return worker.fetch(new Request("https://gov.test/api/governor/" + path, {
      method, headers: { Authorization: auth }, body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
  }
  return { sqlite, DB, env, request };
}
const common = { evidenceId: "preference-1", taskClass: "editing", taskRef: "assignment-7", briefSha256: "a".repeat(64),
  rubricSha256: "b".repeat(64), sourceRef: "ballot-record-19" };
const left = { workflow: "two-stage", receiptRef: "workflow-run-27", artifactSha256: "c".repeat(64) };
const right = { workflow: "direct", receiptRef: "workflow-run-75", artifactSha256: "d".repeat(64) };
const preference = { ...common, kind: "blind_preference", left, right, choice: "left" };
const review = { ...common, evidenceId: "review-1", kind: "artifact_review", artifact: left, checks: [
  { name: "timing", passed: true, measurementRef: "independent-measurement-1" },
], judge: { name: "external-review", score: 3, maxScore: 4, receiptRef: "judge-receipt-1" } };
const path = "scorecard?taskClass=editing&rubricSha256=" + common.rubricSha256;

test("evidence endpoints require an admin bearer and do not expose the private ledger to hub or client", async () => {
  const { request, env } = fixture();
  for (const token of ["", "Bearer wrong", "Bearer hub", "Bearer client", "Basic " + btoa("a:admin")]) {
    assert.equal((await request("POST", "evidence", token, preference)).status, 403);
    assert.equal((await request("GET", path, token)).status, 403);
  }
  assert.equal((await request("GET", "scorecard")).status, 400);
  env.GOVERNOR_ADMIN_TOKEN = "";
  assert.equal((await request("POST", "evidence", "Bearer hub", preference)).status, 403);
});

test("both model-approval actions require admin auth for raw and encoded namespaced IDs", async () => {
  const { sqlite, env } = fixture();
  const id = "example:model/family/revision";
  sqlite.prepare("INSERT INTO model_catalog (id,provider,model_name,category,tier,status) VALUES(?,?,?,'coding','PAID','active')")
    .run(id, "example", "model/family/revision");
  function mutate(path: string, action: string, token: string) {
    return worker.fetch(new Request(`https://gov.test/api/models/${path}/${action}`, {
      method: "POST", headers: { Authorization: "Bearer " + token }, body: "{}",
    }), env);
  }
  for (const path of [id, encodeURIComponent(id)]) {
    for (const action of ["approve", "revoke"]) {
      for (const token of ["hub", "client"]) assert.equal((await mutate(path, action, token)).status, 403);
      assert.equal((await mutate(path, action, "admin")).status, 200);
      assert.equal(sqlite.prepare("SELECT approved_by FROM model_catalog WHERE id=?").get(id)!.approved_by,
        action === "approve" ? "hd" : null);
    }
  }
  assert.equal((await mutate("bad%zz", "approve", "hub")).status, 403);
  assert.equal((await mutate("bad%zz", "approve", "admin")).status, 400);
});

test("admin receipts are immutable, atomic, replay-safe and private; malformed or self-generated observations fail", async () => {
  const { request, sqlite } = fixture();
  const post = (v: unknown) => request("POST", "evidence", undefined, v);
  assert.deepEqual((await Promise.all([post(preference), post(preference)])).map(r => r.status).sort(), [200, 201]);
  assert.equal((await post({ ...preference, choice: "right" })).status, 409);
  assert.equal((await post({ ...preference, left: right })).status, 400);
  assert.equal((await post({ ...preference, choice: "maybe" })).status, 400);
  assert.equal((await post({ ...review, artifact: { ...left, artifactSha256: "tip" } })).status, 400);
  assert.equal((await post({ ...review, judge: { ...review.judge, receiptRef: left.receiptRef } })).status, 400);
  assert.equal((await post({ ...review, checks: [{ ...review.checks[0], measurementRef: left.receiptRef }] })).status, 400);
  assert.equal((await post({ ...review, judge: { ...review.judge, receiptRef: review.checks[0].measurementRef } })).status, 400);
  assert.equal((await post({ ...review, editMinutes: "unknown" })).status, 400);
  assert.equal((await post({ ...review, judge: null, checks: [], publishApproved: null })).status, 400);
  assert.equal((await post({ ...preference, unverified: true })).status, 400);
  assert.equal((await post({ ...preference, sourceRef: "x".repeat(17_000) })).status, 413);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM task_evidence").get()!.n, 1);
  const res = await request("GET", path);
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  const d = await res.json() as any;
  assert.equal(d.attestation, "governor_admin");
  assert.equal(d.observations[0].left.artifactSha256, left.artifactSha256);
  assert.equal(d.observations[0].right.receiptRef, right.receiptRef);
  assert.equal(d.workflows.find((w: any) => w.workflow === left.workflow).blindWinTasks, 1);
  assert.equal(d.workflows.find((w: any) => w.workflow === right.workflow).blindLossTasks, 1);
});

test("full-scope workflow scores preserve independent tasks, mixed evidence and missing labels across detail pages", async () => {
  const { request } = fixture();
  const events = [
    preference, { ...preference, evidenceId: "pref-2", choice: "right" },
    { ...preference, evidenceId: "pref-3", taskRef: "abstainer", choice: "abstain" },
    review, { ...review, evidenceId: "review-2", publishApproved: true, editMinutes: 5 },
    { ...review, evidenceId: "review-3", publishApproved: false, editMinutes: 15 },
    { ...review, evidenceId: "review-4", taskRef: "assignment-8", briefSha256: "e".repeat(64), editMinutes: 50,
      checks: [{ ...review.checks[0], passed: false }] },
    { ...review, evidenceId: "review-5", taskClass: "another-class" },
    { ...review, evidenceId: "review-6", rubricSha256: "f".repeat(64) },
  ];
  for (const e of events) assert.equal((await request("POST", "evidence", undefined, e)).status, 201);
  const d = await (await request("GET", path + "&limit=1&workflowLimit=1")).json() as any;
  assert.equal(d.totals.observations, 7);
  assert.equal(d.totals.distinctTasks, 3);
  assert.equal(d.observations.length, 1);
  assert.ok(d.nextAfterWorkflow);
  await request("POST", "evidence", undefined, { ...preference, evidenceId: "new-feedback", choice: "tie", taskRef: "later" });
  const cursor = new URLSearchParams({ ...Object.fromEntries(["fromMs", "toMs", "asOf"].map(k => [k, String(d.scope[k])])),
    before: String(d.nextBefore), afterWorkflow: d.nextAfterWorkflow });
  const next = await (await request("GET", path + "&" + cursor)).json() as any;
  assert.equal(next.totals.observations, 7);
  assert.notEqual(next.observations[0].seq, d.observations[0].seq);
  const w = next.workflows[0];
  assert.equal(w.workflow, left.workflow);
  assert.equal(w.distinctTasks, 3);
  assert.equal(w.distinctBriefs, 2);
  assert.equal(w.blindMixedTasks, 1);
  assert.equal(w.blindAbstainOnlyTasks, 1);
  assert.equal(w.publicationDecisionTasks, 1);
  assert.equal(w.publicationMixedTasks, 1);
  assert.equal(w.publicationDeclinedTasks, 0);
  assert.equal(w.editTimeObservedTasks, 2);
  assert.equal(w.meanEditMinutesPerObservedTask, 30);
  assert.equal(w.subjectivelyJudgedTasks, 2);
  assert.equal(w.measuredTasks, 2);
  assert.equal(w.allObservedChecksPassedTasks, 1);
  assert.equal(w.tasksWithFailedChecks, 1);
  const briefOnly = await (await request("GET", path + "&briefSha256=" + "e".repeat(64))).json() as any;
  assert.equal(briefOnly.totals.observations, 1);
  assert.equal(briefOnly.workflows[0].publicationDecisionTasks, 0);
  assert.equal((await request("GET", path + "&before=7")).status, 400);
  assert.equal((await request("GET", path + "&fromMs=1&toMs=999999999999")).status, 400);
});

test("a thousand retries of one task leave its independent-task denominator at one", async () => {
  const { sqlite, request } = fixture();
  const sql = sqlite.prepare("INSERT INTO task_evidence(evidence_id,task_class,task_ref,brief_sha256,rubric_sha256,created_at,payload_json) VALUES(?,?,?,?,?,?,?)");
  const now = Date.now();
  for (let i = 0; i < 1002; i++) {
    const e = { ...preference, evidenceId: "retry-" + i };
    sql.run(e.evidenceId, e.taskClass, e.taskRef, e.briefSha256, e.rubricSha256, now, JSON.stringify(e));
  }
  const d = await (await request("GET", path + "&limit=1")).json() as any;
  assert.equal(d.totals.observations, 1002);
  assert.equal(d.totals.distinctTasks, 1);
  assert.equal(d.workflows[1].blindWinTasks, 1);
  assert.equal(d.observations.length, 1);
});

test("an existing governor database can apply the additive migration or the runtime upgrade repeatedly", async () => {
  const { sqlite, request } = fixture();
  sqlite.exec("DROP TABLE task_evidence");
  resetSchemaCache();
  assert.equal((await request("POST", "evidence", undefined, review)).status, 201);
  const migrate = read("../migrations/0008_task_evidence.sql");
  sqlite.exec(migrate); sqlite.exec(migrate);
  assert.equal((await request("POST", "evidence", undefined, { ...review, publishApproved: null, editMinutes: null })).status, 200);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM task_evidence").get()!.n, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM caller_policies").get()!.n, 0);
});
