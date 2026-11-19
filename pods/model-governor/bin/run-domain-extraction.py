#!/usr/bin/env python3
"""Run one frozen Domain Scout merge. Only a verified terminal empty_output may start one authorized native retry."""
import argparse
import csv
import json
import os
import runpy
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from http.client import HTTPException
from pathlib import Path

BIN = Path(__file__).resolve().parent
COLLECTOR = runpy.run_path(str(BIN / "collect-extraction-outcome.py"))
canonical, sha = COLLECTOR["canonical"], COLLECTOR["sha"]
PRIMARY = "openrouter:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
NATIVE = "claude-opus-5-5"
MAX_TOKENS = 12000
MAX_INPUT = 2 * 1024 * 1024
MAX_STREAM = 8 * 1024 * 1024
MAX_EVENT = 1024 * 1024
CSV_HEADER = ["domain", "listing_url", "source", "evidence", "close_time_as_displayed"]
RUN_RUBRIC = {
    "id": "domain-scout-frozen-extraction/v1",
    "baseRubricSha256": sha(canonical(COLLECTOR["RUBRIC"])),
    "csvContract": {"exact_csv_header": CSV_HEADER, "lowercase_domains": True,
                    "park_primary_for_overlap": True, "exact_listing_url_evidence": True, "verbatim_primary_close": True},
    "completion": "Governor stop or verified one-turn native success without a negative reported stop reason.",
}
INSTRUCTIONS = """Domain Scout public inventory extraction. Merge the two frozen auction snapshots into one CSV, using only the supplied source rows as data. Output a valid CSV only, without Markdown, prose or tooling, with this exact header:
domain,listing_url,source,evidence,close_time_as_displayed
Use one row per distinct case-insensitive domain and lowercase the domain. Include the full source union, without duplicates or extras. Use source labels 'Park.io', 'Dynadot page 1', or 'Park.io + Dynadot' according to membership. Use a verbatim captured primary listing URL and its verbatim close/time-left string. For overlapping domains prefer the Park.io primary. Keep ALL captured listing URLs for each domain in the evidence field, separated by ' | ' if there are two. Quote CSV fields containing commas. Preserve the exact URLs, time strings and domains; do not rank, price, enrich or make contact. Traversing the inputs in original order is fine.
"""


def require(ok, message):
    if not ok:
        raise ValueError(message)


def stamp():
    return datetime.now(timezone.utc).isoformat()


def save(path, value):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def limited(stream, limit):
    data = stream.read(limit + 1)
    require(len(data) <= limit, "size limit exceeded")
    return data


def read_file(path):
    with path.open("rb") as stream:
        return limited(stream, MAX_INPUT)


def ident(value):
    return isinstance(value, str) and 0 < len(value) <= 512 and value == value.strip() and value.isprintable()


def count(value):
    return type(value) is int and 0 <= value <= 2**53 - 1


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, url):
        return None


class Governor:
    def __init__(self, origin):
        url = urllib.parse.urlsplit(origin)
        require(url.scheme == "https" and url.hostname and url.username is None and url.password is None
                and url.path in ("", "/") and not url.query and not url.fragment, "expected trusted HTTPS origin")
        self.origin = origin.rstrip("/")
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, path, token_file, body=None, headers=None):
        token = token_file.read_text().strip()
        require(token, "empty token file")
        request_headers = {"Authorization": "Bearer " + token, "User-Agent": "model-governor-extractor/1",
                           "Cache-Control": "no-cache", **(headers or {})}
        data = None
        if body is not None:
            data = canonical(body)
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.origin + path, data=data, headers=request_headers)
        return self.opener.open(request, timeout=135 if data else 20)


@contextmanager
def deadline(seconds):
    # Socket timeouts alone can be extended indefinitely by an upstream that sends keepalives.
    def expire(*_):
        raise TimeoutError("primary request deadline exceeded")
    old = signal.signal(signal.SIGALRM, expire)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)


