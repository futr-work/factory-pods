#!/usr/bin/env python3
"""Collect exact-head GitHub CI and review observations. Prints a Governor evidence JSON array.

Requires Python 3, an authenticated GitHub CLI, and a local Git checkout containing the PR head.
Read-only. Never fetches, checks out source, runs the patch, or posts evidence. CI success reports what
the named GitHub App observed on this head; it does not establish hidden-test coverage or overall
correctness. Repo-associated User accounts are GitHub's classification, not proof of a human identity.
Reviews stay subjective; publication approval, editing time and model attribution remain unmeasured.
Recollect after reruns or dismissals to get current state. Previously imported observations remain
historical attestations. PR number anchors the task across retries; event IDs hash immutable snapshots.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

RUBRIC = """coding.github-pr.v1
Artifact: immutable Git commit object of the pull request head. Each app-qualified CI name is evaluated independently.
Only the newest matching check-run ID on that commit is considered. Completed success and failure are observed.
Only the latest substantive decision per independent repository-affiliated GitHub User reviewer for the current commit is considered.
An approved review scores 1; changes requested scores 0. Dismissal clears the decision. Commentary is not a decision.
PR merge and review are not deployment or publication approval. Missing outcomes remain unknown. Model attribution is unknown.
"""
WORKFLOW = "github-pr/unattributed"
SAFE_REPO = re.compile(r"[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+\Z")
SHA = re.compile(r"[0-9a-f]{40}\Z")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def rubric_hash(expected):
    # A pass on one expected check cannot share a scorecard with a full-suite pass.
    spec = [{"app": app, "name": name} for app, name in sorted(expected)]
    return sha256(RUBRIC.encode() + canonical(spec))


def gh_get(endpoint, *, pages=False):
    # GET is explicit. No caller-controlled URL, host, shell interpolation or body.
    cmd = ["gh", "api", "--hostname", "github.com", "--method", "GET",
           "-H", "X-GitHub-Api-Version: 2022-11-28"]
    if pages:
        cmd.extend(["--paginate", "--slurp"])
    result = subprocess.run([*cmd, endpoint], capture_output=True, timeout=90, check=False)
    if result.returncode:
        raise ValueError(f"GitHub GET failed (exit {result.returncode}) at {endpoint.split('?')[0]}")
    return json.loads(result.stdout)


def artifact_hash(checkout, head_sha):
    if not SHA.fullmatch(head_sha):
        raise ValueError("expected GitHub's full lowercase commit SHA")
    # Disable replacement objects so a local replacement/ref cannot affect artifact identity.
    r = subprocess.run(["git", "--no-replace-objects", "-C", str(checkout), "cat-file", "commit", head_sha],
                       capture_output=True, timeout=20)
    if r.returncode:
        raise ValueError("exact PR head commit is absent from the read-only checkout")
    data = b"commit " + str(len(r.stdout)).encode() + b"\x00" + r.stdout
    if hashlib.sha1(data).hexdigest() != head_sha:
        raise ValueError("local commit object differs from the GitHub head")
    return sha256(data)


def expected_checks(values):
    result = []
    for spec in values:
        app, sep, name = spec.partition(":")
        if not (sep and re.fullmatch(r"[a-z0-9][a-z0-9-]*", app) and name.strip() == name and name):
            raise ValueError("each --check must be APP-SLUG:exact check name")
        if len(f"{app}:{name}") > 150 or any(ord(c) < 32 or ord(c) == 127 for c in name):
            raise ValueError("expected check label exceeds the governor's single-line name limit")
        result.append((app, name))
    if len(result) != len(set(result)):
        raise ValueError("duplicate --check")
    return sorted(result)


def collect(repo, number, expected, checkout, *, pinned=None, get=gh_get, hash_artifact=artifact_hash):
    if not SAFE_REPO.fullmatch(repo) or any(x in (".", "..") for x in repo.split("/")) or number < 1:
        raise ValueError("supply a GitHub OWNER/REPO and positive PR number")
    path = f"repos/{repo}/pulls/{number}"
    pr = get(path)
    if pr["base"]["repo"]["full_name"].casefold() != repo.casefold() or pr["number"] != number:
        raise ValueError("GitHub PR metadata does not match the requested repository and number")
    head = pr["head"]["sha"]
    if not SHA.fullmatch(head) or (pinned and pinned != head):
        raise ValueError("PR head does not match the requested SHA")
    artifact = hash_artifact(checkout, head)
    check_pages = get(f"repos/{repo}/commits/{head}/check-runs?filter=all&per_page=100", pages=True)
    runs = {r["id"]: r for page in check_pages for r in page["check_runs"]}
    if not check_pages or any(page.get("total_count") != len(runs) for page in check_pages):
        raise ValueError("incomplete or changing check-run result; repeat the collection")
    review_pages = get(f"{path}/reviews?per_page=100", pages=True)
    reviews = [r for page in review_pages for r in page]
    latest_pr = get(path)
    if any(pr.get(k) != latest_pr.get(k) for k in ("id", "number", "title", "body")) or latest_pr["head"]["sha"] != head:
        raise ValueError("PR head or description changed during collection; repeat it")

    repo_id = pr["base"]["repo"]["id"]
    task_ref = f"github:repo:{repo_id}:pull:{number}"
    run_ref = f"{task_ref}:head:{head}"
    brief = (pr["title"] + "\n\n" + (pr.get("body") or "")).encode("utf-8")
    base = {"taskClass": "coding", "taskRef": task_ref, "briefSha256": sha256(brief), "rubricSha256": rubric_hash(expected),
            "kind": "artifact_review", "artifact": {"workflow": WORKFLOW, "receiptRef": run_ref, "artifactSha256": artifact},
            "publishApproved": None, "editMinutes": None}
    source = {"format": "github-pr-outcomes.v1", "repository": pr["base"]["repo"]["full_name"], "repositoryId": repo_id,
              "pullRequest": number, "pullRequestId": pr["id"], "headSha": head, "mergedAt": latest_pr.get("merged_at"),
              "taskRef": task_ref, "workflowAttribution": "unknown", "briefSource": "snapshot of UTF-8 PR title, two LF bytes, and PR body",
              "briefSha256": base["briefSha256"], "artifactSource": "Git commit object bytes including commit header, size and NUL",
              "artifactSha256": artifact, "rubricSha256": base["rubricSha256"], "expectedChecks": [], "reviewDecisions": [],
              "reviewCoverage": {"offHead": 0, "ineligibleAuthor": 0, "nonDecision": 0}}
    events = []

    def add(ref, *, check=None, judge=None):
        event = {**base, "sourceRef": ref, "checks": [check] if check else [], "judge": judge}
        event["evidenceId"] = "coding-github-" + sha256(canonical(event))
        events.append(event)

    for app, name in expected:
        # Run IDs reflect creation order. An older run finishing later must not override a newly queued retry.
        candidates = [r for r in runs.values() if r.get("head_sha") == head and r.get("app")
                      and r["app"].get("slug") == app and r["name"] == name]
        selected = max(candidates, key=lambda r: r["id"], default=None)
        record = {"app": app, "name": name, "matchingRuns": len(candidates), "observedPass": None}
        if selected:
            conclusion, status = selected.get("conclusion"), selected["status"]
            record.update(runId=selected["id"], appId=selected["app"]["id"], status=status, conclusion=conclusion,
                          completedAt=selected.get("completed_at"))
            if status == "completed" and conclusion in ("success", "failure"):
                passed = conclusion == "success"
                ref = f"github:repo:{repo_id}:check:{selected['id']}:{head}:{conclusion}"
                add(ref, check={"name": f"{app}:{name}", "passed": passed, "measurementRef": ref})
                record["observedPass"] = passed
        else:
            record["status"] = "missing"
        source["expectedChecks"].append(record)

    eligible = {}
    for r in reviews:
        if r.get("commit_id") != head:
            source["reviewCoverage"]["offHead"] += 1
            continue
        u = r.get("user") or {}
        if (u.get("type") != "User" or not u.get("id") or u["id"] == pr["user"]["id"]
                or r.get("author_association") not in ("OWNER", "MEMBER", "COLLABORATOR")):
            source["reviewCoverage"]["ineligibleAuthor"] += 1
            continue
        if not r.get("submitted_at") or r["state"] not in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED"):
            source["reviewCoverage"]["nonDecision"] += 1
            continue
        key = (r["submitted_at"], r["id"])
        if u["id"] not in eligible or key > eligible[u["id"]][0]:
            eligible[u["id"]] = (key, r)
    for uid, (_, r) in sorted(eligible.items()):
        state = r["state"]
        source["reviewDecisions"].append({"reviewerAccountId": uid, "reviewId": r["id"], "state": state,
                                          "submittedAt": r["submitted_at"], "association": r["author_association"]})
        if state != "DISMISSED":
            ref = f"github:repo:{repo_id}:review:{r['id']}:{head}:{state.lower()}"
            add(ref, judge={"name": f"github-user-{uid}", "receiptRef": ref, "score": int(state == "APPROVED"), "maxScore": 1})
    return events, source


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--pr", type=int, required=True)
    parser.add_argument("--head", help="Fail if the current PR head differs from this full commit SHA")
    parser.add_argument("--checkout", type=Path, default=Path.cwd())
    parser.add_argument("--check", required=True, action="append", help="Repeat an expected APP-SLUG:exact check name")
    parser.add_argument("--source-receipt", type=Path, required=True, help="Local JSON destination; created exclusively")
    args = parser.parse_args()
    events, source = collect(args.repo, args.pr, expected_checks(args.check), args.checkout, pinned=args.head)
    # Avoid overwriting operator evidence. The source companion contains no PR body, credentials, or model guess.
    with os.fdopen(os.open(args.source_receipt, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as f:
        json.dump(source, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(json.dumps(events, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, TypeError, OSError, subprocess.TimeoutExpired) as e:
        print(f"coding evidence: {e}", file=sys.stderr)
        sys.exit(1)
