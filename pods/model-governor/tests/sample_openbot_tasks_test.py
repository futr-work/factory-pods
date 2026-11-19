import runpy
import sqlite3
import unittest
from pathlib import Path

sample = runpy.run_path(str(Path(__file__).resolve().parents[1] / "bin/sample-openbot-tasks.py"))["sample"]


class SampleTest(unittest.TestCase):
    def test_retries_fanout_and_missing_usage(self):
        db = sqlite3.connect(":memory:")
        db.executescript("""
            CREATE TABLE projection_deliveries(delivery_id, recipient_agent_id, message_id, turn_id, status, created_at);
            CREATE TABLE agent_usage_records(record_id, agent_id, turn_id);
            INSERT INTO projection_deliveries VALUES
              ('d0','x','old','old-turn','failed','01'), ('d1','x','old','retry','completed','04'),
              ('d2','x','m','first','failed','04'), ('d3','x','m','second','completed','05'),
              ('d4','y','m','yturn','failed','04'), ('d5','z','other','zturn','running','06');
            INSERT INTO agent_usage_records VALUES ('u1','x','first'),('u2','x','second'),('u3','x','second');
        """)
        r = sample(db, "03", "09", "seed", 100, 100)
        self.assertEqual((r["tasks"], r["deliveries"], r["linkedUsageRecords"], r["tasksWithUsage"]), (3, 4, 3, 1))
        self.assertEqual(r["latestDeliveryStatus"], {"completed": 1, "running": 1, "failed": 1})
        self.assertEqual(r["review"]["additionalFailureSample"], [])
        targeted = sample(db, "03", "09", "seed", 0, 1)["review"]["additionalFailureSample"]
        self.assertEqual([x["agentId"] for x in targeted], ["y"])
        self.assertEqual(r["review"]["populationSample"], sample(db,"03","09","seed",100,0)["review"]["populationSample"])
        db.execute("INSERT INTO projection_deliveries VALUES ('d6','x','m2','second','completed','06')")
        shared = sample(db, "03", "09", "seed", 8, 4)
        self.assertEqual((shared["linkedUsageRecords"], shared["taskToUsageLinks"]), (3, 5))
        mapping = {t["taskRef"]: ("rare" if t["agentId"] == "y" else "routine")
                   for t in shared["review"]["populationSample"]}
        strat = sample(db, "03", "09", "seed", 2, 1, mapping)
        draw = strat["review"]["populationSample"]
        self.assertEqual(strat["review"]["method"], "stratified")
        self.assertEqual({t["taskClass"]: t["populationInclusionProbability"] for t in draw},
                         {"rare": 1, "routine": 1/3})
        self.assertEqual(sample(db, "03", "09", "seed", 1, 0, mapping)["review"]["method"], "simple_random")
        db.close()

if __name__ == "__main__":
    unittest.main()