def freeze(args):
    require(ident(args.task_ref) and ident(args.caller) and len(args.caller) <= 200, "invalid task reference or caller")
    require(args.model.startswith("openrouter:") and args.model.endswith(":free") and ident(args.model),
            "primary requires an exact free OpenRouter catalog ID")
    park, dyn = read_file(args.park), read_file(args.dynadot)
    inventory, rows, _ = COLLECTOR["source_inventory"](park, dyn)
    inputs = {}
    for label, raw, last in (("Park.io", park, "close_time_as_displayed"),
                             ("Dynadot page 1", dyn, "time_left_as_displayed")):
        fields = ("domain", "listing_url", last)
        inputs[label] = [{k: row[k] for k in fields} for row in COLLECTOR["csv_records"](raw, fields)]
    brief = (INSTRUCTIONS + "\n" + json.dumps(inputs, ensure_ascii=False, separators=(",", ":"))).encode()
    require(len(brief) <= (128 * 1024 if args.oauth_on_empty else MAX_INPUT), "brief exceeds workflow size limit")
    args.out.mkdir(mode=0o700, parents=True, exist_ok=False)
    sources = args.out / "sources"
    sources.mkdir(mode=0o700)
    (sources / "park.csv").write_bytes(park)
    (sources / "dynadot.csv").write_bytes(dyn)
    (args.out / "brief.txt").write_bytes(brief)
    facts = {"runId": uuid.uuid4().hex, "taskRef": args.task_ref, "taskClass": "data-extraction",
             "requestedRoute": args.model, "caller": args.caller, "freeOnly": True,
             "maxGenerationAttempts": 2 if args.oauth_on_empty else 1,
             "briefSha256": sha(brief), "sourceSha256": {"park.csv": sha(park), "dynadot.csv": sha(dyn)},
             "sourceRows": rows, "sourceUnionDomains": len(inventory), "rubric": RUN_RUBRIC, "baseRubric": COLLECTOR["RUBRIC"],
             "rubricSha256": sha(canonical(RUN_RUBRIC))}
    save(args.out / "frozen.json", facts)
    return park, dyn, brief, facts


def sse_events(stream):
    used = size = 0
    parts = []
    while True:
        line = stream.readline(MAX_EVENT + 1)
        if not line:
            raise ValueError("stream ended before [DONE]")
        used += len(line)
        size += len(line)
        require(size <= MAX_EVENT and used <= MAX_STREAM, "stream size limit exceeded")
        line = line.rstrip(b"\r\n")
        if not line:
            if parts:
                yield b"\n".join(parts).decode("utf-8", errors="strict")
            parts = []
            size = 0
        elif line.startswith(b"data:"):
            parts.append(line[5:].removeprefix(b" "))


def note(step, key, value):
    require(ident(value) and value == step.get(key, value), "missing or conflicting " + key)
    step[key] = value


def checked_usage(raw):
    require(isinstance(raw, dict), "missing provider usage")
    keys = ("prompt_tokens", "completion_tokens", "total_tokens")
    require(all(count(raw.get(k)) for k in keys) and raw["total_tokens"] == raw["prompt_tokens"] + raw["completion_tokens"]
            and raw["completion_tokens"] <= MAX_TOKENS, "invalid final token counts")
    require(raw.get("cost") is None or (type(raw["cost"]) in (float, int) and raw["cost"] == 0), "nonzero or invalid provider cost")
    usage = {**{k: raw[k] for k in keys}, "cost": raw.get("cost")}
    reasoning = (raw.get("completion_tokens_details") or {}).get("reasoning_tokens")
    if reasoning is not None:
        require(count(reasoning) and reasoning <= raw["completion_tokens"], "invalid reasoning tokens")
        usage["completion_tokens_details"] = {"reasoning_tokens": reasoning}
    return usage


