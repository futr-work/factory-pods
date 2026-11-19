#!/usr/bin/env python3
"""Reconcile a merged Domain Scout inventory against its two original captured CSVs, offline."""
import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import io
import json
from pathlib import Path
import sys

RUBRIC = {
    "id": "public-domain-inventory-merge/v1",
    "population": "Union of case-insensitive domain names in the supplied Park.io and Dynadot page snapshots.",
    "checks": {
        "all_captured_domains_included": "Every source domain occurs in the artifact.",
        "only_captured_domains_listed": "Every artifact row has a nonempty captured domain.",
        "unique_extracted_domains": "No captured or unexpected domain appears on more than one output row.",
        "source_labels_match": "Every matched row names exactly the captured sources for that domain.",
        "source_listing_urls_retained": "All original listing URLs occur verbatim in the primary or pipe-separated evidence fields; primary URL belongs to a captured row.",
        "displayed_close_matches": "Each matched row's primary listing retains its source close time or time-left string. For Dynadot the appended observation timestamp is outside this check.",
    },
    "scope": "Matched-row checks require at least one matched row. Prices, scores, supplied extra evidence, market-wide completeness, model identity and human acceptance are unmeasured.",
}
LABELS = {
    frozenset(["park"]): "Park.io",
    frozenset(["dynadot"]): "Dynadot page 1",
    frozenset(["park", "dynadot"]): "Park.io + Dynadot",
}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def csv_records(raw, required):
    reader = csv.DictReader(io.StringIO(raw.decode("utf-8-sig"), newline=""), strict=True)
    headers = reader.fieldnames or []
    if not set(required) <= set(headers) or len(set(headers)) != len(headers):
        raise ValueError("CSV lacks the required unique column headers")
    for row in reader:
        if None in row or None in row.values():
            raise ValueError("Nonrectangular CSV row")
        yield row


def source_inventory(park, dynadot):
    domains = defaultdict(dict)
    counts, duplicates = {}, {}
    for name, data, close in (("park", park, "close_time_as_displayed"), ("dynadot", dynadot, "time_left_as_displayed")):
        counts[name] = duplicates[name] = 0
        for row in csv_records(data, ("domain", "listing_url", close)):
            counts[name] += 1
            key = row["domain"].strip().lower()
            fields = (row["listing_url"].strip(), row[close].strip())
            if not key or not all(fields):
                raise ValueError("A source row is missing identity or source evidence")
            if name in domains[key]:
                duplicates[name] += 1
                if domains[key][name] != fields:
                    raise ValueError("Conflicting repeated source domain within one capture")
            domains[key][name] = fields
        if not counts[name]:
            raise ValueError("An empty source capture cannot establish extraction coverage")
    return domains, counts, duplicates


def reconcile(park, dynadot, artifact):
    inventory, source_rows, source_duplicates = source_inventory(park, dynadot)
    seen = Counter()
    matched = unexpected = blank = bad_label = bad_link = bad_close = 0
    for row in csv_records(artifact, ("domain", "listing_url", "source", "evidence", "close_time_as_displayed")):
        key = row["domain"].strip().lower()
        if not key:
            blank += 1
            continue
        seen[key] += 1
        sources = inventory.get(key)
        if not sources:
            unexpected += 1
            continue
        matched += 1
        bad_label += row["source"].strip() != LABELS[frozenset(sources)]
        primary = row["listing_url"].strip()
        retained = {primary, *(x.strip() for x in row["evidence"].split("|"))}
        originals = {url for url, _ in sources.values()}
        bad_link += primary not in originals or not originals.issubset(retained)
        displayed = row["close_time_as_displayed"].strip()
        close_matches = any(
            primary == url and (displayed.partition(" remaining at ")[0] if source == "dynadot" else displayed) == close
            for source, (url, close) in sources.items()
        )
        bad_close += not close_matches

    missing = len(inventory.keys() - seen.keys())
    repeat_rows = sum(count - 1 for count in seen.values())
    stats = {
        "sourceRows": source_rows, "duplicatesWithinCapture": source_duplicates,
        "sourceUnionDomains": len(inventory), "overlapOnBothSources": sum(len(s) == 2 for s in inventory.values()),
        "artifactRows": sum(seen.values()) + blank, "matchedArtifactRows": matched,
        "blankDomainRows": blank, "unexpectedDomainRows": unexpected, "omittedSourceDomains": missing,
        "duplicateArtifactRows": repeat_rows, "sourceLabelMismatchRows": bad_label,
        "listingUrlMismatchRows": bad_link, "displayedCloseMismatchRows": bad_close,
    }
    checks = {
        "all_captured_domains_included": missing == 0,
        "only_captured_domains_listed": blank == 0 and unexpected == 0,
        "unique_extracted_domains": repeat_rows == 0,
        "source_labels_match": matched > 0 and bad_label == 0,
        "source_listing_urls_retained": matched > 0 and bad_link == 0,
        "displayed_close_matches": matched > 0 and bad_close == 0,
    }
    return stats, checks


def collect(park, dynadot, artifact, brief, task_ref):
    if not brief.strip():
        raise ValueError("Provide the actual nonempty task brief")
    if not task_ref or len(task_ref) > 512 or any(ord(c) < 32 or ord(c) == 127 for c in task_ref):
        raise ValueError("Invalid task reference")
    stats, checks = reconcile(park, dynadot, artifact)
    sources = {"parkSha256": sha(park), "dynadotSha256": sha(dynadot)}
    receipt = {
        "sourceSnapshots": sources, "artifactSha256": sha(artifact),
        "rubric": RUBRIC, "measurements": stats, "passed": checks,
    }
    measure_ref = "sha256:" + sha(canonical(receipt))
    event = {
        "kind": "artifact_review", "taskClass": "data-extraction", "taskRef": task_ref,
        "briefSha256": sha(brief), "rubricSha256": sha(canonical(RUBRIC)), "sourceRef": "sha256:" + sha(canonical(sources)),
        # The historical CSV offers no producer model or model/workflow route attestation.
        "artifact": {"workflow": "unattributed", "receiptRef": "sha256:" + sha(artifact), "artifactSha256": sha(artifact)},
        "checks": [{"name": key, "passed": ok, "measurementRef": measure_ref} for key, ok in checks.items()],
    }
    event["evidenceId"] = "extract:" + sha(canonical(event))
    return [event], receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("park", "dynadot", "artifact", "brief"):
        parser.add_argument("--" + flag, required=True, type=Path)
    parser.add_argument("--task-ref", required=True, help="Opaque, stable production task reference")
    parser.add_argument("--receipts", type=Path, required=True, help="Local content-addressed measurement directory")
    args = parser.parse_args()
    try:
        events, receipt = collect(args.park.read_bytes(), args.dynadot.read_bytes(), args.artifact.read_bytes(),
                                  args.brief.read_bytes(), args.task_ref)
        args.receipts.mkdir(mode=0o700, exist_ok=True, parents=True)
        data = canonical(receipt)
        (args.receipts / (sha(data) + ".json")).write_bytes(data)
    except (OSError, ValueError, csv.Error) as exc:
        parser.exit(2, f"Extraction evidence unavailable: {exc}\n")
    print(json.dumps(events, indent=2))


if __name__ == "__main__":
    main()
