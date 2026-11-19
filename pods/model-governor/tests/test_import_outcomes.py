import json
from http.client import IncompleteRead
import runpy
import tempfile
import unittest
from pathlib import Path

module = runpy.run_path(str(Path(__file__).resolve().parents[1] / "bin/import-outcomes.py"))


class TestImport(unittest.TestCase):
    def test_replay_after_interrupted_ack(self):
        events = {"one": b"1", "two": b"2"}
        state = {}
        def post(data):
            n = int(data)
            new = n not in state
            state[n] = True
            if new and n == 2:
                raise IncompleteRead(b"truncated")
            return (201 if new else 200, {"evidenceId": ["one", "two"][n-1], "created": new, "seq": n})
        self.assertEqual(module["import_batches"](events, post)["stoppedAt"], "two")
        r = module["import_batches"](events, post)
        self.assertEqual([x["result"] for x in r["receipts"]], ["already_recorded"]*2)

    def test_conflict_across_batches_before_send(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)/"a.json"
            item = dict(kind="artifact_review", evidenceId="k", taskRef="t", taskClass="c",
                        rubricSha256="r", briefSha256="b")
            p.write_text(json.dumps([item, item]))
            self.assertEqual(len(module["read_events"]([p])), 1)
            p.write_text(json.dumps([dict(item, evidenceId=" k ")]))
            with self.assertRaisesRegex(ValueError, "noncanonical"):
                module["read_events"]([p])
            p.write_text(json.dumps([item, dict(item, taskRef="other")]))
            with self.assertRaisesRegex(ValueError, "conflicting"):
                module["read_events"]([p])

    def test_reject_redirect(self):
        self.assertIsNone(module["NoRedirect"]().redirect_request(None, None, 307, "", {}, "https://other.example"))

if __name__ == "__main__":
    unittest.main()