def consume(response, step, artifact):
    route = step["requestedRoute"]
    expected = route.split(":", 1)[1]
    head = response.headers
    step.update(http=response.status, governorModel=head.get("X-Governor-Model"), tier=head.get("X-Governor-Tier"),
                ray=head.get("cf-ray"))
    require(response.status == 200 and head.get("Content-Type", "").split(";")[0].strip().lower() == "text/event-stream"
            and head.get("X-Governor-Caller") == step["caller"] and step["governorModel"] == route
            and step["tier"] == "0" and head.get("X-Governor-Attempts") == "1", "unverified free response headers")
    step["governorAttempts"] = 1
    empty = False
    visible = False
    usage = None
    for payload in sse_events(response):
        if payload == "[DONE]":
            break
        require(not empty, "event after empty terminal")
        frame = json.loads(payload)
        require(isinstance(frame, dict), "invalid SSE payload")
        if "error" in frame:
            error = frame["error"]
            require(isinstance(error, dict) and error.get("code") == "empty_output"
                    and error.get("type") == "governor_error" and error.get("status") == 502
                    and error.get("model") == error.get("requested_model") == route
                    and error.get("served_model") == expected and not visible and not frame.get("choices"),
                    "unexpected stream error")
            note(step, "d1UsageId", error.get("usage_event_id"))
            note(step, "generationId", error.get("completion_id"))
            note(step, "reportedModel", error["served_model"])
            note(step, "finishReason", error.get("finish_reason"))
            final = checked_usage(error.get("usage"))
            require(final["cost"] == 0, "empty output lacks an authoritative zero provider cost")
            require(usage is None or usage == final, "conflicting final usage")
            usage = final
            empty = True
            continue
        if frame.get("model") is not None:
            require(frame["model"] == expected, "substituted upstream model")
            note(step, "reportedModel", frame["model"])
        if frame.get("id") is not None:
            note(step, "generationId", frame["id"])
        if frame.get("usage") is not None:
            # Provisional counts may be updated. Require a validated final receipt before completion.
            if not frame.get("choices") or any(c.get("finish_reason") in ("stop", "length") for c in frame["choices"]):
                usage = checked_usage(frame["usage"])
        choices = frame.get("choices", [])
        require(isinstance(choices, list) and len(choices) <= 1, "unexpected number of choices")
        for choice in choices:
            require(choice.get("index", 0) == 0, "unexpected choice index")
            delta = choice.get("delta") or {}
            require(isinstance(delta, dict) and not any(delta.get(k) for k in ("refusal", "tool_calls", "function_call", "audio", "images")),
                    "non-extraction model output")
            text = delta.get("content")
            if text is not None:
                require(isinstance(text, str), "non-text output")
                artifact.write(text.encode())
                visible |= bool(text.strip())
            if choice.get("finish_reason") is not None:
                note(step, "finishReason", choice["finish_reason"])
    require(step.get("finishReason") in ("stop", "length") and step.get("reportedModel") == expected
            and step.get("generationId") and usage is not None, "unverified terminal identity, usage, or finish")
    require(visible or empty, "empty stream without authenticated governor terminal error")
    step["usage"] = usage
    if empty:
        step["trigger"] = "empty_output"


def primary(args, governor, folder, step, brief):
    body = {"model": args.model, "taskId": step["taskId"], "stream": True, "reasoning_effort": "low",
            "max_tokens": MAX_TOKENS, "messages": [{"role": "user", "content": brief.decode()}]}
    step["requestSha256"] = sha(canonical(body))
    headers = {"X-Governor-Caller": args.caller, "X-Governor-Require-Output": "text", "Accept": "text/event-stream"}
    with (folder / "inventory.csv").open("xb") as artifact, deadline(145):
        with governor.request("/api/inference/chat/completions", args.client_token_file, body, headers) as res:
            consume(res, step, artifact)


def attest_empty(governor, args, step, folder):
    event_id = step["d1UsageId"]
    query = urllib.parse.urlencode({"id": event_id})
    with deadline(25), governor.request("/api/governor/usage-receipts?" + query, args.admin_token_file) as response:
        rows = json.loads(limited(response, MAX_EVENT))["rows"]
    expected = {"id": event_id, "task_id": step["taskId"], "pod_id": step["caller"],
                "model_id": step["governorModel"], "provider": "openrouter", "tier": "FREE_TIER",
                "status": "empty_output", "cost_usd": 0,
                **{k: step["usage"][k] for k in ("prompt_tokens", "completion_tokens", "total_tokens")}}
    require(isinstance(rows, list) and len(rows) == 1, "no unique empty-output D1 receipt")
    row = rows[0]
    require(all(not isinstance(row.get(k), bool) and row.get(k) == v for k, v in expected.items()),
            "D1 receipt does not match the empty stream, task, caller, model and usage")
    save(folder / "d1-usage.json", row)
    step["d1ReceiptSha256"] = sha(canonical(row))


