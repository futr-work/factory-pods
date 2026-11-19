import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile


CLI = Path(__file__).resolve().parents[1] / "bin" / "collect-creative-outcome.py"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()


class CreativeOutcomeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest = {
            "version": 1, "taskClass": "creative.video", "taskRef": "short-1",
            "voteEvidenceId": "short-1-human-pair", "rubric": "rubric.json",
            "sealedBallot": "ballot.zip", "verdict": "vote.json",
            "cuts": {"A": "a.mp4", "B": "b.mp4"},
            "workflows": {"p": {"name": "plan-runner", "stages": ["plan", "run"]},
                          "d": {"name": "one-runner", "stages": ["direct"]}},
        }
        self.rubric = {"taskClass": "creative.video", "version": 1, "preference": "prefer for playback"}
        self.save("rubric.json", self.rubric)
        keys = {}
        for cut, workflow in (("A", "p"), ("B", "d")):
            raw = f"rendered {cut}".encode()
            (self.root / self.manifest["cuts"][cut]).write_bytes(raw)
            keys[cut] = {"workflow": workflow, "videoSha256": sha(raw)}
        self.bundle = {"brief": "sample", "briefSha256": sha(b"sample"), "blindMap": keys,
                       "workflowBindings": json.loads(json.dumps(self.manifest["workflows"])),
                       "stageReceipts": {s: {"responseId": s, "promptSha256": sha(s.encode()),
                                             "requestedModel": "foo", "providerReportedModel": "foo"}
                                         for s in ("direct", "plan", "run")}}
        self.vote = {"feedbackSource": "Operator chat after blind viewing", "preferredCut": "A",
                     "preferredWorkflow": "p", "cutHashes": keys, "approvedToPublish": None,
                     "humanEditMinutes": None, "measurements": {"p": {"nativeGenerations": 2}}}

    def save(self, file, obj):
        (self.root / file).write_text(json.dumps(obj, indent=2) + "\n")

    def invoke(self, valid=True):
        self.save("manifest.json", self.manifest)
        self.save("vote.json", self.vote)
        with ZipFile(self.root / "ballot.zip", "w") as z:
            z.writestr("workflow-key-and-receipts.json", canonical(self.bundle))
        run = subprocess.run([sys.executable, str(CLI), str(self.root / "manifest.json")],
                             text=True, capture_output=True)
        if not valid:
            self.assertEqual((run.returncode, run.stdout), (2, ""), run.stderr)
            return
        self.assertEqual(run.returncode, 0, run.stderr)
        return json.loads(run.stdout)

    def test_blinded_vote_matches_existing_wire_shape_and_stable_refs(self):
        first, = self.invoke()
        refs = [{"stage": s, **self.bundle["stageReceipts"][s]} for s in ("plan", "run")]
        self.assertEqual(first["evidenceId"], "short-1-human-pair")
        self.assertEqual(first["sourceRef"], "sha256:" + sha((self.root / "vote.json").read_bytes()))
        self.assertEqual(first["rubricSha256"], sha(canonical(self.rubric)))
        self.assertEqual(first["left"], {"workflow": "plan-runner", "artifactSha256": sha(b"rendered A"),
                                         "receiptRef": "sha256:" + sha(canonical(refs))})
        self.assertEqual((first["kind"], first["choice"]), ("blind_preference", "left"))
        self.assertNotIn("publishApproved", first)
        self.assertNotIn("editMinutes", first)
        self.assertEqual(self.invoke(), [first])

    def test_cut_bound_outcomes_preserve_zero_false_and_prior_vote(self):
        original, = self.invoke()
        self.manifest["outcomeReceipts"] = ["edits.json", "approval.json"]
        fields = {"version": 1, "sourceType": "human_artifact_outcome"}
        self.save("edits.json", {**fields, "cut": "B", "artifactSha256": sha(b"rendered B"),
                                 "humanEditMinutes": 0})
        self.save("approval.json", {**fields, "cut": "A", "artifactSha256": sha(b"rendered A"),
                                    "approvedToPublish": False})
        vote, edits, approval = self.invoke()
        self.assertEqual(vote, original)
        self.assertEqual((edits["artifact"], edits["editMinutes"], edits["publishApproved"]),
                         (vote["right"], 0, None))
        self.assertEqual((approval["artifact"], approval["editMinutes"], approval["publishApproved"]),
                         (vote["left"], None, False))
        self.assertEqual(edits["sourceRef"], "sha256:" + sha((self.root / "edits.json").read_bytes()))
        self.assertEqual(self.invoke(), [vote, edits, approval])
        self.manifest["outcomeReceipts"].append("edits.json")
        self.invoke(False)

    def test_tie_abstention_and_missing_vote(self):
        del self.vote["preferredWorkflow"]
        for pref, choice in (("tie", "tie"), ("abstain", "abstain"), ("B", "right")):
            self.vote["preferredCut"] = pref
            self.assertEqual(self.invoke()[0]["choice"], choice)
        self.vote["preferredCut"] = None
        self.assertEqual(self.invoke(), [])
        self.vote["preferredCut"] = "C"
        self.invoke(False)

    def test_rejects_unattributed_edits_bad_voter_and_conflicting_workflow(self):
        self.vote["humanEditMinutes"] = 2.5
        self.invoke(False)
        self.vote["humanEditMinutes"] = None
        self.vote["preferredWorkflow"] = "d"
        self.invoke(False)
        self.vote["preferredWorkflow"] = "p"
        self.vote["feedbackSource"] = "model-generated critique"
        self.invoke(False)

    def test_rejects_swapped_stage_lists_and_workflow_aliases_with_unchanged_video_hashes(self):
        for key in ("stages", "name"):
            left, right = self.manifest["workflows"]["p"], self.manifest["workflows"]["d"]
            left[key], right[key] = right[key], left[key]
            self.invoke(False)
            left[key], right[key] = right[key], left[key]
        del self.bundle["workflowBindings"]
        self.invoke(False)

    def test_rejects_altered_artifacts_receipts_and_brief(self):
        self.manifest["outcomeReceipts"] = ["outcome.json"]
        fields = {"version": 1, "sourceType": "human_artifact_outcome", "cut": "A",
                  "artifactSha256": sha(b"rendered A"), "humanEditMinutes": 3.5}
        for invalid in ({"artifactSha256": sha(b"rendered B")}, {"humanEditMinutes": -1},
                        {"humanEditMinutes": True}, {"approvedToPublish": 1}):
            self.save("outcome.json", {**fields, **invalid})
            self.invoke(False)
        self.save("outcome.json", fields)
        self.assertEqual(self.invoke()[1]["editMinutes"], 3.5)
        self.bundle["brief"] = "silently changed"
        self.invoke(False)
        self.bundle["brief"] = "sample"
        (self.root / "a.mp4").write_bytes(b"replacement")
        self.invoke(False)


if __name__ == "__main__":
    unittest.main()
