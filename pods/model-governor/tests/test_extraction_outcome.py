import json
import runpy
import unittest
from pathlib import Path

adapter = runpy.run_path(str(Path(__file__).resolve().parents[1] / "bin/collect-extraction-outcome.py"))
collect = adapter["collect"]
PARK = b"domain,listing_url,close_time_as_displayed\na.test,https://p/a,12:10\nb.test,https://p/b,12:20\n"
DYN = b"domain,listing_url,time_left_as_displayed\nA.TEST,https://d/a,1h\nc.test,https://d/c,3h\n"
HEADER = b"domain,listing_url,source,evidence,close_time_as_displayed\n"
ROWS = (b"a.test,https://p/a,Park.io + Dynadot,https://d/a,12:10\n"
        b"b.test,https://p/b,Park.io,,12:20\n"
        b"c.test,https://d/c,Dynadot page 1,,3h remaining at 2020-01-01T00:00:00Z\n")


def run(rows=ROWS, park=PARK):
    batch, receipt = collect(park, DYN, HEADER + rows, b"actual test brief", "openbot:fixture")
    return batch[0], receipt["measurements"], receipt["passed"]


class ExtractionTest(unittest.TestCase):
    def test_match_and_join(self):
        event, metrics, checks = run()
        self.assertEqual((metrics["overlapOnBothSources"], metrics["sourceUnionDomains"]), (1, 3))
        self.assertTrue(all(checks.values()))
        self.assertEqual(event["artifact"]["workflow"], "unattributed")
        self.assertNotIn("https://", json.dumps(event))
        self.assertNotIn("a.test", json.dumps(event))
        self.assertEqual(event, run()[0])
        self.assertEqual(event["briefSha256"], adapter["sha"](b"actual test brief"))
        self.assertNotEqual(event["checks"][0]["measurementRef"], event["artifact"]["receiptRef"])

    def test_omissions_repeats_unexpected_and_mismatches(self):
        rows = (b"a.test,https://p/a,Park.io,,wrong\n" * 2 +
                b"z.test,https://p/z,Park.io,,12:10\n,https://d/c,Dynadot page 1,,3h\n")
        event, m, checks = run(rows)
        for key, value in (("omittedSourceDomains", 2), ("duplicateArtifactRows", 1),
                           ("unexpectedDomainRows", 1), ("blankDomainRows", 1),
                           ("sourceLabelMismatchRows", 2), ("listingUrlMismatchRows", 2),
                           ("displayedCloseMismatchRows", 2)):
            self.assertEqual(m[key], value)
        self.assertFalse(any(checks.values()))
        self.assertNotEqual(event["evidenceId"], run()[0]["evidenceId"])

    def test_evidence_is_per_domain_and_primary_source(self):
        _, m, _ = run(ROWS.replace(b"https://p/a,Park.io + Dynadot,https://d/a,12:10",
                                   b"https://d/a,Park.io + Dynadot,https://p/a,1h"))
        self.assertEqual(m["displayedCloseMismatchRows"], 0)
        self.assertEqual(m["listingUrlMismatchRows"], 0)
        self.assertEqual(run(ROWS.replace(b"https://d/a,12:10", b"https://d/abc,12:10"))[1]["listingUrlMismatchRows"], 1)

    def test_bad_source_cannot_define_truth(self):
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            run(park=PARK + b"a.test,https://p/wrong,12:10\n")
        self.assertEqual(run(park=PARK + b"a.test,https://p/a,12:10\n")[1]["duplicatesWithinCapture"]["park"], 1)
        with self.assertRaisesRegex(ValueError, "empty"):
            run(park=PARK.splitlines(keepends=True)[0])
        with self.assertRaisesRegex(ValueError, "column"):
            run(park=b"domain\na.test\n")
        self.assertFalse(run(b"")[2]["source_labels_match"])


if __name__ == "__main__":
    unittest.main()
