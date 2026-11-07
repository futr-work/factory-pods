import { D1Storage, PodStorage, toPodStorage } from "@futr-work/pod-kernel/storage";
import { authGate } from "@futr-work/pod-kernel/auth";
import { loadPodConfig } from "./config.js";
import { TincanClient } from "@futr-work/pod-kernel/tincan";
import { setHubAuthToken } from "./skill-engine.js";
import { activeHandler } from "./handler.js";
import { renderPodUiHtml } from "./ui.js";
import { TaskRecord } from "./types.js";

interface Env {
  DB: D1Database | PodStorage;
  AI?: any;
  FACTORY_HUB?: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  POD_ID?: string;
  POD_NAME?: string;
  POD_ROLE?: string;
  POD_LOB?: string;
  FACTORY_HUB_URL?: string;
  FACTORY_HUB_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const config = loadPodConfig(env as any);
    setHubAuthToken(config.hubToken);
    const tincan = new TincanClient(config, env.FACTORY_HUB);
    const db: PodStorage = toPodStorage(env.DB);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Auth gate (C1 containment): every route but /health needs the hub token.
    const denied = authGate(request, env as any);
    if (denied) return denied;

    // Health Check
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          podId: config.id,
          name: config.name,
          role: config.role,
          lob: config.lob,
          hasAiBinding: !!env.AI,
          edge: true,
          timestamp: Date.now(),
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Cockpit UI
    if ((method === "GET" || method === "HEAD") && (url.pathname === "/" || url.pathname === "/index.html")) {
      const tasks = await getTasks(db, 30);
      const messages = await getMessages(db, 20);
      const hbRow = await db.prepare("SELECT value_json FROM pod_info WHERE key = 'heartbeat'").first<any>();
      const lastHb = hbRow?.value_json ? JSON.parse(hbRow.value_json) : null;
      const html = renderPodUiHtml(config, tasks, messages, lastHb);

      if (method === "HEAD") {
        return new Response(null, { status: 200, headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response(html, { status: 200, headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" } });
    }

    // API: Ingest & Execute Task
    if (method === "POST" && url.pathname === "/api/task") {
      try {
        const body = (await request.json()) as any;
        const taskId = body.taskId || `task_${Date.now()}`;
        const topic = body.topic || "generic.task";
        const source = body.source || "api";
        const spec = body.spec || {};
        const now = Date.now();

        // Save task as running in D1
        const insertRes = await db.prepare(`
          INSERT INTO tasks (task_id, topic, source, spec_json, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'running', ?, ?)
        `)
          .bind(taskId, topic, source, JSON.stringify(spec), now, now)
          .run();

        const id = insertRes.meta.last_row_id || 0;
        const taskRecord: TaskRecord = {
          id,
          taskId,
          topic,
          source,
          spec,
          status: "running",
          createdAt: now,
          updatedAt: now,
        };

        // Execute pluggable business handler
        try {
          const result = await activeHandler.handle(taskRecord, {
            podConfig: config,
            now,
            publishEvent: async (evTopic, toPod, payload) => {
              await tincan.publish(evTopic, toPod, payload);
              await logMessage(db, "outbound", evTopic, config.id, toPod, payload);
            },
          });

          // Mark completed
          await db.prepare(`
            UPDATE tasks SET status = 'completed', result_json = ?, updated_at = ? WHERE task_id = ?
          `)
            .bind(JSON.stringify(result), Date.now(), taskId)
            .run();

          return new Response(JSON.stringify({ success: true, taskId, status: "completed", result }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (execErr: any) {
          // Mark failed
          await db.prepare(`
            UPDATE tasks SET status = 'failed', error_message = ?, updated_at = ? WHERE task_id = ?
          `)
            .bind(execErr?.message || String(execErr), Date.now(), taskId)
            .run();

          return new Response(JSON.stringify({ error: execErr?.message || "Task execution failed", taskId }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err?.message || "Invalid payload" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // API: List Tasks
    if (method === "GET" && url.pathname === "/api/tasks") {
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const tasks = await getTasks(db, limit);
      return new Response(JSON.stringify({ tasks }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // API: Heartbeat Status and Trigger
    if (url.pathname === "/api/heartbeat") {
      if (method === "GET") {
        const row = await db.prepare("SELECT value_json, updated_at FROM pod_info WHERE key = 'heartbeat'").first<any>();
        const parsed = row?.value_json ? JSON.parse(row.value_json) : null;
        return new Response(
          JSON.stringify({
            status: "healthy",
            podId: config.id,
            heartbeat: parsed || { status: "healthy", lastHeartbeat: Date.now(), deliveredToHub: false, hubUrl: config.hubUrl },
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (method === "POST") {
        const ok = await tincan.sendHeartbeat();
        const now = Date.now();
        await recordPodHeartbeat(db, config.id, {
          status: "healthy",
          lastHeartbeat: now,
          hubUrl: config.hubUrl,
          deliveredToHub: ok,
          role: config.role,
          capabilities: config.capabilities,
        });

        return new Response(
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
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  },

  // Scheduled cron worker: runs periodic heartbeats & polls Factory Hub for tasks
  async scheduled(event: any, env: Env): Promise<void> {
    const config = loadPodConfig(env as any);
    setHubAuthToken(config.hubToken);
    const tincan = new TincanClient(config, env.FACTORY_HUB);
    const db: PodStorage = toPodStorage(env.DB);

    // 1. Send heartbeat & persist locally
    const hbOk = await tincan.sendHeartbeat();
    await recordPodHeartbeat(db, config.id, {
      status: "healthy",
      lastHeartbeat: Date.now(),
      hubUrl: config.hubUrl,
      deliveredToHub: hbOk,
      role: config.role,
      capabilities: config.capabilities,
    });

    // 2. Poll for pending tasks assigned to this pod
    const messages = await tincan.pollInbox(5);
    for (const msg of messages) {
      if (msg.topic === "task.assigned" && msg.payload) {
        const payload = msg.payload;
        const taskId = payload.taskId || msg.id;
        const now = Date.now();

        await db.prepare(`
          INSERT INTO tasks (task_id, topic, source, spec_json, status, created_at, updated_at)
          VALUES (?, ?, 'factory-hub-mesh', ?, 'running', ?, ?)
          ON CONFLICT(task_id) DO NOTHING
        `)
          .bind(taskId, msg.topic, JSON.stringify(payload.spec || payload), now, now)
          .run();

        const taskRecord: TaskRecord = {
          id: 0,
          taskId,
          topic: msg.topic,
          source: "factory-hub-mesh",
          spec: payload.spec || payload,
          status: "running",
          createdAt: now,
          updatedAt: now,
        };

        try {
          const result = await activeHandler.handle(taskRecord, {
            podConfig: config,
            now,
            publishEvent: async (evTopic, toPod, pl) => {
              await tincan.publish(evTopic, toPod, pl);
            },
          });

          await db.prepare("UPDATE tasks SET status = 'completed', result_json = ?, updated_at = ? WHERE task_id = ?")
            .bind(JSON.stringify(result), Date.now(), taskId)
            .run();
        } catch (err: any) {
          await db.prepare("UPDATE tasks SET status = 'failed', error_message = ?, updated_at = ? WHERE task_id = ?")
            .bind(err?.message || "Execution error", Date.now(), taskId)
            .run();
        }

        // Acknowledge envelope on Factory Hub
        await tincan.acknowledge(msg.id);
      }
    }
  },
};

async function getTasks(db: PodStorage, limit = 50): Promise<TaskRecord[]> {
  try {
    const res = await db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").bind(limit).all<any>();
    return res.results.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      topic: r.topic,
      source: r.source,
      spec: JSON.parse(r.spec_json),
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

async function getMessages(db: PodStorage, limit = 30): Promise<any[]> {
  try {
    const res = await db.prepare("SELECT * FROM tincan_messages ORDER BY created_at DESC LIMIT ?").bind(limit).all<any>();
    return res.results;
  } catch {
    return [];
  }
}

async function logMessage(db: PodStorage, direction: string, topic: string, fromPod: string, toPod: string, payload: any) {
  try {
    const msgId = `tc_pod_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    await db.prepare(`
      INSERT INTO tincan_messages (id, direction, topic, from_pod, to_pod, payload_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'delivered', ?)
    `)
      .bind(msgId, direction, topic, fromPod, toPod, JSON.stringify(payload), Date.now())
      .run();
  } catch {}
}

async function recordPodHeartbeat(db: PodStorage, podId: string, info: Record<string, any>): Promise<void> {
  try {
    const now = Date.now();
    await db.prepare(`
      INSERT INTO pod_info (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `)
      .bind("heartbeat", JSON.stringify({ podId, ...info, updatedAt: now }), now)
      .run();
  } catch (err) {
    console.warn("[worker] Failed to record pod heartbeat locally:", err);
  }
}
