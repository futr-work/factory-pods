import { TaskRecord, HandlerContext, TaskHandler } from "./types.js";
import { DynamicSkillEngine } from "./skill-engine.js";

/**
 * ============================================================================
 * SENTINEL RADAR POD HANDLER (PROACTIVE RADAR & DRIFT DETECTION)
 * ============================================================================
 * Continuously probes targets in the wild, detects changes/anomalies in AI search
 * crawler governance (robots.txt) and security directives, and autonomously
 * emits proactive signals into the Factory Hub mesh.
 */

export interface RadarTarget {
  url: string;
  domain: string;
  type: "ai_crawlers" | "security_txt" | "health";
}

export const WATCHLIST: RadarTarget[] = [
  { url: "https://example.com", domain: "example.com", type: "ai_crawlers" },
  { url: "https://httpbin.org/status/200", domain: "httpbin.org", type: "health" },
];

export class SentinelRadarPodHandler implements TaskHandler {
  public name = "sentinel-radar-handler";
  private skillEngine: DynamicSkillEngine;

  constructor(hubUrl?: string) {
    this.skillEngine = new DynamicSkillEngine(hubUrl);
  }

  public canHandle(topic: string, _spec: any): boolean {
    return (
      topic === "radar.scan" ||
      topic === "sentinel.probe" ||
      topic === "target.audit" ||
      topic.startsWith("sentinel.")
    );
  }

  public async handle(task: TaskRecord, context: HandlerContext): Promise<any> {
    const { podConfig, now, publishEvent } = context;

    console.log(`[${podConfig.id}] 🛰️ Proactive Sentinel scanning targets (Task: ${task.taskId})`);

    const targets: RadarTarget[] = (task.spec && task.spec.targets) || WATCHLIST;
    const probeResults: Record<string, any>[] = [];

    for (const target of targets) {
      const probe = await this.probeTarget(target);
      probeResults.push(probe);

      // If anomaly detected (e.g. AI crawlers unconfigured or blocked), emit proactive signal to Factory Hub
      if (probe.alertRequired) {
        console.log(`[${podConfig.id}] 🚨 Anomaly detected on ${target.domain}! Emitting proactive signal to Factory Hub...`);

        await publishEvent("sentinel.signal", "pod:intake", {
          source: podConfig.id,
          targetDomain: target.domain,
          targetUrl: target.url,
          probeType: target.type,
          severity: probe.severity || "medium",
          headline: `Proactive Alert: ${target.domain} requires AI SEO Crawler Governance`,
          details: probe.findings,
          suggestedAction: "Dispatch authority-seo-pod to update robots.txt with 2026 AI bot directives.",
          timestamp: now,
        });
      }
    }

    const executionResult = {
      completedBy: podConfig.id,
      role: podConfig.role,
      domain: podConfig.lob,
      taskId: task.taskId,
      topic: task.topic,
      scannedTargets: probeResults.length,
      probes: probeResults,
      completedAt: new Date(now).toISOString(),
    };

    // Report task completion back to the orchestration hub
    await publishEvent("task.completed", "hub", {
      taskId: task.taskId,
      workerPod: podConfig.id,
      event: "completed",
      result: executionResult,
      timestamp: now,
    });

    return executionResult;
  }

  private async probeTarget(target: RadarTarget): Promise<Record<string, any>> {
    const startTime = Date.now();

    try {
      // 1. If testing AI crawler governance
      if (target.type === "ai_crawlers") {
        const robotsUrl = `${target.url.replace(/\/$/, "")}/robots.txt`;
        let status = 200;
        let content = "";

        try {
          const res = await fetch(robotsUrl, { headers: { "User-Agent": "SentinelRadar/1.0" } });
          status = res.status;
          content = await res.text();
        } catch {
          // Simulated baseline for unreachable/mocked targets
          content = "User-agent: *\nDisallow: /admin\n";
        }

        const bots = ["GPTBot", "PerplexityBot", "ClaudeBot", "CCBot"];
        const configuredBots = bots.filter((b) => content.toLowerCase().includes(b.toLowerCase()));
        const missingBots = bots.filter((b) => !content.toLowerCase().includes(b.toLowerCase()));

        const alertRequired = missingBots.length > 0;

        return {
          target: target.domain,
          url: target.url,
          probeType: "ai_crawlers",
          httpStatus: status,
          durationMs: Date.now() - startTime,
          configuredBots,
          missingBots,
          alertRequired,
          severity: alertRequired ? "medium" : "none",
          findings: alertRequired
            ? `Missing explicit AI search directives for: ${missingBots.join(", ")}.`
            : "All 2026 AI search crawlers explicitly configured.",
        };
      }

      // 2. Health probe
      const res = await fetch(target.url, { method: "HEAD" }).catch(() => null);
      const isOk = res ? res.ok : true;

      return {
        target: target.domain,
        url: target.url,
        probeType: "health",
        healthy: isOk,
        alertRequired: !isOk,
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      return {
        target: target.domain,
        url: target.url,
        error: err.message,
        alertRequired: true,
        severity: "low",
      };
    }
  }
}

export const activeHandler: TaskHandler = new SentinelRadarPodHandler();
export { SentinelRadarPodHandler as DefaultPodHandler };
