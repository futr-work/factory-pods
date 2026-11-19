#!/usr/bin/env python3
"""Emit an offline Governor evidence batch from a human ballot, sealed mapping and rendered cuts.

A version-1 manifest supplies taskClass, taskRef, voteEvidenceId, rubric (JSON path),
sealedBallot (ZIP path), verdict (operator JSON path), cuts (A/B -> video path),
workflows (sealed workflow key -> {name, stages}), and optional outcomeReceipts
(JSON paths). Paths are relative to the manifest unless absolute.

The ZIP contains workflow-key-and-receipts.json with brief, briefSha256, blindMap
and stageReceipts. Seal workflowBindings (workflow key -> {name, stages}) together
with the map. The outer manifest may repeat these values only verbatim. For the
earlier native direct/plan-execute format, the adapter verifies its known stage
chain and rendered script before applying its historical workflow labels. A ZIP
is a local provenance record, not an attestation by a provider.

The human verdict carries preferredCut (A, B, tie, abstain, or
null), cutHashes, and either the historical operator feedbackSource or
sourceType=human_blind_vote and blind=true. Null means no preference was recorded.
Each separate version-1 human_artifact_outcome receipt binds cut and artifactSha256
to explicit humanEditMinutes and/or approvedToPublish. Record zero only when
measured. Keep the original vote file immutable when adding outcome receipts.
"""

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from zipfile import BadZipFile, ZipFile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      allow_nan=False).encode()


def file_hash(path):
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def label(value, field, limit=150):
    require(isinstance(value, str) and value == value.strip() and 0 < len(value) <= limit
            and not re.search(r"[\x00-\x1f\x7f]", value), f"invalid {field}")
    return value


# These historical aliases were used by the first evidence import. Resolve them
# only for the corresponding native stage topology and verified model selectors.
LEGACY_ROUTES = {
    "direct": {"name": "agy/argon-medium/direct", "stages": ["direct"]},
    "split": {"name": "agy/argon-medium-plan+hydrogen-low-execute", "stages": ["plan", "split"]},
}


def legacy_binding(bundle, workflow, brief_hash):
    require(workflow in LEGACY_ROUTES, "unsealed workflow binding: unknown legacy workflow")
    binding = LEGACY_ROUTES[workflow]
    stages = bundle["stageReceipts"]
    for stage in binding["stages"]:
        row = stages[stage]
        runner = row["runnerReceipt"]
        model = "gemini-4-hydrogen-low" if stage == "split" else "gemini-4-argon-medium"
        require(row["requestedModel"] == model and runner["exit"] == 0 and "agy" in row["runner"],
                f"{stage}: legacy selector/runner mismatch")
        reply_hash = digest(row["reply"].encode())
        if stage == "direct":
            require(row["promptSha256"] == brief_hash and runner["replySha256"] == reply_hash
                    and runner["assistantReplyMatchesGenerationText"] is True,
                    "direct: brief or generated reply mismatch")
            selector, reported, response_id = (runner["selectedModel"], runner["generationModel"],
                                              runner["responseIdInStreamAndCompletedStep"])
        else:
            require(row["briefSha256"] == brief_hash and row["replySha256"] == reply_hash
                    and runner["replyMatchesGeneration"] is True, f"{stage}: brief or reply hash mismatch")
            generated = runner["generationRows"]
            require(len(generated) == 1, f"{stage}: ambiguous native response")
            selector, reported, response_id = (generated[0]["selector"], generated[0]["responseModel"],
                                              generated[0]["responseId"])
        require((selector, reported, response_id) ==
                (row["requestedModel"], row["providerReportedModel"], row["responseId"]),
                f"{stage}: native stage receipt mismatch")
    if workflow == "split":
        plan, final = stages["plan"], stages["split"]
        require((final["planResponseId"], final["planReplySha256"], final["planModel"]) ==
                (plan["responseId"], plan["replySha256"], plan["providerReportedModel"]),
                "split: planning receipt is unrelated to execution")
    production = bundle["productionManifests"][workflow]
    final_text = stages[workflow]["reply"].strip()
    if final_text.startswith("```json") and final_text.endswith("```"):
        final_text = final_text[7:-3].strip()
    script = json.loads(final_text)
    shots = production["shots"]
    require(isinstance(script, list) and shots and len(shots) == len(script),
            f"{workflow}: stage script does not match rendered shots")
    fields = ("start", "end", "vo", "visual", "caption")
    for shot, generated in zip(shots, script):
        require(all(shot[key] == generated[key] for key in fields),
                f"{workflow}: stage script does not match rendered shots")
    voiced = [(n, s["vo"], s["start"], s["end"]) for n, s in enumerate(shots, 1) if s["vo"].strip()]
    timed = [(t["shot"], t["vo"], t["shotStart"], t["shotEnd"]) for t in production["timings"]]
    require(timed == voiced, f"{workflow}: recorded narration differs from final stage script")
    return binding


