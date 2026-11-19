import type { PodStorage } from "@futr-work/pod-kernel/storage";

export class EvidenceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const invalid = (message: string): never => { throw new EvidenceError(400, message); };
const MAX_BYTES = 16_384;
const commonFields = ["evidenceId", "taskClass", "taskRef", "briefSha256", "rubricSha256", "sourceRef", "kind"];
const artifactFields = ["workflow", "receiptRef", "artifactSha256"];

function object(value: unknown, name: string, allowed?: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(`${name} must be an object`);
  if (allowed && Object.keys(value).some(k => !allowed.includes(k))) return invalid(`${name} contains an unknown field`);
  return value as Record<string, unknown>;
}

export function evidenceLabel(value: unknown, name: string, max = 150): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    return invalid(`${name} must be a non-empty single-line string of at most ${max} characters`);
  }
  return value.trim();
}

export function evidenceHash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) return invalid(`${name} must be lowercase SHA-256 hex`);
  return value;
}

function number(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    return invalid(`${name} must be a finite non-negative number`);
  }
  return value;
}

function artifact(value: unknown) {
  const a = object(value, "artifact", artifactFields);
  return { workflow: evidenceLabel(a.workflow, "workflow"), receiptRef: evidenceLabel(a.receiptRef, "receiptRef", 512),
    artifactSha256: evidenceHash(a.artifactSha256, "artifactSha256") };
}

function validate(value: unknown) {
  const raw = object(value, "evidence");
  const common = {
    evidenceId: evidenceLabel(raw.evidenceId, "evidenceId"), taskClass: evidenceLabel(raw.taskClass, "taskClass"),
    taskRef: evidenceLabel(raw.taskRef, "taskRef", 512), briefSha256: evidenceHash(raw.briefSha256, "briefSha256"),
    rubricSha256: evidenceHash(raw.rubricSha256, "rubricSha256"), sourceRef: evidenceLabel(raw.sourceRef, "sourceRef", 512),
  };
  if (raw.kind === "blind_preference") {
    object(raw, "blind preference", [...commonFields, "left", "right", "choice"]);
    const left = artifact(raw.left), right = artifact(raw.right);
    if (left.artifactSha256 === right.artifactSha256) return invalid("blind preference requires two distinct artifact hashes");
    if (!["left", "right", "tie", "abstain"].includes(String(raw.choice)) || typeof raw.choice !== "string") {
      return invalid("choice must be left, right, tie or abstain");
    }
    return { ...common, kind: raw.kind, left, right, choice: raw.choice };
  }
  if (raw.kind !== "artifact_review") return invalid("kind must be blind_preference or artifact_review");
  object(raw, "artifact review", [...commonFields, "artifact", "checks", "judge", "publishApproved", "editMinutes"]);
  const subject = artifact(raw.artifact);
  const list = raw.checks === undefined ? [] : raw.checks;
  if (!Array.isArray(list) || list.length > 16) return invalid("checks must be an array containing at most 16 measurements");
  const checks = list.map(value => {
    const c = object(value, "check", ["name", "passed", "measurementRef"]);
    if (typeof c.passed !== "boolean") return invalid("check.passed must be boolean");
    const measurementRef = evidenceLabel(c.measurementRef, "measurementRef", 512);
    if (measurementRef === subject.receiptRef) return invalid("a measurement needs its own independent receipt");
    return { name: evidenceLabel(c.name, "check.name"), passed: c.passed, measurementRef };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (new Set(checks.map(c => c.name)).size !== checks.length) return invalid("check names must be unique within a review");
  let judge = null;
  if (raw.judge != null) {
    const j = object(raw.judge, "judge", ["name", "score", "maxScore", "receiptRef"]);
    const name = evidenceLabel(j.name, "judge.name"), receiptRef = evidenceLabel(j.receiptRef, "judge.receiptRef", 512);
    const score = number(j.score, "judge.score"), maxScore = number(j.maxScore, "judge.maxScore");
    if (maxScore === 0 || score > maxScore) return invalid("judge score must fit a positive maximum");
    if (receiptRef === subject.receiptRef || name === subject.workflow) return invalid("a judge must be distinct from the evaluated workflow and receipt");
    if (checks.some(check => check.measurementRef === receiptRef)) return invalid("a subjective judge receipt cannot supply an independent measurement");
    judge = { name, score, maxScore, receiptRef };
  }
  if (raw.publishApproved != null && typeof raw.publishApproved !== "boolean") return invalid("publishApproved must be boolean or null");
  const publishApproved = raw.publishApproved ?? null;
  const editMinutes = raw.editMinutes == null ? null : number(raw.editMinutes, "editMinutes");
  if (!checks.length && !judge && publishApproved === null && editMinutes === null) return invalid("artifact review needs at least one observed outcome");
  return { ...common, kind: raw.kind, artifact: subject, checks, judge, publishApproved, editMinutes };
}

async function readInput(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return invalid("expected a JSON evidence object");
  const decoder = new TextDecoder();
  let bytes = 0, text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BYTES) {
      void reader.cancel().catch(() => {});
      throw new EvidenceError(413, "evidence exceeds 16 KiB");
    }
    text += decoder.decode(value, { stream: true });
  }
  try { return JSON.parse(text + decoder.decode()); } catch { return invalid("invalid JSON evidence"); }
}

/** One immutable event per idempotency key. Canonical field and check order make object key order immaterial. */
export async function saveEvidence(db: PodStorage, request: Request) {
  const e = validate(await readInput(request)), payload = JSON.stringify(e);
  const inserted = await db.prepare(`INSERT INTO task_evidence
    (evidence_id, task_class, task_ref, brief_sha256, rubric_sha256, created_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(evidence_id) DO NOTHING RETURNING seq`)
    .bind(e.evidenceId, e.taskClass, e.taskRef, e.briefSha256, e.rubricSha256, Date.now(), payload).first<{ seq: number }>();
  if (inserted) return { created: true, evidenceId: e.evidenceId, seq: inserted.seq };
  const existing = await db.prepare("SELECT seq, payload_json FROM task_evidence WHERE evidence_id = ?")
    .bind(e.evidenceId).first<{ seq: number; payload_json: string }>();
  if (existing?.payload_json !== payload) throw new EvidenceError(409, "evidenceId already identifies a different observation");
  return { created: false, evidenceId: e.evidenceId, seq: existing.seq };
}
