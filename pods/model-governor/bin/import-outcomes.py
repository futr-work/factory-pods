#!/usr/bin/env python3
"""Preview or submit trusted collector batches to a governor evidence ledger."""
import argparse
import hashlib
import http.client
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def read_events(paths):
    events = {}
    if sum(str(path) == "-" for path in paths) > 1:
        raise ValueError("stdin can supply only one batch")
    for path in paths:
        batch = json.load(sys.stdin) if str(path) == "-" else json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(batch, list):
            raise ValueError(f"{path.name}: expected a JSON array")
        for event in batch:
            if not isinstance(event, dict):
                raise ValueError(f"{path.name}: expected an evidence object")
            key = event.get("evidenceId")
            if not isinstance(key, str) or not key or key != key.strip() or len(key) > 150 or any(ord(c) < 32 or ord(c) == 127 for c in key):
                raise ValueError(f"{path.name}: invalid or noncanonical evidenceId")
            if event.get("kind") not in ("blind_preference", "artifact_review"):
                raise ValueError(f"{path.name}: unknown evidence kind")
            for field in ("taskRef", "taskClass", "rubricSha256", "briefSha256"):
                if not isinstance(event.get(field), str) or not event[field]:
                    raise ValueError(f"{path.name}: missing {field}")
            payload = encode(event)
            if len(payload) > 16_384:
                raise ValueError(f"{path.name}: event exceeds the ledger's 16 KiB limit")
            if key in events and events[key] != payload:
                raise ValueError(f"{path.name}: conflicting input for {key}")
            events[key] = payload
    return events


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api_sender(origin, token_path):
    url = urllib.parse.urlsplit(origin)
    if url.scheme != "https" or not url.hostname or url.username is not None or url.password is not None or url.path not in ("", "/") or url.query or url.fragment:
        raise ValueError("--origin must be the trusted HTTPS governor origin")
    token = token_path.read_text().strip()
    if not token:
        raise ValueError("empty administrator token file")
    opener = urllib.request.build_opener(NoRedirect())
    endpoint = origin.rstrip("/") + "/api/governor/evidence"

    def post(payload):
        request = urllib.request.Request(endpoint, data=payload, headers={
            "User-Agent": "model-governor-outcome-import/1", "Content-Type": "application/json",
            "Authorization": "Bearer " + token,
        })
        with opener.open(request, timeout=30) as response:
            return response.status, json.load(response)
    return post


def import_batches(events, post=None):
    report = {"mode": "apply" if post else "preview", "events": len(events), "receipts": []}
    for key, payload in events.items():
        record = {"evidenceId": key, "sha256": hashlib.sha256(payload).hexdigest()}
        if post:
            try:
                status, ack = post(payload)
                if (status not in (200, 201) or not isinstance(ack, dict) or ack.get("evidenceId") != key
                        or type(ack.get("seq")) is not int or ack["seq"] <= 0
                        or ack.get("created") is not (status == 201)):
                    raise ValueError("unexpected evidence acknowledgement")
                record.update(result="created" if status == 201 else "already_recorded", seq=ack["seq"])
            except (OSError, ValueError, http.client.HTTPException) as err:
                report["stoppedAt"] = key
                report["error"] = f"HTTP {err.code}" if isinstance(err, urllib.error.HTTPError) else type(err).__name__
                return report
        report["receipts"].append(record)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("batch", nargs="+", type=Path)
    parser.add_argument("--apply", action="store_true", help="submit the events; default is offline preview")
    parser.add_argument("--origin", help="trusted HTTPS governor origin")
    parser.add_argument("--admin-token-file", type=Path)
    args = parser.parse_args()
    if args.apply and (not args.origin or not args.admin_token_file):
        parser.error("--apply requires --origin and --admin-token-file")
    try:
        events = read_events(args.batch)
        sender = api_sender(args.origin, args.admin_token_file) if args.apply else None
        report = import_batches(events, sender)
    except (OSError, ValueError) as err:
        parser.exit(2, f"Import preparation failed: {err}\n")
    print(json.dumps(report, indent=2))
    return int("stoppedAt" in report)

if __name__ == "__main__":
    sys.exit(main())
