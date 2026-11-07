#!/usr/bin/env node
import { AuthoritySeoPodHandler } from "../src/handler.js";
import { loadPodConfig } from "../src/config.js";
import { TaskRecord } from "../src/types.js";

async function run() {
  const targetUrl = process.argv[2] || "https://clinic.example.com/";
  console.log(`\n======================================================`);
  console.log(`🔍 RUNNING SEO POD ON: ${targetUrl}`);
  console.log(`======================================================\n`);

  const handler = new AuthoritySeoPodHandler();
  const config = loadPodConfig();

  const task: TaskRecord = {
    id: 1,
    taskId: `task_cli_${Date.now()}`,
    topic: "seo.audit",
    source: "cli",
    spec: {
      url: targetUrl,
      sampleCap: 10,
    },
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const result = await handler.handle(task, {
    podConfig: config,
    now: Date.now(),
    publishEvent: async (topic, toPod) => {
      console.log(`[Tincan Mesh Event] ${topic} -> ${toPod}`);
    },
  });

  console.log("\n======================================================");
  console.log("📊 AUDIT & REMEDIATION RESULTS");
  console.log("======================================================\n");
  console.log(JSON.stringify(result, null, 2));
}

run().catch((err) => {
  console.error("Execution failed:", err);
  process.exit(1);
});
