#!/usr/bin/env python3
"""Read an OpenBot production workload and draw a bounded review sample without model calls."""
import argparse
import hashlib
import json
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

QUERY = """
WITH task_keys AS (
    SELECT DISTINCT recipient_agent_id, message_id
    FROM projection_deliveries WHERE created_at >= ? AND created_at < ?
),
attempts AS (
    SELECT d.recipient_agent_id AS agent, d.message_id, d.turn_id, d.status, d.created_at,
           ROW_NUMBER() OVER (
               PARTITION BY d.recipient_agent_id, d.message_id
               ORDER BY d.created_at DESC, d.delivery_id DESC
           ) AS latest
    FROM projection_deliveries d JOIN task_keys k
      ON d.recipient_agent_id=k.recipient_agent_id AND d.message_id=k.message_id
    WHERE d.created_at < ?
),
cohort AS (
    SELECT agent, message_id, COUNT(*) AS deliveries, COUNT(DISTINCT turn_id) AS turns,
           MAX(CASE WHEN latest=1 THEN status END) AS status
    FROM attempts GROUP BY agent, message_id HAVING MIN(created_at) >= ?
),
unique_turns AS (
    SELECT DISTINCT a.agent, a.message_id, a.turn_id FROM attempts a
    JOIN cohort c ON c.agent=a.agent AND c.message_id=a.message_id WHERE a.turn_id IS NOT NULL
),
metering AS (
    SELECT t.agent, t.message_id, COUNT(u.record_id) AS usage_rows
    FROM unique_turns t LEFT JOIN agent_usage_records u ON u.agent_id=t.agent AND u.turn_id=t.turn_id
    GROUP BY t.agent,t.message_id
)
SELECT c.*, COALESCE(m.usage_rows,0) AS usage_rows,
       (SELECT COUNT(*) FROM (SELECT DISTINCT u.agent_id, u.record_id FROM agent_usage_records u
          JOIN unique_turns t ON t.turn_id=u.turn_id AND t.agent=u.agent_id)) AS unique_usage_rows
FROM cohort c LEFT JOIN metering m
ON c.agent=m.agent AND c.message_id=m.message_id
"""

def sample(db, start, end, seed, random_n, failure_n, class_map=None):
    rows = db.execute(QUERY, (start, end, end, start))
    tasks = []
    unique_usage_rows = 0
    for agent, message, deliveries, turns, status, usage_rows, unique_usage_rows in rows:
        # Include the recipient: a message may be delivered to more than one agent.
        key = json.dumps([agent, message], separators=(",", ":")).encode()
        ref = "openbot:" + hashlib.sha256(key).hexdigest()
        tasks.append(dict(taskRef=ref, agentId=agent, messageId=message, lastDeliveryStatus=status,
                          deliveries=deliveries, turns=turns, usageRecords=usage_rows))
    def priority(t):
        return hashlib.sha256((seed + "\x00" + t["taskRef"]).encode()).digest()
    ordered = sorted(tasks, key=priority)
    strata = defaultdict(list)
    for task in ordered:
        task["taskClass"] = (class_map or {}).get(task["taskRef"], "unclassified")
        strata[task["taskClass"]].append(task)
    stratified = class_map is not None and random_n >= len(strata) and bool(strata)
    if stratified:
        # Give small families a place, then put additional slots where sampling coverage is lowest.
        slots = dict.fromkeys(strata, 1)
        for _ in range(min(random_n, len(tasks)) - len(slots)):
            family = min((k for k in strata if slots[k] < len(strata[k])),
                         key=lambda k: (slots[k] / len(strata[k]), k))
            slots[family] += 1
        random_sample = [t for k, group in strata.items() for t in group[:slots[k]]]
    else:
        random_sample = ordered[:random_n]
    selected = {t["taskRef"] for t in random_sample}
    for task in random_sample:
        family = task["taskClass"]
        probability = slots[family] / len(strata[family]) if stratified else len(random_sample) / len(tasks)
        task["populationInclusionProbability"] = probability
    failed = [t for t in ordered if t["taskRef"] not in selected and t["lastDeliveryStatus"] in ("failed", "interrupted", "cancelled", "canceled")]
    return {
        "cohort": {"firstDeliveryFromUtc": start, "beforeUtc": end, "observedAtUtc": datetime.now(timezone.utc).isoformat()},
        "taskDefinition": "One originating OpenBot message per recipient. A later new message may belong to the same business job.",
        "tasks": len(tasks), "distinctAgents": len({t["agentId"] for t in tasks}),
        "deliveries": sum(t["deliveries"] for t in tasks),
        "linkedUsageRecords": unique_usage_rows,
        "taskToUsageLinks": sum(t["usageRecords"] for t in tasks),
        "tasksWithUsage": sum(t["usageRecords"] > 0 for t in tasks),
        "latestDeliveryStatus": dict(Counter(t["lastDeliveryStatus"] for t in tasks)),
        "classCounts": {k: len(v) for k, v in strata.items()},
        "review": {"seed": seed, "method": "stratified" if stratified else "simple_random", "populationSample": random_sample, "additionalFailureSample": failed[:failure_n]},
    }

def nonnegative(value):
    n = int(value)
    if n < 0:
        raise argparse.ArgumentTypeError("must be nonnegative")
    return n

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path)
    parser.add_argument("--hours", type=int, default=24)
    parser.add_argument("--before", type=datetime.fromisoformat, help="timezone-aware exclusive UTC cohort cutoff")
    parser.add_argument("--seed", help="use the same seed and boundaries to reproduce the selection")
    parser.add_argument("--random", type=nonnegative, default=8)
    parser.add_argument("--failures", type=nonnegative, default=4)
    parser.add_argument("--class-map", type=Path, help="optional JSON object mapping stable taskRef to externally assigned task class")
    args = parser.parse_args()
    classes = None
    if args.class_map:
        classes = json.loads(args.class_map.read_text())
        if not isinstance(classes, dict) or not all(isinstance(v, str) and v.strip() for v in classes.values()):
            parser.error("class map must contain task reference keys and non-empty class names")
    end = args.before or datetime.now(timezone.utc)
    if end.tzinfo is None or args.hours <= 0:
        parser.error("use a positive number of hours and a timezone-aware cutoff")
    end = end.astimezone(timezone.utc)
    def utc(t):
        return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    with sqlite3.connect(args.database.resolve().as_uri() + "?mode=ro", uri=True) as db:
        print(json.dumps(sample(db, utc(end - timedelta(hours=args.hours)), utc(end),
                                args.seed or utc(end)[:10], args.random, args.failures, classes), indent=2))