def policy(governor, args):
    with deadline(25), governor.request("/api/governor/callers", args.admin_token_file) as response:
        rows = json.loads(limited(response, MAX_EVENT))["callers"]
    matches = [r for r in rows if r.get("callerId") == args.caller]
    require(len(matches) == 1 and all(type(matches[0].get(k)) in (int, float) and matches[0][k] == 0
                                      for k in ("preferredTier", "maxTier", "effectiveMaxTier", "dailyBudgetUsd")),
            "caller requires an explicit zero-dollar, tier-zero policy")
    return matches[0]


def contract_checks(park, dyn, artifact):
    inventory, _, _ = COLLECTOR["source_inventory"](park, dyn)
    reader = csv.DictReader(artifact.decode("utf-8-sig").splitlines(keepends=True), strict=True)
    checks = {"exact_csv_header": reader.fieldnames == CSV_HEADER, "lowercase_domains": True,
              "park_primary_for_overlap": True, "exact_listing_url_evidence": True, "verbatim_primary_close": True}
    for row in reader:
        domain = row["domain"].strip().lower()
        checks["lowercase_domains"] &= row["domain"] == domain
        sources = inventory.get(domain, {})
        evidence = [x.strip() for x in row["evidence"].split("|")]
        urls = {url for url, _ in sources.values()}
        checks["exact_listing_url_evidence"] &= set(evidence) == urls and len(evidence) == len(urls)
        checks["verbatim_primary_close"] &= (row["listing_url"], row["close_time_as_displayed"]) in sources.values()
        if set(sources) == {"park", "dynadot"}:
            checks["park_primary_for_overlap"] &= row["listing_url"] == sources["park"][0]
    return checks


def measure(park, dyn, brief, artifact, frozen, step, folder):
    try:
        _, receipt = COLLECTOR["collect"](park, dyn, artifact, brief, step["taskRef"])
        receipt["passed"].update(contract_checks(park, dyn, artifact))
    except (ValueError, csv.Error) as err:
        # An empty/malformed file establishes parse failure; row-level results are unknown.
        receipt = {"artifactSha256": sha(artifact), "parseError": str(err), "passed": {"csv_parse": False}}
    completed = (step["finishReason"] == "stop" if step["attempt"] == 1 else
                 step.get("nativeTurnCompleted") is True and step["finishReason"] in (None, "end_turn", "stop_sequence"))
    receipt["passed"]["turn_completed"] = completed
    receipt["runRubric"] = frozen["rubric"]
    ref = "sha256:" + sha(canonical(receipt))
    save(folder / "measurement.json", receipt)
    step["failedChecks"] = [k for k, v in receipt["passed"].items() if not v]
    step["accepted"] = not step["failedChecks"]
    return {"kind": "artifact_review", "taskClass": frozen["taskClass"], "taskRef": step["taskRef"],
            "briefSha256": frozen["briefSha256"], "rubricSha256": frozen["rubricSha256"],
            "sourceRef": "sha256:" + sha(canonical(frozen["sourceSha256"])),
            "checks": [{"name": k, "passed": v, "measurementRef": ref} for k, v in receipt["passed"].items()]}


def link(event, step, workflow):
    artifact = {"workflow": workflow, "receiptRef": "sha256:" + sha(canonical(step)), "artifactSha256": step["artifactSha256"]}
    event.update(artifact=artifact, evidenceId="domain-merge:" + sha(canonical([step["taskId"], artifact, event["checks"]])))
    return event


