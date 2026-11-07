import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { SqliteFileStorage } from "@futr-work/pod-kernel/storage/sqlite";
import { PodStorage } from "@futr-work/pod-kernel/storage";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPodConfig } from "./config.js";
import { TincanClient } from "@futr-work/pod-kernel/tincan";
import { activeHandler } from "./handler.js";
import { renderPodUiHtml } from "./ui.js";
import { handleMcpRequest } from "./mcp.js";
import { TaskRecord } from "./types.js";

async function main() {
  const config = loadPodConfig();
  const tincan = new TincanClient(config);

  const dataDir = join(tmpdir(), `pod_${config.id}`);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "pod.sqlite");

  const db = new SqliteFileStorage(dbPath);
  const schemaPath = join(import.meta.dirname, "..", "schema.sql");
  if (existsSync(schemaPath)) {
    db.exec(readFileSync(schemaPath, "utf8"));
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const method = req.method || "GET";

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", podId: config.id, role: config.role, lob: config.lob }));
      return;
    }

    if (url.pathname === "/mcp" || url.pathname === "/api/mcp") {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      let body: any = null;
      if (method === "POST") {
        body = await parseJson(req);
      }
      const fetchReq = new Request(url.toString(), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const fetchRes = await handleMcpRequest(fetchReq, { DB: db }, config);
      res.writeHead(fetchRes.status, Object.fromEntries(fetchRes.headers.entries()));
      res.end(await fetchRes.text());
      return;
    }

    if ((method === "GET" || method === "HEAD") && (url.pathname === "/" || url.pathname === "/index.html")) {
      const tasks = await getLocalTasks(db);
      const messages = await getLocalMessages(db);
      const lastHb = await getLocalHeartbeat(db);
      const html = renderPodUiHtml(config, tasks, messages, lastHb);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(method === "HEAD" ? "" : html);
      return;
    }

    if (method === "POST" && url.pathname === "/api/task") {
      try {
        const body = await parseJson(req);
        const taskId = body.taskId || `task_${Date.now()}`;
        const topic = body.topic || "generic.task";
        const source = body.source || "api";
        const spec = body.spec || {};
        const now = Date.now();

        const insert = db.prepare(`
          INSERT INTO tasks (task_id, topic, source, spec_json, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'running', ?, ?)
        `);
        const row = await insert.bind(taskId, topic, source, JSON.stringify(spec), now, now).run();

        const taskRecord: TaskRecord = {
          id: Number(row.meta.last_row_id || 0),
          taskId,
          topic,
          source,
          spec,
          status: "running",
          createdAt: now,
          updatedAt: now,
        };

        const result = await activeHandler.handle(taskRecord, {
          podConfig: config,
          now,
          publishEvent: async (evTopic, toPod, pl) => {
            await tincan.publish(evTopic, toPod, pl);
            await db.prepare(`
              INSERT INTO tincan_messages (id, direction, topic, from_pod, to_pod, payload_json, status, created_at)
              VALUES (?, 'outbound', ?, ?, ?, ?, 'delivered', ?)
            `).bind(`tc_${Date.now()}`, evTopic, config.id, toPod, JSON.stringify(pl), Date.now()).run();
          },
        });

        await db.prepare("UPDATE tasks SET status = 'completed', result_json = ?, updated_at = ? WHERE task_id = ?")
          .bind(JSON.stringify(result), Date.now(), taskId).run();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, taskId, status: "completed", result }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Execution error" }));
      }
      return;
    }

    if (url.pathname === "/api/heartbeat") {
      if (method === "GET") {
        const lastHb = await getLocalHeartbeat(db);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "healthy",
            podId: config.id,
            heartbeat: lastHb || { status: "healthy", lastHeartbeat: Date.now(), deliveredToHub: false, hubUrl: config.hubUrl },
          })
        );
        return;
      }

      if (method === "POST") {
        const ok = await tincan.sendHeartbeat();
        const now = Date.now();
        await recordLocalHeartbeat(db, config.id, {
          status: "healthy",
          lastHeartbeat: now,
          hubUrl: config.hubUrl,
          deliveredToHub: ok,
          role: config.role,
          capabilities: config.capabilities,
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            status: "healthy",
            podId: config.id,
            deliveredToHub: ok,
            hubUrl: config.hubUrl,
            lastHeartbeat: now,
            message: ok
              ? "Heartbeat delivered to Factory Hub mesh"
              : "Heartbeat recorded locally (mesh hub offline or unreachable)",
          })
        );
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(config.port, "0.0.0.0", () => {
    console.log(`\n======================================================`);
    console.log(`⚡ FACTORY POD: ${config.name.toUpperCase()}`);
    console.log(`======================================================`);
    console.log(`🏢 Line of Business: ${config.lob}`);
    console.log(`🎭 Role:             ${config.role}`);
    console.log(`📡 Local Cockpit:    http://127.0.0.1:${config.port}`);
    console.log(`🛰️  Connected Hub:    ${config.hubUrl}`);
    console.log(`======================================================\n`);
  });
}

function parseJson(req: IncomingMessage): Promise<any> {
  const { promise, resolve, reject } = Promise.withResolvers<any>();
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    try { resolve(body ? JSON.parse(body) : {}); }
    catch (e) { reject(new Error("Invalid JSON")); }
  });
  req.on("error", reject);
  return promise;
}

async function getLocalTasks(db: PodStorage): Promise<TaskRecord[]> {
  try {
    const res = await db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50").all<any>();
    return (res.results || []).map((r) => ({
      id: r.id,
      taskId: r.task_id,
      topic: r.topic,
      source: r.source,
      spec: JSON.parse(r.spec_json || "{}"),
      status: r.status,
      result: r.result_json ? JSON.parse(r.result_json) : undefined,
      errorMessage: r.error_message,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  } catch {
    return [];
  }
}

async function getLocalMessages(db: PodStorage): Promise<any[]> {
  try {
    const res = await db.prepare("SELECT * FROM tincan_messages ORDER BY created_at DESC LIMIT 20").all<any>();
    return res.results || [];
  } catch {
    return [];
  }
}

async function recordLocalHeartbeat(db: PodStorage, podId: string, info: Record<string, any>): Promise<void> {
  try {
    const now = Date.now();
    await db.prepare(`
      INSERT INTO pod_info (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).bind("heartbeat", JSON.stringify({ podId, ...info, updatedAt: now }), now).run();
  } catch (err) {
    console.warn("[main] Failed to record local heartbeat:", err);
  }
}

async function getLocalHeartbeat(db: PodStorage): Promise<any> {
  try {
    const row = await db.prepare("SELECT value_json FROM pod_info WHERE key = 'heartbeat'").first<any>();
    return row?.value_json ? JSON.parse(row.value_json) : null;
  } catch {
    return null;
  }
}

main().catch(console.error);
