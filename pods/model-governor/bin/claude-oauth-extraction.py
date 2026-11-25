#!/usr/bin/env python3
"""One native Claude OAuth recovery after a verified empty completion or explicitly authorized upstream timeout.

The coordinator supplies a UTF-8 prompt and a new output directory. The triggering step.json
and its sibling inventory.csv and d1-usage.json must come from the trusted local coordinator, which authenticates
its direct, no-redirect HTTPS call. Local hashes verify integrity and do not authenticate arbitrary
caller-supplied receipts. A separate exclusive claim prevents another generation
from that step directory. A verified output preserves the assistant's exact text, including newlines.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

MODEL = "claude-opus-5-5"
EFFORT = "medium"
MAX_TIMEOUT = 210
USAGE_FIELDS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")


class Unverified(Exception):
    pass


def require(ok, reason):
    if not ok:
        raise Unverified(reason)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def utc():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def verify_empty_completion(step, row, route):
    require(step.get("http") == 200 and step.get("finishReason") in ("stop", "length"), "requires a completed empty_output step")
    usage = step.get("usage")
    require(isinstance(usage, dict) and all(type(usage.get(k)) is int and usage[k] >= 0
            for k in ("prompt_tokens", "completion_tokens", "total_tokens"))
            and usage["completion_tokens"] <= 12000 and usage["total_tokens"] == usage["prompt_tokens"] + usage["completion_tokens"]
            and (usage.get("cost") is None or type(usage["cost"]) in (int, float) and usage["cost"] == 0),
            "prior free-tier usage is missing or outside its bound")
    require(route.partition(":")[2] == step.get("reportedModel") and isinstance(step.get("generationId"), str)
            and bool(step["generationId"].strip()), "prior model identity or generation ID unverified")
    require(all(type(row.get(k)) is int and row[k] == usage[k]
                for k in ("prompt_tokens", "completion_tokens", "total_tokens")), "prior D1 token counts differ")
    return {"priorReportedCostUsd": usage.get("cost")}


def verify_timeout(step, row, folder, route, timeout_ms):
    require(type(timeout_ms) is int and 1000 <= timeout_ms <= 120000 and type(step.get("timeoutMs")) is int
            and step["timeoutMs"] == timeout_ms, "unexpected upstream timeout deadline")
    require(step.get("http") in (200, 504) and "finishReason" in step and step["finishReason"] is None
            and step.get("governorAttempts") == 1, "expected a single upstream timeout without a finish reason")
    served, completion = step.get("reportedModel"), step.get("generationId")
    require(served in (None, route.partition(":")[2]) and (completion is None or
            isinstance(completion, str) and 0 < len(completion) <= 512 and completion == completion.strip() and completion.isprintable()),
            "unverified timeout model or generation ID")
    usage = step.get("usage")
    state = step.get("usageState")
    require(isinstance(usage, dict) and state == ("partial" if usage else "unknown"),
            "timeout usage must distinguish observed partial fields from unknowns")
    counts = ("prompt_tokens", "completion_tokens", "total_tokens")
    require(set(usage) <= {*counts, "cost", "completion_tokens_details"} and all(type(usage[k]) is int and 0 <= usage[k] <= 2**53 - 1 for k in counts if k in usage)
            and usage.get("completion_tokens", 0) <= 12000 and ("cost" not in usage or type(usage["cost"]) in (int,float) and usage["cost"] == 0),
            "invalid observed timeout usage")
    if "completion_tokens_details" in usage:
        details = usage["completion_tokens_details"]
        require(isinstance(details, dict) and set(details) == {"reasoning_tokens"}
                and type(details["reasoning_tokens"]) is int
                and 0 <= details["reasoning_tokens"] <= usage.get("completion_tokens", 12000),
                "invalid partial reasoning token count")
    if "total_tokens" in usage:
        require(all(usage["total_tokens"] >= usage[k] for k in counts[:2] if k in usage)
                and (not all(k in usage for k in counts[:2]) or usage["total_tokens"] == usage["prompt_tokens"] + usage["completion_tokens"]),
                "contradictory observed timeout counts")
    # The old ledger columns require numbers. They cannot attest to missing tokens or a provider charge.
    # The separately persisted recovery metadata preserves the actual observations, including null identities.
    metadata = {"requested_model": route, "model": route, "served_model": served, "completion_id": completion,
                "timeout_ms": timeout_ms, "usage_state": state, "usage": usage}
    require(isinstance(row.get("recovery_metadata_json"), str)
            and canonical(json.loads(row["recovery_metadata_json"])) == canonical(metadata),
            "D1 timeout recovery metadata differs from the verified timeout")
    require(all(type(row.get(k)) is int and row[k] == usage[k] for k in counts[:2] if k in usage)
            and (not all(k in usage for k in counts) or type(row.get("total_tokens")) is int and row["total_tokens"] == usage["total_tokens"]),
            "D1 timeout usage columns differ from observed components")
    terminal = {**metadata, "type": "governor_error", "code": "upstream_timeout", "status": 504,
                "finish_reason": None, "usage_event_id": row["id"]}
    expected = {"http": step["http"], "taskId": step["taskId"], "taskRef": step["taskRef"], "caller": step["caller"],
                "briefSha256": step["briefSha256"], "terminal": terminal, "d1ReceiptSha256": step["d1ReceiptSha256"]}
    sidecar = json.loads((folder / "upstream-timeout.json").read_bytes())
    require(canonical(sidecar) == canonical(expected) and sha(canonical(sidecar)) == step.get("timeoutFingerprintSha256"),
            "upstream timeout fingerprint does not match the trusted terminal data")
    return {"priorTimeoutMs": timeout_ms, "priorTimeoutFingerprintSha256": step["timeoutFingerprintSha256"],
            "priorRequestedRoute": route, "priorReportedModel": served, "priorGenerationId": completion,
            "priorUsageState": state, "priorObservedUsage": usage, "priorReportedCostUsd": usage.get("cost")}


def verify_prior(path, prompt, timeout_ms=None):
    receipt = path.read_bytes()
    step = json.loads(receipt)
    trigger = "upstream_timeout" if timeout_ms is not None else "empty_output"
    require(isinstance(step, dict) and step.get("trigger") == trigger, "prior trigger does not match recovery authorization")
    require(step.get("attempt") == 1 and step.get("briefSha256") == sha(prompt), "requires the original first attempt and its exact brief")
    require(all(isinstance(step.get(k), str) and step[k].strip() and len(step[k]) <= 512
                for k in ("taskRef", "taskId", "caller", "d1UsageId")), "missing prior task references")
    route = step.get("requestedRoute")
    require(str(step.get("tier")) == "0" and isinstance(route, str) and re.fullmatch(r"[^:\s]+:\S+", route)
            and route == step.get("governorModel"), "unverified prior free-tier route")
    row = json.loads((path.parent / "d1-usage.json").read_bytes())
    expected = {"id": step["d1UsageId"], "task_id": step["taskId"], "pod_id": step["caller"],
                "model_id": route, "provider": route.partition(":")[0], "status": trigger, "tier": "FREE_TIER", "cost_usd": 0}
    require(isinstance(row, dict) and all(not isinstance(row.get(k), bool) and row.get(k) == v for k, v in expected.items()),
            "prior D1 receipt differs from the triggering request")
    row_sha = sha(canonical(row))
    require(step.get("d1ReceiptSha256") == row_sha, "prior D1 receipt digest differs")
    inventory = (path.parent / "inventory.csv").read_bytes()
    require(type(step.get("artifactBytes")) is int and step["artifactBytes"] == len(inventory)
            and step.get("artifactSha256") == sha(inventory) and not inventory.decode("utf-8").strip(),
            "prior output is nonempty or does not match its receipt")
    if timeout_ms is None:
        details = verify_empty_completion(step, row, route)
    else:
        details = verify_timeout(step, row, path.parent, route, timeout_ms)
    return {"trigger": trigger, "priorReceiptSha256": sha(receipt), "taskRef": step["taskRef"], "priorTaskId": step["taskId"],
            "priorD1UsageId": row["id"], "priorD1ReceiptSha256": row_sha, **details}


def child_env():
    # First-party CLI login only; do not inherit provider, key, cloud credential, model or proxy overrides.
    keep = ("PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SYSTEMROOT", "LANG")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env.update(CLAUDE_CODE_NO_MODEL_FALLBACK="1", CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK="1",
               CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK="1", CLAUDE_CODE_DISABLE_REFUSAL_RETRY="1",
               CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK="1", CLAUDE_CODE_MAX_RETRIES="0",
               CLAUDE_CODE_DISABLE_FAST_MODE="1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
               CLAUDE_CODE_MAX_OUTPUT_TOKENS="12000", DISABLE_EXTRA_USAGE_COMMAND="1")
    return env


class NativeExit(Unverified):
    def __init__(self, code, category, reset=None):
        self.code, self.category, self.reset = code, category, reset
        super().__init__("native CLI failed: " + category)


def native_reset(stdout):
    resets = []
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except (ValueError, UnicodeError):
            continue
        if not isinstance(event, dict) or event.get("type") != "rate_limit_event":
            continue
        info = event.get("rate_limit_info")
        if not isinstance(info, dict) or info.get("status") != "rejected":
            continue
        seconds = info.get("resetsAt")
        # Native CLI uses Unix seconds. Never persist free-form error text as a timestamp.
        if type(seconds) is int and 0 < seconds < 4102444800:
            resets.append(seconds)
    return datetime.fromtimestamp(max(resets), timezone.utc).isoformat() if resets else None


def failure_category(stdout, stderr):
    """Return a fixed diagnostic label only. Never echo model output, error text, arguments or account data."""
    text = stderr[:4096].decode("utf-8", errors="replace")
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except (ValueError, UnicodeError):
            continue
        if not isinstance(event, dict):
            continue
        if event.get("type") == "rate_limit_event" and isinstance(event.get("rate_limit_info"), dict):
            if event["rate_limit_info"].get("status") == "rejected":
                return "native_rate_limit"
        if event.get("type") == "result" and event.get("is_error") is True:
            if event.get("subtype") in ("error_max_turns", "error_max_budget_usd"):
                return event["subtype"]
            if isinstance(event.get("result"), str):
                text += "\n" + event["result"][:4096]
    # Use reported API status rather than inference from timing or text from a normal assistant reply.
    match = re.search(r"(?im)^\s*(?:error:\s*)?api error:?\s*(401|402|403|429|500|502|503|504|529)\b", text)
    if match:
        return "native_api_http_" + match.group(1)
    if re.search(r"(?im)^you['’]ve hit your (?:5-hour|weekly|session) limit(?:\s|[·.]|$)", text):
        return "native_rate_limit"
    if re.search(r"(?im)^\s*error:\s*(unknown option|missing required argument|option .+ argument missing)\b", text):
        return "native_cli_arguments"
    return "unclassified_native_exit"


def invoke(args, cwd, env, timeout, stdin=b""):
    with subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, start_new_session=True) as proc:
        try:
            output, stderr = proc.communicate(stdin, timeout=timeout)
        except BaseException:
            if proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            proc.wait()
            raise
        if proc.returncode:
            raise NativeExit(proc.returncode, failure_category(output, stderr), native_reset(output))
        return proc.returncode, output


def attest(stdout, receipt):
    init, result, texts, ids, models = None, None, [], set(), set()
    stop_reasons = set()

    def observe_stop(metadata):
        for key in ("stop_reason", "stopReason"):
            reason = metadata.get(key)
            if reason is None:
                continue
            require(isinstance(reason, str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,48}", reason), "invalid native stop reason")
            stop_reasons.add(reason)

    for line in stdout.splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        require(isinstance(event, dict), "invalid native event")
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init":
            require(init is None and event.get("tools") == [] and event.get("model") == MODEL, "unexpected native init or tools")
            init = True
        elif kind == "assistant":
            m = event.get("message")
            require(isinstance(m, dict) and isinstance(m.get("id"), str)
                    and re.fullmatch(r"msg_[a-zA-Z0-9_-]{1,180}", m["id"]), "missing assistant response ID")
            require(m.get("model") == MODEL, "assistant model differs from requested model")
            observe_stop(m)
            ids.add(m["id"])
            models.add(m["model"])
            require(isinstance(m.get("content"), list), "invalid native content")
            for block in m["content"]:
                require(isinstance(block, dict), "invalid native content block")
                if block.get("type") in ("thinking", "redacted_thinking"):
                    continue
                require(block.get("type") == "text" and isinstance(block.get("text"), str), "unexpected tool or content block")
                texts.append(block["text"])
        elif kind == "user":
            blocks = (event.get("message") or {}).get("content", [])
            require(not isinstance(blocks, list) or not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in blocks),
                    "unexpected tool result")
        elif kind == "result":
            require(result is None, "multiple native results")
            observe_stop(event)
            result = event
    require(init and len(ids) == 1 and models == {MODEL} and result is not None, "unverified single generation")
    require(result.get("subtype") == "success" and result.get("is_error") is False and
            type(result.get("num_turns")) is int and result["num_turns"] == 1, "native generation did not finish in one turn")
    receipt["nativeTurnCompleted"] = True
    receipt["stopReason"] = next(iter(stop_reasons)) if len(stop_reasons) == 1 else None
    require(len(stop_reasons) <= 1, "native stop reasons conflict")
    require(not stop_reasons or receipt["stopReason"] in ("end_turn", "stop_sequence"),
            "native stop reason does not indicate a completed extraction")
    summary = result.get("modelUsage")
    require(isinstance(summary, dict) and set(summary) == {MODEL}, "unexpected usage model")
    model = summary[MODEL]
    require(isinstance(model, dict) and model.get("provider") == "firstParty" and model.get("canonicalModel") == MODEL,
            "native usage failed provider or model verification")
    u = result.get("usage")
    require(isinstance(u, dict) and u.get("fallback_credit") is None, "usage missing or fallback credit reported")
    require(all(type(u.get(k)) is int and u[k] >= 0 for k in USAGE_FIELDS), "native token counts missing or invalid")
    usage = {k: u[k] for k in USAGE_FIELDS}
    usage["total_counted_tokens"] = sum(usage.values())
    require(all(model.get(k) == u[v] for k, v in zip(("inputTokens", "cacheCreationInputTokens", "cacheReadInputTokens", "outputTokens"), USAGE_FIELDS)),
            "model-usage totals disagree")
    require(not model.get("webSearchRequests") and isinstance(u.get("server_tool_use", {}), dict)
            and all(value == 0 for value in u.get("server_tool_use", {}).values()),
            "native usage indicates a server tool")
    text = "".join(texts)
    require(isinstance(result.get("result"), str) and text == result["result"], "result text differs from assistant message")
    data = text.encode("utf-8")
    receipt.update(providerReportedModel=MODEL, responseId=ids.pop(), turns=1, usage=usage, toolsExposed=[], toolCalls=[],
                   nativeDurationMs=result.get("duration_ms"), nativeApiDurationMs=result.get("duration_api_ms"),
                   artifactSha256=sha(data), transport={"artifactBytes": len(data), "endsWithLF": data.endswith(b"\n"),
                   "endsWithCRLF": data.endswith(b"\r\n"), "resultTextByteIdentical": True, "rawStdoutSha256": sha(stdout)})
    return data


def recover(prompt_file, out, previous, timeout, *, upstream_timeout_ms=None):
    require(type(timeout) is int and 1 <= timeout <= MAX_TIMEOUT, "invalid timeout")
    prompt = prompt_file.read_bytes()
    require(0 < len(prompt) <= 128 * 1024 and prompt.decode("utf-8").strip(), "prompt must be nonempty UTF-8 up to 128 KiB")
    prior = verify_prior(previous, prompt, upstream_timeout_ms)
    # mkdir is the exclusive guard for the requested destination, including concurrent invocations.
    out.mkdir(mode=0o700)
    info = {"workflow": "claude-oauth-extraction-v1", "requestedModel": MODEL, "requestedEffort": EFFORT,
            "effectiveEffort": None, **prior, "promptSha256": sha(prompt),
            "generationInvocations": 0, "startedAt": utc(), "status": "preflight"}
    clock = time.monotonic()
    try:
        env = child_env()
        with tempfile.TemporaryDirectory(prefix="governor-oauth-recovery-") as cwd:
            code, auth_bytes = invoke(["claude", "auth", "status"], cwd, env, 15)
            require(code == 0, "native OAuth status unavailable")
            auth = json.loads(auth_bytes)
            require(isinstance(auth, dict) and auth.get("loggedIn") is True and auth.get("authMethod") == "claude.ai"
                    and auth.get("apiProvider") == "firstParty", "requires native first-party Claude OAuth")
            info["auth"] = {"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty"}
            # A timeout or abrupt termination still consumes the one permitted attempt.
            try:
                with (previous.parent / ".claude-oauth-recovery.once").open("x", encoding="utf-8") as marker:
                    marker.write(prior["priorReceiptSha256"] + "\n")
            except FileExistsError:
                raise Unverified("this prior completion already claimed a recovery") from None
            info.update(generationInvocations=1, startedAt=utc(), status="running")
            clock = time.monotonic()
            write_json(out / "native.json", info)
            args = ["claude", "-p", "--model", MODEL, "--effort", EFFORT, "--max-turns", "1",
                    "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "",
                    "--settings", '{"disableAllHooks":true}', "--tools", "", "--disable-slash-commands",
                    "--output-format", "stream-json", "--verbose"]
            code, stdout = invoke(args, cwd, env, timeout, prompt)
            info["exit"] = code
            require(code == 0, "native generation failed")
            data = attest(stdout, info)
            require(bool(data.decode("utf-8").strip()), "recovery response was empty")
            tmp = out / "inventory.tmp"
            tmp.write_bytes(data)
            tmp.replace(out / "inventory.csv")
            info["status"] = "returned-ungraded"
    except NativeExit as e:
        info.update(status="unverified", exit=e.code, nativeFailureCategory=e.category, error=str(e))
        if e.reset:
            info["oauthNotBefore"] = e.reset
        raise
    except subprocess.TimeoutExpired:
        info.update(status="timeout", error="native command exceeded its time bound")
        raise Unverified(info["error"]) from None
    except (KeyError, TypeError, UnicodeError, ValueError, OSError, Unverified) as e:
        # Native errors and arbitrary output may include secrets. Persist only known, fixed diagnostics.
        reason = str(e) if isinstance(e, Unverified) else "native invocation or receipt could not be verified"
        info.update(status="unverified", error=reason)
        raise Unverified(reason) from None
    finally:
        info.update(endedAt=utc(), elapsedSeconds=round(time.monotonic() - clock, 3))
        write_json(out / "native.json", info)
    return info


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True, help="New output directory")
    receipt = parser.add_mutually_exclusive_group()
    receipt.add_argument("--empty-receipt", type=Path, help="Completed empty_output step.json (default: sibling attempt-1)")
    receipt.add_argument("--timeout-receipt", type=Path, help="Authorize recovery for this attested upstream_timeout step.json")
    parser.add_argument("--upstream-timeout-ms", type=int, help="Exact opted-in Worker deadline (1000..120000, default 120000)")
    parser.add_argument("--timeout-seconds", type=int, default=MAX_TIMEOUT)
    args = parser.parse_args()
    if args.upstream_timeout_ms is not None and args.timeout_receipt is None:
        parser.error("--upstream-timeout-ms requires --timeout-receipt")
    prior = args.timeout_receipt or args.empty_receipt or args.out.parent / "attempt-1" / "step.json"
    timeout_ms = (120000 if args.upstream_timeout_ms is None else args.upstream_timeout_ms) if args.timeout_receipt else None
    recover(args.prompt, args.out, prior, args.timeout_seconds, upstream_timeout_ms=timeout_ms)
    print(args.out / "native.json")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, Unverified) as e:
        sys.exit(str(e) if isinstance(e, Unverified) else "invalid input, missing file or output directory already exists")
