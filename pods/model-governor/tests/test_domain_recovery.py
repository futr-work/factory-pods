import argparse
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location("domain_recovery", Path(__file__).resolve().parents[1] / "bin" / "run-domain-extraction.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
MODEL = worker.PRIMARY
NAME = MODEL.partition(":")[2]
USAGE = {"prompt_tokens": 22, "completion_tokens": 2, "total_tokens": 24, "cost": 0}
CSV = ("domain,listing_url,source,evidence,close_time_as_displayed\r\n"
       "example.org,https://a.test/1,Park.io,https://a.test/1,Friday\r\n"
       "example.net,https://b.test/2,Dynadot page 1,https://b.test/2,1h\r\n")
EMPTY = {"code": "empty_output", "type": "governor_error", "status": 502, "requested_model": MODEL,
         "model": MODEL, "served_model": NAME, "finish_reason": "length", "completion_id": "gen-1",
         "usage": USAGE, "usage_event_id": "use_1"}


def chunk(text=None, finish=None, model=NAME, **extra):
    return {"id": "gen-1", "model": model, "choices": [{"index": 0, "delta": {"content": text, **extra},
                                                          "finish_reason": finish}]}


class Response(io.BytesIO):
    status = 200


class Governor:
    def __init__(self, frames):
        self.frames = frames
        self.d1_override = {}
        self.policy_override = {}
        self.posts = []
        self.lookup = []

    def request(self, path, token_file, body=None, headers=None):
        if path == "/api/governor/callers":
            return Response(json.dumps({"callers": [{"callerId": "test", "preferredTier": 0, "maxTier": 0,
                         "effectiveMaxTier": 0, "dailyBudgetUsd": 0, **self.policy_override}]}).encode())
        if path.startswith("/api/governor/usage-receipts?"):
            self.lookup.append(path)
            return Response(json.dumps({"rows": [{"id": "use_1", "pod_id": "test", "task_id": self.posts[0]["taskId"],
                         "model_id": MODEL, "provider": "openrouter", "tier": "FREE_TIER", "status": "empty_output",
                         "cost_usd": 0, "prompt_tokens": 22, "completion_tokens": 2, "total_tokens": 24,
                         **self.d1_override}]}).encode())
        self.posts.append(body)
        assert headers["X-Governor-Caller"] == "test" and headers["X-Governor-Require-Output"] == "text"
        frames = [x if isinstance(x, str) else json.dumps(x) for x in self.frames]
        res = Response(b"".join(b"data: " + f.encode() + b"\n\n" for f in frames))
        res.headers = {"X-Governor-Caller": "test", "X-Governor-Model": MODEL,
                       "X-Governor-Tier": "0", "X-Governor-Attempts": "1", "Content-Type": "text/event-stream"}
        return res


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        p = Path(self.temp.name)
        self.args = argparse.Namespace(park=p / "p.csv", dynadot=p / "d.csv", out=p / "run", caller="test",
                                      model=MODEL, task_ref="stable/original", admin_token_file=None,
                                      client_token_file=None, oauth_on_empty=True)
        self.args.park.write_bytes(b"domain,listing_url,close_time_as_displayed\nexample.org,https://a.test/1,Friday\n")
        self.args.dynadot.write_bytes(b"domain,listing_url,time_left_as_displayed\nexample.net,https://b.test/2,1h\n")
        self.native_calls = 0

    def native(self, prompt, folder, prior):
        self.native_calls += 1
        first = json.loads(prior.read_bytes())
        self.assertEqual(first["d1UsageId"], "use_1")
        self.assertEqual(first["trigger"], "empty_output")
        self.assertFalse(first["accepted"])
        folder.mkdir(exist_ok=False)
        raw = CSV.encode()
        (folder / "inventory.csv").write_bytes(raw)
        worker.save(folder / "native.json", {
            "status": "returned-ungraded", "requestedModel": worker.NATIVE, "providerReportedModel": worker.NATIVE,
            "responseId": "msg-test", "generationInvocations": 1, "turns": 1, "stopReason": None, "nativeTurnCompleted": True,
            "priorReceiptSha256": worker.sha(prior.read_bytes()), "priorTaskId": first["taskId"],
            "priorD1UsageId": first["d1UsageId"], "priorD1ReceiptSha256": first["d1ReceiptSha256"],
            "taskRef": first["taskRef"], "promptSha256": worker.sha(prompt.read_bytes()),
            "auth": {"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty"},
            "artifactSha256": worker.sha(raw), "transport": {"artifactBytes": len(raw), "resultTextByteIdentical": True},
            "usage": {"input_tokens": 12, "output_tokens": 3, "cache_creation_input_tokens": 2,
                      "cache_read_input_tokens": 1, "total_counted_tokens": 18}, "elapsedSeconds": 1.2})

    def test_first_pass_valid_csv_stops_after_one_with_frozen_inputs(self):
        gov = Governor([chunk(CSV), chunk(finish="stop"), {"choices": [], "usage": USAGE}, "[DONE]"])
        r = worker.run(self.args, gov, self.native)
        self.assertEqual((r["firstPass"], r["accepted"], r["totalTokens"], self.native_calls), (True, True, 24, 0))
        body, = gov.posts
        self.assertEqual((body["model"], body["reasoning_effort"], body["max_tokens"]), (MODEL, "low", 12000))
        self.assertEqual(body["messages"][0]["content"].encode(), (self.args.out / "brief.txt").read_bytes())
        self.assertEqual((self.args.out / "attempt-1/inventory.csv").read_bytes(), CSV.encode())
        with self.assertRaises(FileExistsError):
            worker.run(self.args, gov, self.native)
        self.assertEqual(len(gov.posts), 1)

    def test_authorized_verified_empty_recovers_once_with_original_brief_and_ids(self):
        gov = Governor([chunk(" \r\n"), {"error": EMPTY}, "[DONE]"])
        report = worker.run(self.args, gov, self.native)
        self.assertEqual((report["firstPass"], report["accepted"], len(gov.posts), self.native_calls), (False, True, 1, 1))
        self.assertEqual(gov.lookup, ["/api/governor/usage-receipts?id=use_1"])
        self.assertEqual((report["promptTokens"], report["outputTokens"], report["totalTokens"], report["apiCostUsd"],
                          report["oauthQuotaDebit"]), (37, 5, 42, 0, None))
        first, second = report["steps"]
        self.assertEqual((self.args.out / "attempt-1/inventory.csv").read_bytes(), b" \r\n")
        self.assertEqual((first["taskRef"], first["briefSha256"]), (second["taskRef"], second["briefSha256"]))
        self.assertEqual(second["priorTaskId"], first["taskId"])
        batch = json.loads((self.args.out / "batch.json").read_bytes())
        self.assertEqual(len(batch), 2)
        self.assertFalse(batch[0]["checks"][0]["passed"])
        self.assertTrue(all(c["passed"] for c in batch[1]["checks"]))

    def test_nonempty_invalid_csv_is_preserved_and_no_recovery(self):
        gov = Governor([chunk("invalid CSV\r\n"), chunk(finish="stop"), {"choices": [], "usage": USAGE}, "[DONE]"])
        report = worker.run(self.args, gov, self.native)
        self.assertFalse(report["accepted"])
        self.assertEqual(self.native_calls, 0)
        self.assertEqual((self.args.out / "attempt-1/inventory.csv").read_bytes(), b"invalid CSV\r\n")
        self.assertEqual(report["steps"][0]["failedChecks"], ["csv_parse"])

    def test_parseable_but_noncontract_csv_does_not_pass_or_trigger_oauth(self):
        csv_out = CSV.replace("domain,listing_url", "listing_url,domain").replace("example.org,https://a.test/1", "https://a.test/1,EXAMPLE.ORG").replace("example.net,https://b.test/2", "https://b.test/2,example.net")
        r = worker.run(self.args, Governor([chunk(csv_out), chunk(finish="stop"), {"choices": [], "usage": USAGE}, "[DONE]"]), self.native)
        self.assertFalse(r["accepted"])
        self.assertTrue({"lowercase_domains", "exact_csv_header"} <= set(r["steps"][0]["failedChecks"]))
        self.assertNotEqual(worker.sha(worker.canonical(worker.COLLECTOR["RUBRIC"])),
                            json.loads((self.args.out / "frozen.json").read_bytes())["rubricSha256"])
        self.assertEqual(self.native_calls, 0)

    def test_extra_evidence_and_fabricated_close_suffix_do_not_pass(self):
        csv_out = CSV.replace('page 1,https://b.test/2,1h', 'page 1,https://b.test/2 | https://wrong.test,1h remaining at INVENTED')
        r = worker.run(self.args, Governor([chunk(csv_out), chunk(finish="stop"), {"choices": [], "usage": USAGE}, "[DONE]"]), self.native)
        self.assertFalse(r["accepted"])
        self.assertTrue({"verbatim_primary_close", "exact_listing_url_evidence"} <= set(r["steps"][0]["failedChecks"]))
        self.assertEqual(self.native_calls, 0)

    def test_empty_with_no_optin_stops_after_one(self):
        self.args.oauth_on_empty = False
        report = worker.run(self.args, Governor([{"error": EMPTY}, "[DONE]"]), self.native)
        self.assertEqual((report["accepted"], self.native_calls, len(report["steps"])), (False, 0, 1))

    def test_uncorrelated_d1_never_triggers_oauth(self):
        gov = Governor([{"error": EMPTY}, "[DONE]"])
        gov.d1_override = {"task_id": "unrelated"}
        report = worker.run(self.args, gov, self.native)
        self.assertFalse(report["accepted"])
        self.assertNotIn("trigger", report["steps"][0])
        self.assertEqual(self.native_calls, 0)

    def test_untrusted_terminals_and_nontext_never_retry(self):
        testcases = [
            [chunk("visible"), {"error": EMPTY}, "[DONE]"],
            [{"error": EMPTY}],
            [{"error": EMPTY}, chunk(), "[DONE]"],
            [{"error": {**EMPTY, "code": "upstream_error"}}, "[DONE]"],
            [{"error": {**EMPTY, "served_model": "other"}}, "[DONE]"],
            [chunk(refusal="refused"), {"error": EMPTY}, "[DONE]"],
            [chunk(tool_calls=[{"function": {"name": "call"}}]), {"error": EMPTY}, "[DONE]"],
            [{"error": {**EMPTY, "usage": {**USAGE, "cost": None}}}, "[DONE]"],
            [chunk(finish="length"), {"choices": [], "usage": USAGE}, "[DONE]"],
            [chunk(model="other"), "[DONE]"],
        ]
        for i, frames in enumerate(testcases):
            with self.subTest(i=i):
                self.args.out = Path(self.temp.name) / f"run-{i}"
                report = worker.run(self.args, Governor(frames), self.native)
                self.assertEqual((report["accepted"], self.native_calls), (False, 0))
                self.assertNotIn("trigger", report["steps"][0])

    def test_paid_policy_and_paid_selector_fail_before_generation(self):
        gov = Governor([])
        gov.policy_override = {"maxTier": 1}
        report = worker.run(self.args, gov, self.native)
        self.assertFalse(report["accepted"])
        self.args.model = "auto"
        with self.assertRaises(ValueError):
            worker.run(self.args, gov, self.native)
        self.assertFalse(gov.posts)
        self.assertEqual(self.native_calls, 0)