def collect(path):
    manifest = json.loads(path.read_bytes())
    require(type(manifest["version"]) is int and manifest["version"] == 1, "unsupported manifest version")
    base = path.parent
    rubric = json.loads((base / manifest["rubric"]).read_bytes())
    task_class = label(manifest["taskClass"], "taskClass")
    require(rubric.get("taskClass", task_class) == task_class, "task class differs from rubric")
    with ZipFile(base / manifest["sealedBallot"]) as archive:
        member = "workflow-key-and-receipts.json"
        require(archive.namelist().count(member) == 1, "sealed ballot needs one workflow key")
        bundle = json.loads(archive.read(member))
    brief_hash = digest(bundle["brief"].encode())
    require(brief_hash == bundle["briefSha256"], "brief hash mismatch")
    vote_bytes = (base / manifest["verdict"]).read_bytes()
    vote = json.loads(vote_bytes)
    require(vote.get("feedbackSource") == "Operator chat after blind viewing" or
            (vote.get("sourceType") == "human_blind_vote" and vote.get("blind") is True),
            "missing explicit human blind-vote provenance")
    common = dict(taskClass=task_class, taskRef=label(manifest["taskRef"], "taskRef", 512),
                  briefSha256=brief_hash, rubricSha256=digest(canonical(rubric)))
    ballot_id = label(manifest["voteEvidenceId"], "voteEvidenceId")
    mapping = bundle["blindMap"]
    require(set(mapping) == set(manifest["cuts"]) == set(vote["cutHashes"]) == {"A", "B"},
            "expected matching A/B cut identities")
    subjects = {}
    for cut, record in mapping.items():
        workflow = record["workflow"]
        if "workflowBindings" in bundle:
            route = bundle["workflowBindings"][workflow]
        else:
            route = legacy_binding(bundle, workflow, brief_hash)
        require(manifest["workflows"][workflow] == route,
                f"cut {cut}: workflow name or stage order differs from verified binding")
        video_hash = file_hash(base / manifest["cuts"][cut])
        voted = vote["cutHashes"][cut]
        require(video_hash == record["videoSha256"] == voted["videoSha256"]
                and voted["workflow"] == workflow, f"cut {cut}: artifact or workflow mismatch")
        stages = route["stages"]
        require(isinstance(stages, list) and stages and len(stages) == len(set(stages)),
                f"cut {cut}: expected a distinct list of stages")
        refs = []
        for stage in stages:
            receipt = bundle["stageReceipts"][stage]
            require(re.fullmatch(r"[0-9a-f]{64}", receipt["promptSha256"]), "invalid stage prompt hash")
            refs.append({"stage": label(stage, "stage"), "promptSha256": receipt["promptSha256"],
                         **{k: label(receipt[k], k, 512) for k in
                            ("requestedModel", "providerReportedModel", "responseId")}})
        subjects[cut] = dict(workflow=label(route["name"], "workflow"),
                             receiptRef="sha256:" + digest(canonical(refs)), artifactSha256=video_hash)
    require(subjects["A"]["artifactSha256"] != subjects["B"]["artifactSha256"], "identical artifacts")

    events = []
    preferred = vote.get("preferredCut")
    if preferred is not None:
        choices = {"A": "left", "B": "right", "tie": "tie", "abstain": "abstain"}
        require(preferred in choices, "invalid preferredCut")
        if "preferredWorkflow" in vote:
            require(preferred in mapping and vote["preferredWorkflow"] == mapping[preferred]["workflow"],
                    "preferred workflow contradicts sealed key")
        events.append(dict(common, evidenceId=ballot_id, sourceRef="sha256:" + digest(vote_bytes),
                           kind="blind_preference", left=subjects["A"], right=subjects["B"],
                           choice=choices[preferred]))

    # A global edit time or approval cannot be assigned to a cut by guessing.
    require(vote.get("humanEditMinutes") is None and vote.get("approvedToPublish") is None,
            "put recorded minutes/approval in a hash-bound per-cut outcome receipt")
    observed = set()
    for receipt_path in manifest.get("outcomeReceipts", []):
        raw = (base / receipt_path).read_bytes()
        outcome = json.loads(raw)
        require(type(outcome["version"]) is int and outcome["version"] == 1
                and outcome["sourceType"] == "human_artifact_outcome", "invalid human outcome source")
        cut = outcome["cut"]
        require(cut in subjects and outcome["artifactSha256"] == subjects[cut]["artifactSha256"],
                "outcome cut/hash mismatch")
        minutes, approved = outcome.get("humanEditMinutes"), outcome.get("approvedToPublish")
        require(minutes is None or (type(minutes) in (float, int) and 0 <= minutes <= 2**53 - 1
                                    and math.isfinite(minutes)), "invalid measured human edit minutes")
        require(approved is None or type(approved) is bool, "invalid publication decision")
        for field, value in (("editMinutes", minutes), ("publishApproved", approved)):
            if value is None:
                continue
            require((cut, field) not in observed, f"duplicate {field} receipt for {cut}")
            observed.add((cut, field))
            event = dict(common, evidenceId=label(f"{ballot_id}-{cut}-{field}", "evidenceId"),
                         sourceRef="sha256:" + digest(raw), kind="artifact_review",
                         artifact=subjects[cut], checks=[], judge=None, editMinutes=None, publishApproved=None)
            event[field] = value
            events.append(event)
    return events


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    try:
        events = collect(args.manifest)
    except (OSError, BadZipFile, KeyError, TypeError, ValueError, AttributeError) as error:
        parser.exit(2, f"creative evidence: {error}\n")
    print(json.dumps(events, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
