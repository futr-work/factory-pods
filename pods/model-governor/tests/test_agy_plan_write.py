"""Offline contract tests; the temporary native executable is this file in fixture mode."""
import hashlib
import json
import os
from pathlib import Path
import runpy
import shlex
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import uuid

RUNNER = Path(__file__).resolve().parents[1] / "bin/agy-plan-write.py"


def integer(n):
    out = bytearray()
    while n >= 128:
        out.append((n & 127) | 128)
        n >>= 7
    return bytes(out) + bytes([n])


def string_field(number, value):
    data = value.encode() if isinstance(value, str) else value
    return integer(8 * number + 2) + integer(len(data)) + data


def fixture():
    arguments = sys.argv[2:]
    read_arg = lambda key: arguments[arguments.index(key) + 1]
    model = read_arg("--model")
    is_plan = model == "gemini-4-argon-medium"
    assert model in ("gemini-4-argon-medium", "gemini-4-hydrogen-low")
    assert read_arg("--effort") == ("medium" if is_plan else "low")
    assert ("--mode" in arguments) == is_plan
    assert "--disable-slash-commands" in arguments
    assert not ({"GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "HTTPS_PROXY"} & os.environ.keys())
    settings = json.loads(read_arg("--settings"))
    assert settings["useG1Credits"] is False and settings["toolPermission"] == "strict"
    assert {"command(*)", "mcp(*)", "read_file(*)", "write_file(*)"} <= set(settings["permissions"]["deny"])
    prompt = read_arg("--print")
    if not is_plan:
        assert "Plan the two shots." in prompt
    fault_file = Path.home() / "fault"
    fault = fault_file.read_text() if fault_file.exists() else ""
    if fault == "write-model":
        fault = "" if is_plan else "model"
    sid, trajectory = str(uuid.uuid4()), str(uuid.uuid4())
    rid = "fixture-response-" + ("plan" if is_plan else "write")
    answer = "Plan the two shots." if is_plan else "An offline script."
    actual = "gemini-4-argon-trial" if is_plan else "gemini-4-hydrogen"
    label = "Gemini 4 Argon (Medium)" if is_plan else "Gemini 4 Hydrogen (Low)"
    metadata = (string_field(3, string_field(28, model)) + string_field(1,
                string_field(19, "unrelated" if fault == "model" else actual) +
                string_field(21, "Gemini 4 Argon (High)" if fault == "effort" else label) +
                string_field(4, string_field(11, rid)) +
                string_field(17, string_field(2, string_field(11, rid))) +
                string_field(2, string_field(3, answer))))
    root = Path.home() / ".gemini/antigravity-cli/conversations"
    root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root / (sid + ".db"))
    db.executescript("""
        CREATE TABLE trajectory_meta(trajectory_id, cascade_id);
        CREATE TABLE steps(idx, step_type, status, step_payload);
        CREATE TABLE gen_metadata(idx, data);
    """)
    db.execute("INSERT INTO trajectory_meta VALUES (?,?)", (trajectory, sid))
    db.execute("INSERT INTO gen_metadata VALUES (0,?)", (metadata,))
    if fault == "multiple":
        db.execute("INSERT INTO gen_metadata VALUES (1,?)", (metadata,))
    db.execute("INSERT INTO steps VALUES (0,14,3,?)", (string_field(19, string_field(2, prompt)),))
    ident = "different" if fault == "id" else rid
    db.execute("INSERT INTO steps VALUES (1,15,3,?)",
               (string_field(20, string_field(1, answer)) + string_field(5, string_field(9, string_field(11, ident))),))
    if fault == "tool":
        db.execute("INSERT INTO steps VALUES (2,90,3,?)", (b"",))
    db.commit()
    db.close()
    auth = "api_key" if fault == "auth" else "consumer"
    Path(read_arg("--log-file")).write_text(
        f"applyAuthResult: authMethod={auth} quotaProject=\n"
        "URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse "
        f"Trace: fixture ResponseID: {rid}\n")
    print(json.dumps({"event": "result", "result": {"response": "other" if fault == "reply" else answer + "\n",
          "conversation_id": sid, "num_turns": 1, "usage": {"input_tokens": 19, "untrustedField": "private"}}}))


class WorkflowTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name)
        # A native executable on PATH lets the whole CLI run with no network or vendor dependencies.
        fake = self.dir / "agy"
        fake.write_text("#!/bin/sh\nexec " + shlex.quote(sys.executable) + " " +
                        shlex.quote(str(Path(__file__).resolve())) + ' fixture "$@"\n')
        fake.chmod(0o700)
        self.brief = self.dir / "brief"
        self.brief.write_text("Write a short, two-shot script.")
        self.env = dict(os.environ, HOME=str(self.dir), PATH=str(self.dir) + os.pathsep + os.environ["PATH"],
                        GEMINI_API_KEY="fixture-never-transmit", PYTHONDONTWRITEBYTECODE="1")

    def workflow(self):
        proc = subprocess.run([sys.executable, str(RUNNER), "--brief", str(self.brief),
                               "--out", str(self.dir / "out"), "--task-ref", "tasks/17", "--task-class", "video"],
                              capture_output=True, text=True, env=self.env, timeout=20)
        path = Path(proc.stdout.strip())
        return proc.returncode, path.parent, json.loads(path.read_text())

    def test_verified_workflow_and_retry_linkage(self):
        rc, folder, result = self.workflow()
        self.assertEqual(rc, 0)
        self.assertEqual((result["attemptedCalls"], result["verifiedGenerations"], result["status"]), (2, 2, "completed"))
        plan, write = result["calls"]
        self.assertEqual(write["parentCallId"], plan["callId"])
        self.assertEqual(write["planSha256"], hashlib.sha256((folder / "plan.txt").read_bytes()).hexdigest())
        self.assertEqual(result["artifact"]["artifactSha256"], hashlib.sha256((folder / "write.txt").read_bytes()).hexdigest())
        self.assertEqual(result["artifact"]["receiptRef"], result["runId"])
        self.assertEqual(write["usage"], {"input_tokens": 19})
        self.assertIsNone(write["providerReportedEffort"])
        _, _, retry = self.workflow()
        self.assertEqual(retry["taskRef"], result["taskRef"])
        self.assertEqual(retry["briefSha256"], result["briefSha256"])
        self.assertNotEqual(retry["runId"], result["runId"])

    def test_unverified_plan_never_advances(self):
        for fault in ("auth", "model", "effort", "reply", "id", "tool", "multiple"):
            with self.subTest(fault=fault):
                (self.dir / "fault").write_text(fault)
                rc, folder, result = self.workflow()
                self.assertNotEqual(rc, 0)
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["calls"][0]["status"], "unverified")
                self.assertEqual((result["attemptedCalls"], result["verifiedGenerations"]), (1, 0))
                self.assertNotIn("artifact", result)
                self.assertFalse((folder / "write.txt").exists())

    def test_unverified_writer_preserves_verified_plan(self):
        (self.dir / "fault").write_text("write-model")
        rc, folder, result = self.workflow()
        self.assertNotEqual(rc, 0)
        self.assertEqual((result["attemptedCalls"], result["verifiedGenerations"]), (2, 1))
        self.assertEqual([call["status"] for call in result["calls"]], ["verified", "unverified"])
        self.assertTrue((folder / "plan.txt").is_file())
        self.assertFalse((folder / "write.txt").exists())
        self.assertNotIn("artifact", result)

    def test_bad_wire_is_rejected(self):
        runner = runpy.run_path(str(RUNNER))
        with self.assertRaises(runner["Unverified"]):
            list(runner["field_values"](b"\x0a\x40", (1,)))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "fixture":
        fixture()
    else:
        unittest.main()
