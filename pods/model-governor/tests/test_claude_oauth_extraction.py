"""Offline tests for an OAuth-only, one-generation CSV recovery. No native credentials or network."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).resolve().parents[1] / "bin/claude-oauth-extraction.py"
spec = importlib.util.spec_from_file_location("claude_oauth_extraction", SCRIPT)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
MODEL = "claude-opus-5-5"
REPLY = 'domain,note\r\nexample.org,"13d,12h"'
TOKENS = {"input_tokens": 2, "cache_creation_input_tokens": 50, "cache_read_input_tokens": 11, "output_tokens": 20}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def response():
    return [
        {"type": "system", "subtype": "init", "model": MODEL, "tools": []},
        {"type": "assistant", "message": {"id": "msg_fixture", "model": MODEL, "content": [
            {"type": "thinking", "thinking": "private internal text"}]}},
        {"type": "assistant", "message": {"id": "msg_fixture", "model": MODEL,
                                          "content": [{"type": "text", "text": REPLY}]}},
        {"type": "result", "num_turns": 1, "is_error": False, "subtype": "success", "result": REPLY,
         "modelUsage": {MODEL: {"provider": "firstParty", "canonicalModel": MODEL, "inputTokens": 2,
                                "cacheCreationInputTokens": 50, "cacheReadInputTokens": 11, "outputTokens": 20}},
         "usage": {**TOKENS, "fallback_credit": None, "server_tool_use": {"web_search_requests": 0}}},
    ]


def lines(events):
    return b"\n".join(json.dumps(r).encode() for r in events) + b"\n"


class Recovery(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.prompt = self.root / "prompt.txt"
        self.prompt.write_bytes(b"frozen brief\r\n")
        prev = self.root / "attempt-1"
        prev.mkdir()
        self.inventory = prev / "inventory.csv"
        self.inventory.write_bytes(b" \t\n")
        self.prior = prev / "step.json"
        self.step = {"attempt": 1, "tier": "0", "taskRef": "batch-task", "taskId": "first", "trigger": "empty_output",
                     "http": 200, "finishReason": "length", "requestedRoute": "test:exact", "governorModel": "test:exact",
                     "reportedModel": "exact", "generationId": "receipt-a", "briefSha256": digest(self.prompt.read_bytes()),
                     "artifactBytes": 3, "artifactSha256": digest(self.inventory.read_bytes()),
                     "usage": {"prompt_tokens": 30, "completion_tokens": 101, "total_tokens": 131, "cost": 0}}
        self.d1 = {"id":"use-fixture","task_id":"first","pod_id":"pilot","model_id":"test:exact","provider":"test",
                   "tier":"FREE_TIER","status":"empty_output","cost_usd":0,"prompt_tokens":30,"completion_tokens":101,"total_tokens":131}
        self.d1path = prev / "d1-usage.json"
        self.d1path.write_text(json.dumps(self.d1, indent=2))
        self.step.update(caller="pilot", d1UsageId="use-fixture",
                         d1ReceiptSha256=digest(json.dumps(self.d1, sort_keys=True, separators=(",", ":")).encode()))
        self.prior.write_text(json.dumps(self.step))
        self.out = self.root / "attempt-2"
        self.calls = []

    def fake(self, args, cwd, env, timeout, stdin=b""):
        self.calls.append(list(args))
        self.assertNotIn("ANTHROPIC_API_KEY", env)
        self.assertNotIn("ANTHROPIC_BASE_URL", env)
        self.assertNotIn("HTTPS_PROXY", env)
        self.assertEqual(env["CLAUDE_CODE_NO_MODEL_FALLBACK"], "1")
        if args[1:] == ["auth", "status"]:
            return 0, b'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"private"}'
        for flag, value in (("--max-turns", "1"), ("--model", MODEL), ("--tools", ""), ("--setting-sources", "")):
            self.assertEqual(args[args.index(flag)+1], value)
        self.assertIn("--strict-mcp-config", args)
        self.assertNotIn("--fallback-model", args)
        self.assertEqual(stdin, self.prompt.read_bytes())
        return 0, lines(response())

    def run_helper(self, *, out=None):
        return helper.recover(self.prompt, out or self.out, self.prior, 20)

    def test_success_preserves_exact_text_and_binds_both_inputs(self):
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "private", "ANTHROPIC_BASE_URL": "private"}), patch.object(helper, "invoke", self.fake):
            r = self.run_helper()
        self.assertEqual(len(self.calls), 2)  # auth read plus one generation
        self.assertEqual(r["status"], "returned-ungraded")
        self.assertTrue(r["nativeTurnCompleted"])
        self.assertIsNone(r["stopReason"])
        self.assertEqual((self.out / "inventory.csv").read_bytes(), REPLY.encode())
        self.assertEqual(r["artifactSha256"], digest(REPLY.encode()))
        self.assertEqual(r["priorReceiptSha256"], digest(self.prior.read_bytes()))
        self.assertEqual(r["promptSha256"], digest(self.prompt.read_bytes()))
        self.assertEqual(r["usage"], {**TOKENS, "total_counted_tokens": 83})
        self.assertEqual(r["responseId"], "msg_fixture")
        self.assertFalse(r["transport"]["endsWithLF"])
        self.assertNotIn("private", (self.out/"native.json").read_text())

    def test_invalid_previous_evidence_fails_before_auth(self):
        for change in [{"trigger": "timeout"}, {"attempt": 2}, {"finishReason": "tool_calls"}, {"http": 500},
                       {"artifactSha256": "0"*64}, {"artifactBytes": 9}, {"generationId": ""}, {"tier": 1},
                       {"reportedModel": "substitute"}, {"briefSha256": "changed"}, {"taskId": ""},
                       {"usage": {"cost": 1}}, {"usage": {"prompt_tokens": 0, "completion_tokens": 12001, "total_tokens": 12001}}]:
            with self.subTest(change=change), patch.object(helper, "invoke") as run:
                self.prior.write_text(json.dumps({**self.step, **change}))
                with self.assertRaises(helper.Unverified):
                    self.run_helper()
                run.assert_not_called()
        self.inventory.write_bytes(b"valid,reply")
        self.prior.write_text(json.dumps({**self.step, "artifactSha256": digest(self.inventory.read_bytes()), "artifactBytes": 11}))
        with self.assertRaisesRegex(helper.Unverified, "nonempty"):
            self.run_helper()

    def test_changed_or_unmatched_d1_row_fails_before_auth(self):
        for change in ({"id": "different"}, {"status": "error"}, {"task_id": "other"}, {"cost_usd": False},
                       {"completion_tokens": 100}, {"pod_id": "wrong"}, {"created_at": 1}):
            self.d1path.write_text(json.dumps({**self.d1, **change}))
            with self.subTest(change=change), patch.object(helper, "invoke") as run, self.assertRaises(helper.Unverified):
                self.run_helper()
            run.assert_not_called()

    def test_unreported_primary_cost_stays_unknown(self):
        self.step["usage"].pop("cost")
        self.prior.write_text(json.dumps(self.step))
        with patch.object(helper, "invoke", self.fake):
            self.assertIsNone(self.run_helper()["priorReportedCostUsd"])

    def test_auth_denial_and_first_party_checks(self):
        for i, auth in enumerate(({}, {"loggedIn": True, "authMethod": "api-key", "apiProvider": "firstParty"},
                                  {"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "vertex"})):
            with patch.object(helper, "invoke", return_value=(0, json.dumps(auth).encode())) as run:
                out = self.root / f"denied-{i}"
                with self.assertRaises(helper.Unverified):
                    self.run_helper(out=out)
                self.assertEqual(run.call_count, 1)
                self.assertEqual(json.loads((out/"native.json").read_text())["generationInvocations"], 0)
                self.assertFalse((out/"inventory.csv").exists())

    def test_timeout_consumes_claim_and_replay_is_blocked(self):
        def slow(*args, **kwargs):
            if args[0][1:]==["auth","status"]:
                return self.fake(*args, **kwargs)
            raise subprocess.TimeoutExpired("claude", 20)
        with patch.object(helper, "invoke", slow), self.assertRaisesRegex(helper.Unverified, "time bound"):
            self.run_helper()
        self.assertEqual(json.loads((self.out/"native.json").read_text())["status"], "timeout")
        with patch.object(helper, "invoke", self.fake), self.assertRaisesRegex(helper.Unverified, "already claimed"):
            self.run_helper(out=self.root/"different")
        self.assertFalse((self.out/"inventory.csv").exists())

    def test_concurrent_claim_allows_one_generation(self):
        outputs = [self.root/"a",self.root/"b"]
        barrier = threading.Barrier(2)
        def invoke(args,*a):
            if args[1:] == ["auth","status"]:
                barrier.wait(timeout=3)
            return self.fake(args,*a)
        def launch(out):
            try:
                return self.run_helper(out=out)["generationInvocations"]
            except helper.Unverified:
                return 0
        with patch.object(helper, "invoke", invoke), ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sum(pool.map(launch, outputs)), 1)
        self.assertEqual(sum("-p" in command for command in self.calls), 1)

    def test_attested_native_stop_reasons_and_unknown_are_distinct(self):
        for first, last, expected in ((None, None, None), ("end_turn", None, "end_turn"),
                                      (None, "stop_sequence", "stop_sequence"), ("end_turn", "end_turn", "end_turn")):
            events = response()
            events[2]["message"]["stop_reason"] = first
            events[-1]["stop_reason"] = last
            receipt = {}
            self.assertEqual(helper.attest(lines(events), receipt), REPLY.encode())
            self.assertEqual(receipt["stopReason"], expected)
            self.assertTrue(receipt["nativeTurnCompleted"])
        for first, last in (("end_turn", "stop_sequence"), ("max_tokens", None), (None, "refusal"),
                            ("model_context_window_exceeded", None), (None, "pause_turn"), ("tool_use", None)):
            events = response()
            events[2]["message"]["stop_reason"] = first
            events[-1]["stop_reason"] = last
            with self.subTest(first=first, last=last), self.assertRaises(helper.Unverified):
                helper.attest(lines(events), {})

    def test_model_tool_usage_and_output_drift_are_rejected(self):
        for fault in ("wrong-model", "tool", "init", "response-id", "different-id", "extra-result", "multiturn",
                      "paid-fallback", "missing-usage", "count-drift", "provider", "result-text"):
            ev = response()
            if fault == "wrong-model": ev[2]["message"]["model"] = "another"
            if fault == "tool": ev[2]["message"]["content"].append({"type":"tool_use","name":"Bash"})
            if fault == "init": ev[0]["tools"] = ["Read"]
            if fault == "response-id": del ev[2]["message"]["id"]
            if fault == "different-id": ev[2]["message"]["id"] = "msg_fallback"
            if fault == "extra-result": ev.append(ev[-1])
            if fault == "multiturn": ev[-1]["num_turns"] = 2
            if fault == "paid-fallback": ev[-1]["usage"]["fallback_credit"] = {"id":"private"}
            if fault == "missing-usage": del ev[-1]["usage"]["output_tokens"]
            if fault == "count-drift": ev[-1]["modelUsage"][MODEL]["inputTokens"] = 90
            if fault == "provider": ev[-1]["modelUsage"][MODEL]["provider"] = "proxy"
            if fault == "result-text": ev[-1]["result"] += "\n"
            with self.subTest(fault=fault), self.assertRaises(helper.Unverified):
                helper.attest(lines(ev), {})


if __name__ == "__main__":
    unittest.main()
