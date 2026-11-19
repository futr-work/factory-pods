import copy
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / "bin/collect-coding-outcome.py"
spec = importlib.util.spec_from_file_location("collect_coding_outcome", MODULE)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
HEAD = "3" * 40
PR = {"id": 123, "number": 9, "user": {"id": 10}, "title": "Fix parsing", "body": "Preserve empty values.",
      "merged_at": "2026-03-05T11:00:00Z", "base": {"repo": {"id": 444, "full_name": "demo/parse"}}, "head": {"sha": HEAD}}
CHECK = ("github-actions", "verify")


def run(n, conclusion, *, head=HEAD, app="github-actions", name="verify"):
    return {"id": n, "head_sha": head, "name": name, "app": {"slug": app, "id": 15368},
            "status": "completed" if conclusion else "queued", "conclusion": conclusion}


def review(n, state, *, uid=20, head=HEAD, kind="User", association="MEMBER"):
    return {"id": n, "state": state, "commit_id": head, "author_association": association,
            "submitted_at": f"2026-03-03T15:{n:02d}:00Z", "user": {"id": uid, "type": kind}}


class Snapshot:
    def __init__(self, checks=(), reviews=()):
        self.runs = list(checks)
        self.reviews = list(reviews)
        self.last = copy.deepcopy(PR)
        self.metadata_reads = 0
        self.total = len(self.runs)

    def get(self, path, *, pages=False):
        if path == "repos/demo/parse/pulls/9":
            self.metadata_reads += 1
            return PR if self.metadata_reads == 1 else self.last
        if path == f"repos/demo/parse/commits/{HEAD}/check-runs?filter=all&per_page=100" and pages:
            return [{"total_count": self.total, "check_runs": self.runs[:1]},
                    {"total_count": self.total, "check_runs": self.runs[1:]}]
        if path == "repos/demo/parse/pulls/9/reviews?per_page=100" and pages:
            return [self.reviews[:1], self.reviews[1:]]
        raise AssertionError(f"unexpected data source {path}")

    def collect(self, expected=(CHECK,)):
        return adapter.collect("demo/parse", 9, expected, ".", pinned=HEAD, get=self.get,
                               hash_artifact=lambda _path, _sha: "c" * 64)


