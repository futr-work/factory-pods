import argparse
import importlib.util
import io
import json
import tempfile
import urllib.error
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
        self.headers = []
        self.http_error = None
        self.network_error = None
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
        self.headers.append(headers)
        if self.network_error is not None:
            raise self.network_error
        if self.http_error is not None:
            raise urllib.error.HTTPError("https://test.invalid", 504, "Gateway Timeout",
                                         {"X-Governor-Caller": "test", "X-Governor-Model": MODEL,
                                          "X-Governor-Tier": "0", "X-Governor-Attempts": "1",
                                          "Content-Type": "application/json"},
                                         io.BytesIO(json.dumps(self.http_error).encode()))
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
        self.assertIn(first["trigger"], ("empty_output", "upstream_timeout"))
        self.assertFalse(first["accepted"])
        folder.mkdir(exist_ok=False)
        raw = CSV.encode()
        (folder / "inventory.csv").write_bytes(raw)
        worker.save(folder / "native.json", {
            "status": "returned-ungraded", "requestedModel": worker.NATIVE, "providerReportedModel": worker.NATIVE,
            "responseId": "msg-test", "generationInvocations": 1, "turns": 1, "stopReason": None, "nativeTurnCompleted": True,
            "trigger": first["trigger"], "priorTimeoutMs": first.get("timeoutMs"),
            "priorTimeoutFingerprintSha256": first.get("timeoutFingerprintSha256"),
            "priorReceiptSha256": worker.sha(prior.read_bytes()), "priorTaskId": first["taskId"],
            "priorD1UsageId": first["d1UsageId"], "priorD1ReceiptSha256": first["d1ReceiptSha256"],
            "taskRef": first["taskRef"], "promptSha256": worker.sha(prompt.read_bytes()),
            "auth": {"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty"},
            "artifactSha256": worker.sha(raw), "transport": {"artifactBytes": len(raw), "resultTextByteIdentical": True},
            "usage": {"input_tokens": 12, "output_tokens": 3, "cache_creation_input_tokens": 2,
                      "cache_read_input_tokens": 1, "total_counted_tokens": 18}, "elapsedSeconds": 1.2})

    def timeout_governor(self, usage=None, ms=120000, served=None, gen=None, pre_headers=False):
        usage = {} if usage is None else usage
        metadata = {"requested_model": MODEL, "model": MODEL, "served_model": served, "completion_id": gen,
                    "timeout_ms": ms, "usage_state": "partial" if usage else "unknown", "usage": usage}
        err = dict(metadata, type="governor_error", code="upstream_timeout", status=504,
                   finish_reason=None, usage_event_id="use_1")
        gov = Governor([{"error": err}, "[DONE]"])
        if pre_headers:
            gov.http_error = {"error": err}
        gov.d1_override = {"status": "upstream_timeout", "recovery_metadata_json": json.dumps(metadata),
                           "prompt_tokens": usage.get("prompt_tokens", 0), "completion_tokens": usage.get("completion_tokens", 0),
                           "total_tokens": usage.get("total_tokens", usage.get("prompt_tokens", 0) + usage.get("completion_tokens", 0))}
        return gov

    def test_verified_preheader_timeout_with_unknown_usage_retains_one_oauth_attempt(self):
        self.args.oauth_on_timeout = True
        self.args.upstream_timeout_ms = 1800
        gov = self.timeout_governor(pre_headers=True, ms=1800)
        r = worker.run(self.args, gov, self.native)
        self.assertEqual((len(gov.posts), self.native_calls, r["firstPass"], r["accepted"]), (1, 1, False, True))
        self.assertEqual((gov.posts[0]["max_tokens"], gov.headers[0]["X-Governor-Timeout-Ms"]), (12000, "1800"))
        self.assertEqual(gov.headers[0]["X-Governor-Recover-On"], "upstream_timeout")
        a, b = r["steps"]
        self.assertEqual((a["http"], a["usageState"], a["usage"], a["reportedModel"], a["generationId"]),
                         (504, "unknown", {}, None, None))
        self.assertEqual((a["quality"]["status"], b["trigger"], b["quality"]["uniqueReturnedDomains"]),
                         ("ungraded_no_deliverable", "upstream_timeout", 2))
        self.assertEqual((r["totalTokens"], r["apiCostUsd"], r["observedPrimaryCostUsd"], r["verifiedGenerations"]),
                         (None, None, None, 1))
        self.assertEqual(r["observedTokenSubtotals"], {"prompt": 15, "output": 3, "combined": 18})
        self.assertEqual(len(json.loads((self.args.out / "batch.json").read_bytes())), 1)
        packet = json.loads((self.args.out / "attempt-1/upstream-timeout.json").read_bytes())
        self.assertEqual(worker.sha(worker.canonical(packet)), a["timeoutFingerprintSha256"])
        self.assertEqual(b["priorTaskId"], a["taskId"])

    def test_bounded_sse_timeout_keeps_observed_counts_separate_from_d1_placeholders(self):
        self.args.oauth_on_timeout = True
        self.args.oauth_on_empty = False
        for i, usage in enumerate([{"total_tokens": 24}, {"completion_tokens": 2, "completion_tokens_details": {"reasoning_tokens": 1}}]):
            with self.subTest(usage=usage):
                self.args.out = Path(self.temp.name) / f"part-{i}"
                gov = self.timeout_governor(usage, served=NAME, gen="gen-1")
                gov.frames.insert(0, chunk(" "))
                r = worker.run(self.args, gov, self.native)
                self.assertTrue(r["accepted"])
                self.assertEqual(gov.headers[0].get("X-Governor-Timeout-Ms"), None)
                self.assertEqual(r["steps"][0]["usage"], usage)
                self.assertIsNone(r["totalTokens"])
                self.assertEqual(r["observedTokenSubtotals"]["combined"], [42, 20][i])
                self.assertEqual((r["verifiedGenerations"], r["observedGenerationIds"]), (1, 2))
                self.assertEqual((self.args.out / "attempt-1/inventory.csv").read_bytes(), b" ")

    def test_unknown_primary_and_failed_recovery_never_imply_zero_measured_tokens(self):
        self.args.oauth_on_timeout = True
        def failed(*_):
            raise ValueError("native auth unavailable")
        r = worker.run(self.args, self.timeout_governor(), failed)
        self.assertEqual(r["observedTokenSubtotals"], {"prompt": None, "output": None, "combined": None})
        self.assertIsNone(r["totalTokens"])
        self.assertFalse(r["accepted"])

    def test_unauthorized_incomplete_or_uncorrelated_timeout_never_recovers(self):
        def malformed(g): g.http_error = {"error": {"message": "upstream timed out"}}
        def local(g): g.network_error = TimeoutError("local timeout")
        def partial(g): g.frames.insert(0, chunk("exam"))
        def interrupted(g): g.frames.pop()
        def cancelled(g): g.d1_override["status"] = "cancelled"
        def unconfirmed(g): g.d1_override["recovery_metadata_json"] = "{}"
        def fake_identity(g): g.frames[0]["error"]["served_model"] = "other"
        def swapped_generation(g): g.frames.insert(0, chunk())
        def wrong_timeout(g): g.frames[0]["error"]["timeout_ms"] = 1300
        def refusal(g): g.frames.insert(0, chunk(refusal="No"))
        def already_finished(g): g.frames.insert(0, chunk(finish="stop"))
        def illogical(g): g.frames[0]["error"]["usage"] = {"prompt_tokens": 10, "total_tokens": 1}
        for i, mutate in enumerate((None, malformed, local, partial, interrupted, cancelled, unconfirmed,
                                    fake_identity, swapped_generation, wrong_timeout, refusal, already_finished, illogical)):
            with self.subTest(case=mutate):
                self.args.out = Path(self.temp.name) / f"bad-{i}"
                self.args.oauth_on_timeout = mutate is not None
                gov = self.timeout_governor()
                if mutate:
                    mutate(gov)
                r = worker.run(self.args, gov, self.native)
                self.assertFalse(r["accepted"])
                self.assertNotIn("trigger", r["steps"][0])
                self.assertEqual(self.native_calls, 0)

    def test_override_is_only_valid_within_authorized_bounds(self):
        for flag, ms in ((False, 1000), (True, 999), (True, 120001)):
            self.args.oauth_on_timeout, self.args.upstream_timeout_ms = flag, ms
            with self.assertRaises(ValueError):
                worker.run(self.args, Governor([]), self.native)
            self.assertFalse(self.args.out.exists())

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