def invoke_native(brief, folder, prior):
    # The helper supplies its own native subprocess deadlines and performs OAuth and one-use checks.
    subprocess.run([sys.executable, str(BIN / "claude-oauth-extraction.py"), "--prompt", str(brief),
                    "--out", str(folder), "--empty-receipt", str(prior)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=245)


def verify_native(folder, prior, first, brief):
    raw_receipt = read_file(folder / "native.json")
    n = json.loads(raw_receipt)
    require(n.get("status") == "returned-ungraded" and n.get("auth") == {
        "loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty"}
            and n.get("requestedModel") == n.get("providerReportedModel") == NATIVE
            and ident(n.get("responseId")) and n.get("nativeTurnCompleted") is True
            and "stopReason" in n and n["stopReason"] in (None, "end_turn", "stop_sequence")
            and type(n.get("generationInvocations")) is int and n.get("generationInvocations") == n.get("turns") == 1
            and n.get("priorReceiptSha256") == sha(prior.read_bytes())
            and n.get("priorD1UsageId") == first["d1UsageId"]
            and n.get("priorD1ReceiptSha256") == first["d1ReceiptSha256"]
            and n.get("priorTaskId") == first["taskId"] and n.get("taskRef") == first["taskRef"]
            and n.get("promptSha256") == sha(brief), "invalid native recovery lineage or identity")
    artifact = read_file(folder / "inventory.csv")
    require(artifact.decode().strip() and n.get("artifactSha256") == sha(artifact)
            and n["transport"]["artifactBytes"] == len(artifact) and n["transport"]["resultTextByteIdentical"] is True,
            "native CSV bytes do not match verified generation")
    usage = n["usage"]
    fields = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
    require(all(count(usage.get(k)) for k in (*fields, "total_counted_tokens")) and
            sum(usage[k] for k in fields) == usage["total_counted_tokens"], "invalid native token counts")
    return n, artifact, sha(raw_receipt)


def error_info(err):
    if isinstance(err, urllib.error.HTTPError):
        return f"HTTP {err.code}"
    if isinstance(err, subprocess.CalledProcessError):
        return f"native helper exit {err.returncode}; see native receipt"
    if isinstance(err, ValueError) and not isinstance(err, (UnicodeError, json.JSONDecodeError)):
        return str(err)[:240]
    return type(err).__name__


FAILURES = (OSError, ValueError, KeyError, TypeError, AttributeError, csv.Error, HTTPException, subprocess.SubprocessError)


def run(args, governor, native=invoke_native):
    started, tic = stamp(), time.monotonic()
    park, dyn, brief, frozen = freeze(args)
    base = {"taskRef": args.task_ref, "runId": frozen["runId"], "briefSha256": sha(brief)}
    tid = "domain-extract:" + frozen["runId"]
    steps, batch = [], []
    first = dict(base, attempt=1, taskId=tid + ":1", caller=args.caller, requestedRoute=args.model,
                 startedAt=stamp(), accepted=False, requestIssued=False)
    steps.append(first)
    folder = args.out / "attempt-1"
    folder.mkdir()
    prior = folder / "step.json"
    save(prior, first)
    event = None
    try:
        save(args.out / "caller-policy.json", policy(governor, args))
        first["requestIssued"] = True
        save(prior, first)  # Leave durable evidence before the single POST.
        model_clock = time.monotonic()
        try:
            primary(args, governor, folder, first, brief)
        finally:
            first["inferenceSeconds"] = round(time.monotonic() - model_clock, 3)
            first["inferenceEndedAt"] = stamp()
        if first.get("trigger") == "empty_output":
            attest_empty(governor, args, first, folder)
        artifact = (folder / "inventory.csv").read_bytes()
        first.update(artifactBytes=len(artifact), artifactSha256=sha(artifact))
        event = measure(park, dyn, brief, artifact, frozen, first, folder)
    except FAILURES as err:
        first["error"] = error_info(err)
        if first.pop("trigger", None) and "usage" in first:
            first["unverifiedUsage"] = first.pop("usage")
        if (folder / "inventory.csv").is_file():
            artifact = (folder / "inventory.csv").read_bytes()
            first.update(artifactBytes=len(artifact), artifactSha256=sha(artifact))
    first["endedAt"] = stamp()
    first["elapsedSeconds"] = round(time.monotonic() - tic, 3)
    save(prior, first)
    if event:
        batch.append(link(event, first, args.model))
    if first.get("trigger") == "empty_output" and args.oauth_on_empty:
        folder = args.out / "attempt-2"
        second = dict(base, attempt=2, taskId=tid + ":2", startedAt=stamp(), accepted=False,
                      trigger="empty_output", priorTaskId=first["taskId"], priorReceiptSha256=sha(prior.read_bytes()),
                      requestedRoute="anthropic-oauth/" + NATIVE, oauthQuotaDebit=None)
        steps.append(second)
        event = None
        native_clock = time.monotonic()
        try:
            native(args.out / "brief.txt", folder, prior)
            n, artifact, digest = verify_native(folder, prior, first, brief)
            second.update(reportedModel=n["providerReportedModel"], generationId=n["responseId"], usage=n["usage"],
                          generationInvocations=1, nativeReceiptSha256=digest, finishReason=n["stopReason"], nativeTurnCompleted=True,
                          artifactBytes=len(artifact), artifactSha256=sha(artifact), inferenceSeconds=n["elapsedSeconds"])
            event = measure(park, dyn, brief, artifact, frozen, second, folder)
        except FAILURES as err:
            second["error"] = error_info(err)
            # A failed invocation can have consumed quota. Absence of an authenticated result leaves tokens unknown.
            if (folder / "native.json").is_file():
                try:
                    native_doc = json.loads(read_file(folder / "native.json"))
                    if type(native_doc.get("generationInvocations")) is int:
                        second["generationInvocations"] = native_doc["generationInvocations"]
                except FAILURES:
                    pass
        folder.mkdir(exist_ok=True)
        second.update(endedAt=stamp(), elapsedSeconds=round(time.monotonic() - native_clock, 3))
        save(folder / "step.json", second)
        if event:
            batch.append(link(event, second, second["requestedRoute"]))

    usage1 = first.get("usage")
    usage2 = steps[1].get("usage") if len(steps) == 2 else None
    known = usage1 is not None and (len(steps) == 1 or usage2 is not None)
    inputs = (usage1["prompt_tokens"] + (usage2["total_counted_tokens"] - usage2["output_tokens"] if usage2 else 0)) if known else None
    outputs = (usage1["completion_tokens"] + (usage2["output_tokens"] if usage2 else 0)) if known else None
    report = dict(base, startedAt=started, endedAt=stamp(), elapsedSeconds=round(time.monotonic() - tic, 3),
                  accepted=steps[-1]["accepted"], firstPass=first["accepted"],
                  verifiedGenerations=sum(1 for s in steps if s.get("usage") and s.get("generationId")),
                  generationSeconds=sum(s["inferenceSeconds"] for s in steps) if known else None,
                  apiRequests=int(first["requestIssued"]), nativeGenerationInvocations=steps[1].get("generationInvocations") if len(steps) == 2 else 0,
                  promptTokens=inputs, outputTokens=outputs, totalTokens=inputs + outputs if known else None,
                  apiCostUsd=usage1["cost"] if usage1 else None, oauthQuotaDebit=None, steps=steps)
    save(args.out / "batch.json", batch)
    save(args.out / "summary.json", report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("park", "dynadot", "out", "admin-token-file", "client-token-file"):
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ("origin", "task-ref", "caller"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--model", default=PRIMARY)
    parser.add_argument("--oauth-on-empty", action="store_true", help="authorize one native Claude OAuth generation only for verified empty output")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        report = run(args, Governor(args.origin))
    except FAILURES as err:
        parser.exit(2, f"Could not prepare extraction run: {error_info(err)}\n")
    print(json.dumps({k: report[k] for k in ("runId", "taskRef", "accepted", "firstPass", "totalTokens", "apiCostUsd")}))
    return 0 if report["accepted"] else 1


if __name__ == "__main__":
    sys.exit(main())
