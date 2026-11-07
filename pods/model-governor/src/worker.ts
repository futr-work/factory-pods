import { D1Storage, PodStorage, toPodStorage } from "@futr-work/pod-kernel/storage";
import { loadPodConfig } from "./config.js";
import { TincanClient } from "@futr-work/pod-kernel/tincan";
import { setHubAuthToken } from "./skill-engine.js";
import { activeHandler } from "./handler.js";
import { renderPodUiHtml } from "./ui.js";
import { TaskRecord } from "./types.js";
import { getModelCatalog, resolveOptimalModel, recordUsage, getTelemetryStats, mapModel, getSubscriptionAdvisor } from "./governor.js";
import { authGate } from "./auth.js";
import { runDiscovery, runScheduledDiscovery } from "./discovery.js";
import { runProbeCycle, recordProbe } from "./probe.js";
import { getUsageReport, runDailyUsageAnalysis } from "./analyzer.js";
import { runInference } from "./inference.js";

interface Env {
  DB: D1Database | PodStorage;
  FACTORY_HUB?: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  POD_ID?: string;
  POD_NAME?: string;
  POD_ROLE?: string;
  POD_LOB?: string;
  FACTORY_HUB_URL?: string;
  FACTORY_HUB_TOKEN?: string;
  GOVERNOR_ADMIN_TOKEN?: string;
  OPENROUTER_API_KEY?: string;
  ORCAROUTER_API_KEY?: string;
  ORCAROUTER_BASE_URL?: string;
  /** HD-set daily ceiling for probing PAID models. Default 0: paid models are never probed automatically. */
  PROBE_BUDGET_USD_DAILY?: string;
}

