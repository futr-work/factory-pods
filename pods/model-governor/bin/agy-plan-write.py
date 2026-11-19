#!/usr/bin/env python3
"""One local OAuth workflow. Requires the signed-in Antigravity CLI and Python 3.9+."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone

WORKFLOW = "agy-argon-plan-hydrogen-write-v1"
# An exact selector, response model and generation label observed together in native receipts.
STAGES = (
    ("plan", "gemini-4-argon-medium", "medium", "gemini-4-argon-trial", "Gemini 4 Argon (Medium)"),
    ("write", "gemini-4-hydrogen-low", "low", "gemini-4-hydrogen", "Gemini 4 Hydrogen (Low)"),
)
MAX_BRIEF_BYTES = 48 * 1024
MAX_REPLY_BYTES = 48 * 1024
USAGE_FIELDS = ("input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens")
SETTINGS = {
    "useG1Credits": False, "toolPermission": "strict", "allowNonWorkspaceAccess": False,
    "permissions": {"allow": [], "deny": [
        action + "(*)" for action in
        ("command", "read_file", "write_file", "read_url", "execute_url", "download_url", "mcp")
    ]},
}


class Unverified(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Unverified(message)


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def utc():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, data):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


# Inspect only required protobuf fields. Do not export thoughts, tool payloads or raw logs.
def varint(blob, pos):
    value = 0
    for shift in range(0, 64, 7):
        if pos >= len(blob):
            break
        byte = blob[pos]
        pos += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, pos
    raise Unverified("Invalid native metadata integer")


def field_values(blob, path):
    pos = 0
    while pos < len(blob):
        key, pos = varint(blob, pos)
        number, wire = key >> 3, key & 7
        require(number > 0, "Invalid native metadata tag")
        if wire == 0:
            _, pos = varint(blob, pos)
            continue
        if wire == 2:
            size, pos = varint(blob, pos)
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
        else:
            raise Unverified("Unsupported native metadata encoding")
        end = pos + size
        require(end <= len(blob), "Truncated native metadata")
        if wire == 2 and number == path[0]:
            value = blob[pos:end]
            if len(path) == 1:
                yield value
            else:
                yield from field_values(value, path[1:])
        pos = end


def exact(blob, path, text):
    return list(field_values(blob, path)) == [text.encode("utf-8")]


def attest(db_root, stage, sid, prompt, reply):
    _, selector, _, response_model, label = stage
    require(re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", sid or ""), "Invalid conversation ID")
    dbfile = db_root / (sid + ".db")
    db = sqlite3.connect(dbfile.as_uri() + "?mode=ro", uri=True)
    try:
        db.execute("BEGIN")
        trajectories = db.execute("SELECT trajectory_id,cascade_id FROM trajectory_meta LIMIT 2").fetchall()
        require(len(trajectories) == 1 and trajectories[0][1] == sid, "Unmatched native conversation")
        steps = db.execute("SELECT step_type,status,step_payload FROM steps ORDER BY idx LIMIT 3").fetchall()
        require([(t, s) for t, s, _ in steps] == [(14, 3), (15, 3)], "Expected only completed user and assistant steps")
        require(exact(steps[0][2], (19, 2), prompt), "Recorded user input differs")
        rows = db.execute("SELECT data FROM gen_metadata ORDER BY idx LIMIT 2").fetchall()
        require(len(rows) == 1, "Expected one native generation")
        gen = rows[0][0]
        require(exact(gen, (3, 28), selector) and exact(gen, (1, 19), response_model)
                and exact(gen, (1, 21), label), "Model or native effort label not verified")
        ids = list(field_values(gen, (1, 4, 11)))
        require(len(ids) == 1 and re.fullmatch(rb"[A-Za-z0-9._:-]{1,200}", ids[0]), "Missing generation response ID")
        response_id = ids[0].decode("ascii")
        require(exact(gen, (1, 17, 2, 11), response_id) and exact(steps[1][2], (5, 9, 11), response_id),
                "Unmatched generation and assistant response IDs")
        texts = list(field_values(steps[1][2], (20, 1)))
        require(len(texts) == 1 and texts[0] in field_values(gen, (1, 2, 3)), "Unmatched generated text")
        text = texts[0].decode("utf-8")
        require(text.strip() and text.strip() == reply.strip(), "CLI reply differs from native generation")
        return text, response_id, trajectories[0][0]
    finally:
        db.close()


def native_call(stage, prompt, timeout, binary, db_root):
    name, selector, effort, response_model, label = stage
    # Only the CLI's normal account store supplies credentials. No API key, cloud or proxy override.
    env = {k: os.environ[k] for k in ("HOME", "PATH", "USER", "LOGNAME", "LANG", "TMPDIR", "SYSTEMROOT")
           if k in os.environ}
    with tempfile.TemporaryDirectory(prefix="agy-plan-write-") as folder:
        log = Path(folder) / "cli.log"
        args = [binary, "--model", selector, "--effort", effort, "--disable-slash-commands",
                "--settings", json.dumps(SETTINGS), "--log-file", str(log), "--output-format", "stream-json",
                "--print-timeout", str(timeout) + "s"]
        if name == "plan":
            args += ["--mode", "plan"]
        with tempfile.TemporaryFile() as stdout:
            process = subprocess.Popen(args + ["--print", prompt], cwd=folder, env=env,
                                       stdin=subprocess.DEVNULL, stdout=stdout, stderr=subprocess.DEVNULL,
                                       start_new_session=True)
            try:
                code = process.wait(timeout=timeout + 5)
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            require(code == 0, "Antigravity CLI returned an error")
            stdout.seek(0)
            result = None
            for line in stdout:
                event = json.loads(line)
                if event.get("event") == "result":
                    require(result is None, "Multiple CLI final results")
                    result = event.get("result")
        require(isinstance(result, dict) and result.get("num_turns") == 1, "Expected one final CLI turn")
        reply, sid = result.get("response"), result.get("conversation_id")
        require(isinstance(reply, str) and 0 < len(reply.encode("utf-8")) <= MAX_REPLY_BYTES, "Missing or oversized final text")
        # Read only the local trace; never include account names or authorization data in receipts.
        trace = log.read_text(encoding="utf-8", errors="replace")
        require(re.search(r"\bauthMethod=consumer(?:\s|,|$)", trace), "Consumer OAuth route not confirmed")
        text, response_id, trajectory = attest(db_root, stage, sid, prompt, reply)
        require(any("googleapis.com/v1internal:streamGenerateContent" in line
                    and line.split("ResponseID: ")[-1].strip() == response_id for line in trace.splitlines()),
                "Google stream response ID not confirmed")
        usage = {k: v for k, v in (result.get("usage") or {}).items()
                 if k in USAGE_FIELDS and type(v) is int and v >= 0}
        return text, {"conversationId": sid, "trajectoryId": trajectory, "responseId": response_id,
                      "requestedModel": selector, "requestedEffort": effort, "responseModel": response_model,
                      "nativeModelLabel": label, "providerReportedEffort": None, "usage": usage or None,
                      "quotaDelta": None, "generationCount": 1, "toolCalls": 0}


def run(brief, task_ref, task_class, output, timeout, binary, db_root):
    run_id = str(uuid.uuid4())
    folder = output / run_id
    folder.mkdir(mode=0o700, parents=True)
    manifest = {"workflowId": WORKFLOW, "runId": run_id, "taskRef": task_ref, "taskClass": task_class,
                "briefSha256": digest(brief), "startedAt": utc(), "status": "running", "calls": [],
                "attemptedCalls": 0, "verifiedGenerations": 0}
    path = folder / "receipt.json"
    write_json(path, manifest)
    print(path, flush=True)
    plan = ""
    try:
        for stage in STAGES:
            name = stage[0]
            if name == "plan":
                prompt = brief + "\n\nPlanning stage only. Give the writer a concise plan for this brief. Return only the plan. Do not use tools, files, agents or subagents."
            else:
                prompt = brief + "\n\nUse the following editorial plan to deliver the output requested by the original brief. Return only that deliverable. Do not use tools, files, agents or subagents.\n\n" + plan
            call = {"callId": str(uuid.uuid4()), "stage": name, "promptSha256": digest(prompt),
                    "startedAt": utc(), "status": "attempted"}
            if name == "write":
                parent = manifest["calls"][0]
                call.update(parentCallId=parent["callId"], planSha256=parent["replySha256"])
            manifest["calls"].append(call)
            manifest["attemptedCalls"] += 1
            write_json(path, manifest)
            text, evidence = native_call(stage, prompt, timeout, binary, db_root)
            (folder / (name + ".txt")).write_bytes(text.encode("utf-8"))
            call.update(evidence, status="verified", completedAt=utc(), replySha256=digest(text))
            manifest["verifiedGenerations"] += 1
            if name == "plan":
                plan = text
            write_json(path, manifest)
        manifest.update(status="completed", artifact={"workflow": WORKFLOW, "receiptRef": run_id,
                                                      "artifactSha256": manifest["calls"][-1]["replySha256"]})
    except (Exception, KeyboardInterrupt) as error:
        # Unstructured tool errors can contain prompts, provider responses and local paths.
        reason = str(error) if isinstance(error, Unverified) else type(error).__name__
        manifest.update(status="failed", failure=reason)
        if manifest["calls"] and manifest["calls"][-1]["status"] == "attempted":
            manifest["calls"][-1].update(status="unverified", completedAt=utc())
        raise Unverified(reason) from None
    finally:
        manifest["completedAt"] = utc()
        write_json(path, manifest)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--brief", required=True, type=Path)
    parser.add_argument("--task-ref", required=True)
    parser.add_argument("--task-class", required=True)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--timeout", type=int, default=180, help="Per-stage time limit in seconds (1–300)")
    args = parser.parse_args()
    if not 1 <= args.timeout <= 300:
        parser.error("--timeout must be between 1 and 300")
    for value, limit in ((args.task_ref, 512), (args.task_class, 150)):
        if not value.strip() or len(value) > limit or re.search(r"[\x00-\x1f\x7f]", value):
            parser.error("Task reference and class must be nonempty single-line evidence identifiers")
    with args.brief.open("rb") as stream:
        raw = stream.read(MAX_BRIEF_BYTES + 1)
    if not raw.strip() or len(raw) > MAX_BRIEF_BYTES:
        parser.error("Expected a nonempty UTF-8 brief of at most 48 KiB")
    binary = shutil.which("agy")
    if not binary:
        parser.error("Signed-in Antigravity CLI (agy) required")
    try:
        run(raw.decode("utf-8"), args.task_ref, args.task_class, args.out, args.timeout, binary,
            Path.home() / ".gemini" / "antigravity-cli" / "conversations")
    except (Unverified, OSError, UnicodeError) as error:
        parser.exit(1, f"Workflow failed: {error}\n")


if __name__ == "__main__":
    main()