class CodingEvidence(unittest.TestCase):
    def test_latest_app_and_sha_bound_check_with_separate_independent_review(self):
        snapshot = Snapshot([run(2, "failure"), run(5, "success"), run(9, "failure", app="other"),
                             run(12, "failure", head="d"*40), run(13, "success", name="other")],
                            [review(1, "CHANGES_REQUESTED"), review(3, "APPROVED"), review(5, "COMMENTED"),
                             review(7, "CHANGES_REQUESTED", uid=10), review(8, "APPROVED", uid=30, kind="Bot"),
                             review(9, "APPROVED", uid=40, head="e"*40), review(10, "APPROVED", uid=50, association="NONE")])
        events, receipt = snapshot.collect()
        self.assertEqual(len(events), 2)
        self.assertEqual(receipt["expectedChecks"][0]["runId"], 5)
        self.assertEqual(receipt["reviewDecisions"][0]["reviewId"], 3)
        self.assertEqual(receipt["reviewCoverage"], {"offHead": 1, "ineligibleAuthor": 3, "nonDecision": 1})
        self.assertEqual(events[0]["checks"], [{"name": "github-actions:verify", "passed": True,
                                                "measurementRef": events[0]["sourceRef"]}])
        self.assertEqual(events[1]["judge"]["score"], 1)
        self.assertEqual(events[1]["checks"], [])
        self.assertTrue(all(e["artifact"]["workflow"] == "github-pr/unattributed" for e in events))
        self.assertTrue(all(e["taskRef"] == "github:repo:444:pull:9" for e in events))
        self.assertTrue(all(e["publishApproved"] is None for e in events))
        self.assertEqual(receipt["rubricSha256"], adapter.rubric_hash([CHECK]))

    def test_unknown_and_dismissed_results_never_become_failure_or_approval(self):
        for conclusion in (None, "skipped", "neutral", "cancelled", "timed_out"):
            events, receipt = Snapshot([run(1, "success"), run(3, conclusion)],
                                       [review(1, "APPROVED"), review(3, "DISMISSED")]).collect()
            self.assertEqual(events, [])
            self.assertIsNone(receipt["expectedChecks"][0]["observedPass"])
            self.assertEqual(receipt["reviewDecisions"][0]["state"], "DISMISSED")
        events, receipt = Snapshot().collect()
        self.assertEqual(events, [])
        self.assertEqual(receipt["expectedChecks"][0]["status"], "missing")

    def test_snapshot_ids_are_stable_on_replay_and_change_only_for_the_replaced_observation(self):
        s = Snapshot([run(1, "success")], [review(1, "CHANGES_REQUESTED")])
        a, _ = s.collect()
        b, _ = s.collect()
        self.assertEqual(a, b)
        self.assertEqual(a[1]["judge"]["score"], 0)
        s.runs.append(run(3, "failure"))
        s.total += 1
        c, _ = s.collect()
        self.assertFalse(c[0]["checks"][0]["passed"])
        self.assertEqual(a[0]["taskRef"], c[0]["taskRef"])
        self.assertNotEqual(a[0]["evidenceId"], c[0]["evidenceId"])
        self.assertEqual(a[1], c[1])

    def test_changed_head_or_incomplete_check_pagination_is_rejected(self):
        s = Snapshot([run(1, "success")])
        s.last["head"]["sha"] = "f"*40
        with self.assertRaisesRegex(ValueError, "changed during"):
            s.collect()
        s = Snapshot()
        s.total = 4
        with self.assertRaisesRegex(ValueError, "incomplete"):
            s.collect()

    def test_check_suite_version_separates_rubrics_and_is_order_independent(self):
        other = ("github-actions", "gitleaks")
        fixture = Snapshot([run(1, "success")])
        one, _ = fixture.collect()
        both, s = fixture.collect([CHECK, other])
        reordered, t = fixture.collect([other, CHECK])
        self.assertNotEqual(one[0]["rubricSha256"], both[0]["rubricSha256"])
        self.assertNotEqual(one[0]["evidenceId"], both[0]["evidenceId"])
        self.assertEqual(s["rubricSha256"], t["rubricSha256"])
        self.assertEqual(both, reordered)

    def test_check_names_require_app_qualification(self):
        self.assertEqual(adapter.expected_checks(["github-actions:build, check, test"]), [("github-actions", "build, check, test")])
        for bad in (["verify"], ["app:"], ["app:a", "app:a"], ["app:a\nb"]):
            with self.assertRaises(ValueError):
                adapter.expected_checks(bad)

    def test_git_hash_is_object_bytes_even_with_dirty_worktree(self):
        with tempfile.TemporaryDirectory() as d:
            def git(*args):
                return subprocess.check_output(["git", "-C", d, *args], stderr=subprocess.DEVNULL)
            git("init", "-q")
            f = Path(d) / "something"
            f.write_text("original")
            git("add", "something")
            git("-c", "user.email=local@example.com", "-c", "user.name=test", "-c", "commit.gpgSign=false",
                "commit", "-qm", "initial")
            sha = git("rev-parse", "HEAD").decode().strip()
            raw = git("cat-file", "commit", sha)
            f.write_text("dirty")
            expected = hashlib.sha256(b"commit " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
            self.assertEqual(adapter.artifact_hash(d, sha), expected)
            with self.assertRaisesRegex(ValueError, "absent"):
                adapter.artifact_hash(d, "f"*40)
            with self.assertRaisesRegex(ValueError, "full lowercase"):
                adapter.artifact_hash(d, "--help")


if __name__ == "__main__":
    unittest.main()