const json = (body: any, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });

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

    // Auth gate: everything but /health needs a credential; admin routes need the admin token.
    const denied = authGate(request, env);
    if (denied) {
      const h = new Headers(denied.headers);
      for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
      return new Response(denied.body, { status: denied.status, headers: h });
    }

    // Health Check
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          podId: config.id,
          name: config.name,
          role: config.role,
          lob: config.lob,
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
      const stats = await getTelemetryStats(db);
      const catalog = await getModelCatalog(db);
      const hbRow = await db.prepare("SELECT value_json FROM pod_info WHERE key = 'heartbeat'").first<any>();
      const lastHb = hbRow?.value_json ? JSON.parse(hbRow.value_json) : null;
      const usageReport = await getUsageReport(db).catch(() => null);
      const html = renderPodUiHtml(config, tasks, messages, stats, catalog, lastHb, usageReport);

      if (method === "HEAD") {
        return new Response(null, { status: 200, headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response(html, { status: 200, headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" } });
    }

    // API: List Model Catalog with Pricing and Benchmarks
    if (method === "GET" && url.pathname === "/api/models") {
      const catalog = await getModelCatalog(db);
      return new Response(JSON.stringify({ catalog }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // API: Route to the best QUALIFIED model (measured by probes; paid ones approved by HD).
    if (method === "GET" && url.pathname === "/api/models/route") {
      const category = url.searchParams.get("category") || "general_reasoning";
      const maxCost = url.searchParams.get("maxOutputCostPer1M");
      const model = await resolveOptimalModel(db, category, {
        excludeFamily: url.searchParams.get("excludeFamily") || undefined,
        maxOutputCostPer1M: maxCost === null ? undefined : Number(maxCost),
      });
      if (!model) return json({ recommendedModel: null, reason: `no qualified model for category ${category}` }, 404, corsHeaders);
      return json({ recommendedModel: model }, 200, corsHeaders);
    }

    // API: Probe history for one model (read-only).
    if (method === "GET" && url.pathname === "/api/governor/probes") {
      const model = url.searchParams.get("model");
      const rows = await db.prepare(`SELECT * FROM model_probes ${model ? "WHERE model_id = ?" : ""} ORDER BY created_at DESC LIMIT 100`)
        .bind(...(model ? [model] : [])).all<any>();
      return json({ probes: rows.results ?? [] }, 200, corsHeaders);
    }

    // ADMIN: approve / revoke a model for routing. Paid models never qualify without this (ruling #1).
    const adminModel = url.pathname.match(/^\/api\/models\/(.+)\/(approve|revoke)$/);
    if (method === "POST" && adminModel) {
      const id = decodeURIComponent(adminModel[1]);
      const row = await db.prepare("SELECT * FROM model_catalog WHERE id = ?").bind(id).first<any>();
      if (!row) return json({ error: `unknown model ${id}` }, 404, corsHeaders);
      if (adminModel[2] === "approve") {
        const body = (await request.json().catch(() => ({}))) as any;
        await db.prepare("UPDATE model_catalog SET approved_by = ?, approved_at = ? WHERE id = ?")
          .bind(String(body.by || "hd"), Date.now(), id).run();
      } else {
        await db.prepare("UPDATE model_catalog SET approved_by = NULL, approved_at = NULL, lifecycle = CASE WHEN tier = 'PAID' AND lifecycle = 'qualified' THEN 'candidate' ELSE lifecycle END WHERE id = ?")
          .bind(id).run();
      }
      const updated = await db.prepare("SELECT * FROM model_catalog WHERE id = ?").bind(id).first<any>();
      return json({ model: mapModel(updated) }, 200, corsHeaders);
    }

    // Daily usage analysis: read the stored report, or analyze a day now.
    if (method === "GET" && url.pathname === "/api/governor/usage-report") {
      const date = url.searchParams.get("date") ?? undefined;
      const report = await getUsageReport(db, date);
      if (!report) return json({ error: date ? `no report for ${date}` : "no usage report yet" }, 404, corsHeaders);
      return json({ report }, 200, corsHeaders);
    }
    if (method === "POST" && url.pathname === "/api/governor/analyze") {
      const body = (await request.json().catch(() => ({}))) as { date?: string; force?: boolean };
      try {
        const { report, generated } = await runDailyUsageAnalysis(db, Date.now(), { date: body.date, force: body.force === true });
        return json({ report, generated }, 200, corsHeaders);
      } catch (err: any) {
        return json({ error: err.message }, 400, corsHeaders);
      }
    }

    // ADMIN: run discovery or one probe cycle now.
    if (method === "POST" && url.pathname === "/api/governor/discover") {
      return json({ discovery: await runDiscovery(db, env) }, 200, corsHeaders);
    }
    if (method === "POST" && url.pathname === "/api/governor/probe") {
      const body = (await request.json().catch(() => ({}))) as any;
      if (body.model) {
        const row = await db.prepare("SELECT * FROM model_catalog WHERE id = ?").bind(String(body.model)).first<any>();
        if (!row) return json({ error: "unknown model" }, 404, corsHeaders);
        if (row.tier !== "FREE_TIER" && !row.approved_by) return json({ error: "paid model: approve it first (spend gate)" }, 409, corsHeaders);
        const { probeModel } = await import("./probe.js");
        const target = { id: row.id, provider: row.provider, modelName: row.model_name, tier: row.tier, inputCostPer1M: row.input_cost_per_1m, outputCostPer1M: row.output_cost_per_1m };
        const r = await probeModel(target, env);
        return json({ probe: r, lifecycle: await recordProbe(db, target, r, Date.now()) }, 200, corsHeaders);
      }
      return json({ cycle: await runProbeCycle(db, env) }, 200, corsHeaders);
    }

    // ADMIN: record probe results from local worker nodes for OAuth subscription models
    if (method === "POST" && url.pathname === "/api/governor/probe-result") {
      const body = (await request.json().catch(() => ({}))) as any;
      if (!body.modelId || !body.provider || body.passed === undefined || !body.total || !body.device) {
        return json({ error: "Missing required fields (modelId, provider, passed, total, device)" }, 400, corsHeaders);
      }
      const now = Date.now();
      let row = await db.prepare("SELECT * FROM model_catalog WHERE id = ?").bind(String(body.modelId)).first<any>();
      if (!row) {
        const modelName = String(body.modelName || body.modelId);
        const family = String(body.family || body.provider);
        const category = String(body.category || "coding");
        await db.prepare(`
          INSERT INTO model_catalog (
            id, provider, model_name, family, category, tier,
            input_cost_per_1m, output_cost_per_1m, source, first_seen_at, last_seen_at, lifecycle, status
          ) VALUES (?, ?, ?, ?, ?, 'OAUTH', 0, 0, 'oauth_device', ?, ?, 'candidate', 'active')
        `).bind(body.modelId, body.provider, modelName, family, category, now, now).run();
        row = await db.prepare("SELECT * FROM model_catalog WHERE id = ?").bind(String(body.modelId)).first<any>();
      }
      const target = {
        id: row.id,
        provider: row.provider,
        modelName: row.model_name,
        tier: row.tier,
        inputCostPer1M: row.input_cost_per_1m,
        outputCostPer1M: row.output_cost_per_1m,
      };
      const probeRes = {
        modelId: target.id,
        passed: Number(body.passed),
        total: Number(body.total),
        latencyMs: body.latencyMs !== undefined ? Number(body.latencyMs) : null,
        tokensPerSec: body.tokensPerSec !== undefined ? Number(body.tokensPerSec) : null,
        promptTokens: Number(body.promptTokens || 0),
        completionTokens: Number(body.completionTokens || 0),
        costUsd: 0,
        device: String(body.device),
        error: body.error ? String(body.error) : undefined,
        providerError: Boolean(body.providerError || body.error),
      };
      const lifecycle = await recordProbe(db, target, probeRes, now);
      return json({ status: "recorded", modelId: target.id, lifecycle, device: probeRes.device, probe: probeRes }, 200, corsHeaders);
    }

    // API: Subscription Advisor
    if (method === "GET" && url.pathname === "/api/governor/subscription-advisor") {
      const days = Number(url.searchParams.get("days") || 30);
      const minDays = url.searchParams.has("minDays") ? Number(url.searchParams.get("minDays")) : undefined;
      const minEvents = url.searchParams.has("minEvents") ? Number(url.searchParams.get("minEvents")) : undefined;
      const report = await getSubscriptionAdvisor(db, { days, minDays, minEvents });
      return json(report, 200, corsHeaders);
    }

    // Quotas: record or inspect rate limits / exhausted OAuth providers
    if (method === "GET" && url.pathname === "/api/governor/quotas") {
      const rows = await db.prepare("SELECT * FROM provider_quotas ORDER BY updated_at DESC").all<any>();
      return json({ quotas: rows.results ?? [] }, 200, corsHeaders);
    }
    if (method === "POST" && url.pathname === "/api/governor/quotas") {
      const body = (await request.json().catch(() => ({}))) as any;
      if (!body.provider || !body.status) {
        return json({ error: "Missing required fields (provider, status)" }, 400, corsHeaders);
      }
      const now = Date.now();
      await db.prepare(`
        INSERT INTO provider_quotas (provider, status, error, exhausted_at, resets_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET
          status = excluded.status,
          error = excluded.error,
          exhausted_at = excluded.exhausted_at,
          resets_at = excluded.resets_at,
          updated_at = excluded.updated_at
      `).bind(
        body.provider,
        body.status,
        body.error ?? null,
        body.status !== "active" ? now : null,
        body.resetsAt ?? null,
        now
      ).run();
      return json({ status: "recorded", provider: body.provider, quotaStatus: body.status }, 200, corsHeaders);
    }

    // API: Record LLM Usage Telemetry
    if (method === "POST" && url.pathname === "/api/telemetry/log") {
      try {
        const body = (await request.json()) as any;
        if (!body.podId || !body.modelId) {
          return new Response(JSON.stringify({ error: "Missing required fields (podId, modelId)" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const event = await recordUsage(db, {
          podId: body.podId,
          taskId: body.taskId,
          provider: body.provider || "unknown",
          modelId: body.modelId,
          promptTokens: parseInt(body.promptTokens || "0", 10),
          completionTokens: parseInt(body.completionTokens || "0", 10),
          latencyMs: parseInt(body.latencyMs || "0", 10),
          tier: body.tier,
          actualCost: body.actualCost,
          status: body.status === "error" || body.status === "rate_limited" ? body.status : undefined,
        });
        return new Response(JSON.stringify({ status: "recorded", event }), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // API: Governor-mediated inference. Pods send prompts; the governor holds the provider keys, picks a
    // measured model, records the usage and returns the text, so no pod needs its own provider credential.
    if (method === "POST" && url.pathname === "/api/inference") {
      const body = (await request.json().catch(() => null)) as
        | { podId?: string; taskId?: string; category?: string; model?: string; excludeFamily?: string; temperature?: number; maxTokens?: number; messages?: unknown }
        | null;
      if (!body || !body.podId || !Array.isArray(body.messages) || body.messages.length === 0) {
        return json({ error: "podId and a non-empty messages array are required" }, 400, corsHeaders);
      }
      const messages = body.messages.filter(
        (m): m is { role: string; content: string } =>
          Boolean(m) && typeof m === "object" && typeof (m as { role?: unknown }).role === "string" && typeof (m as { content?: unknown }).content === "string",
      );
      if (messages.length !== body.messages.length) return json({ error: "each message needs a string role and content" }, 400, corsHeaders);
      const result = await runInference(db, env, {
        podId: String(body.podId),
        taskId: body.taskId,
        category: body.category,
        model: body.model,
        excludeFamily: body.excludeFamily,
        temperature: body.temperature,
        maxTokens: body.maxTokens,
        messages,
      });
      if (!result.ok) return json({ error: result.error, model: result.model ?? null }, result.status, corsHeaders);
      return json(result, 200, corsHeaders);
    }

    // API: Get Telemetry & TokenMaxxing Analytics
    if (method === "GET" && url.pathname === "/api/telemetry/stats") {
      const stats = await getTelemetryStats(db);
      return new Response(JSON.stringify({ stats }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
            db,
            env: env as any,
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

    // 1b. Model radar: discovery daily (or after a failed run, hourly retry), probes every tick.
    // Both helpers decide their own cadence from stored state, so a tick may do nothing and that is correct.
    try {
      const discovery = await runScheduledDiscovery(db, env);
      if (discovery) {
        const newIds = discovery.flatMap((r) => r.newIds);
        if (newIds.length) await tincan.publish("model.discovered", "pod:pm", { count: newIds.length, ids: newIds.slice(0, 50), reports: discovery.map((r) => ({ ...r, newIds: undefined })) });
      }
      const cycle = await runProbeCycle(db, env);
      console.log(`[governor] probe cycle: ${cycle.probed.length} probed, ${cycle.skippedPaid.length} paid skipped (budget $${cycle.budget})`);
    } catch (err: any) {
      console.error("[governor] radar error:", err?.message || err);
    }

    // 1c. Daily model usage analysis: yesterday's calls, cost and latency beside probe results.
    try {
      const { report, generated } = await runDailyUsageAnalysis(db, Date.now());
      if (generated) {
        await tincan.publish("model.usage_report", "pod:pm", {
          date: report.date,
          totals: report.totals,
          recommendations: report.recommendations.slice(0, 10),
          modelsReported: report.models.length,
        });
        console.log(`[governor] usage report ${report.date}: ${report.totals.calls} calls, $${report.totals.costUsd}, ${report.recommendations.length} recommendations`);
      }
    } catch (err: any) {
      console.error("[governor] usage analysis error:", err?.message || err);
    }

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
            db,
            env: env as any,
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
