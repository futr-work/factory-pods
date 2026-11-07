import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadPodConfig } from "../src/config.js";
import { renderPodUiHtml } from "../src/ui.js";
import worker from "../src/worker.js";
import { DatabaseSync } from "node:sqlite";
import { SqliteFileStorage } from "@futr-work/pod-kernel/storage/sqlite";

describe("Pod Cockpit Dashboard & Resilient Heartbeat Test Suite", () => {
  test("1. renderPodUiHtml surfaces authentication password pill and heartbeat controls", () => {
    const config = loadPodConfig();
    const html = renderPodUiHtml(config, [], [], {
      status: "healthy",
      lastHeartbeat: Date.now(),
      deliveredToHub: true,
    });

    assert.ok(html.includes("Auth: <code>FACTORY_HUB_TOKEN</code>"), "Dashboard names the auth variable");
    assert.ok(!html.includes("test-token"), "Dashboard never discloses a credential");
    assert.ok(html.includes("Send Heartbeat"), "Dashboard includes manual heartbeat trigger");
    assert.ok(html.includes("Heartbeat Active"), "Recent heartbeat displays active pill");
    assert.ok(html.includes("id=\"toastContainer\""), "Toast container is present for non-blocking notifications");
    assert.ok(!html.includes('alert("Heartbeat failed")'), "No blocking error alert in script");
  });

  test("2. /api/heartbeat records local state and returns 200 OK even if Hub is unreachable", async () => {
    // In-memory SQLite backed D1 mock
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE pod_info (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT UNIQUE NOT NULL,
        topic TEXT NOT NULL,
        source TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        error_message TEXT,
        lease_expires_at INTEGER,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE tincan_messages (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL,
        topic TEXT NOT NULL,
        from_pod TEXT NOT NULL,
        to_pod TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    const storage = new SqliteFileStorage(sqlite);

    const mockEnv = {
      DB: storage,
      FACTORY_HUB_TOKEN: "test-token",
      HUB_URL: "http://127.0.0.1:9999", // intentionally unreachable
    };

    // Make POST /api/heartbeat
    const req = new Request("http://localhost:8787/api/heartbeat", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
      },
    });

    const res = await worker.fetch(req, mockEnv as any);
    assert.equal(res.status, 200, "Heartbeat must return HTTP 200 rather than crashing or returning 502");

    const data: any = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.deliveredToHub, false, "Correctly detects hub is unreachable");
    assert.equal(data.status, "healthy");
    assert.ok(data.message.includes("Heartbeat recorded locally"));

    // Check DB persistence in pod_info
    const row: any = sqlite.prepare("SELECT value_json FROM pod_info WHERE key = 'heartbeat'").get();
    assert.ok(row, "Heartbeat must be saved in pod_info");
    const parsed = JSON.parse(row.value_json);
    assert.equal(parsed.status, "healthy");
    assert.equal(parsed.deliveredToHub, false);

    // Test GET /api/heartbeat
    const getReq = new Request("http://localhost:8787/api/heartbeat", {
      method: "GET",
      headers: {
        Authorization: "Bearer test-token",
      },
    });
    const getRes = await worker.fetch(getReq, mockEnv as any);
    assert.equal(getRes.status, 200);
    const getData: any = await getRes.json();
    assert.equal(getData.status, "healthy");
    assert.equal(getData.heartbeat.status, "healthy");
  });
});
