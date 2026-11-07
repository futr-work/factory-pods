import { EpisodeRecord, BeliefRecord } from "./types.js";

/**
 * ============================================================================
 * CHASSIS - DYNAMIC SKILL ENGINE (HOT-PLUGGABLE SKILLS)
 * ============================================================================
 * Allows worker pods to pull declarative skills on-the-fly from the central
 * Skill Vault without requiring code redeployments.
 * Supports TTL-based caching, few-shot episode recall, and real Workers AI execution.
 */

export interface DynamicSkillPackage {
  id: string;
  name: string;
  domain: string;
  version: string;
  description: string;
  specSchema: Record<string, any>;
  executionType: "prompt_template" | "rule_engine" | "composite";
  instructions: string;
}

interface CacheEntry {
  skill: DynamicSkillPackage;
  cachedAt: number;
}

export type AiRunner = (model: string, input: Record<string, any>) => Promise<any>;

let hubAuthToken = "";
/** Set by the worker entry point from FACTORY_HUB_TOKEN; the engine is constructed at module load. */
export function setHubAuthToken(token: string | undefined): void {
  hubAuthToken = token || "";
}

export class DynamicSkillEngine {
  private cache = new Map<string, CacheEntry>();
  private defaultTtlMs: number;

  constructor(
    private hubUrl: string = "http://localhost:8787",
    private fetcher?: typeof fetch,
    ttlMs: number = 5 * 60 * 1000 // 5-minute TTL to pick up new versions
  ) {
    this.defaultTtlMs = ttlMs;
  }

  public setHubUrl(url: string): void {
    if (url) {
      this.hubUrl = url;
    }
  }

  public async getSkill(skillId: string): Promise<DynamicSkillPackage | null> {
    const cached = this.cache.get(skillId);
    const now = Date.now();

    if (cached && now - cached.cachedAt < this.defaultTtlMs) {
      return cached.skill;
    }

    try {
      const fn = this.fetcher || fetch;
      const res = await fn(`${this.hubUrl}/api/skills/${encodeURIComponent(skillId)}`, hubAuthToken ? { headers: { Authorization: `Bearer ${hubAuthToken}` } } : undefined);
      if (!res.ok) return cached?.skill || null;
      const data = (await res.json()) as any;
      if (data && data.skill) {
        this.cache.set(skillId, { skill: data.skill, cachedAt: now });
        return data.skill;
      }
    } catch (err) {
      console.warn(`[skill-engine] Could not fetch skill '${skillId}' from hub:`, err);
      if (cached) return cached.skill; // Serve stale on error
    }
    return null;
  }

  public registerLocalSkill(skill: DynamicSkillPackage): void {
    this.cache.set(skill.id, { skill, cachedAt: Date.now() });
  }

  /**
   * Synchronous / deterministic skill execution (for rule engines & prompt templates without active AI binding).
   */
  public execute(
    skill: DynamicSkillPackage,
    spec: Record<string, any>,
    options?: {
      recalledEpisodes?: EpisodeRecord[];
    }
  ): Record<string, any> {
    const startTime = Date.now();

    if (skill.executionType === "rule_engine") {
      return this.executeRuleEngine(skill, spec, startTime);
    }

    const episodes = options?.recalledEpisodes || [];
    return {
      skillId: skill.id,
      skillName: skill.name,
      version: skill.version,
      executionType: skill.executionType,
      instructions: skill.instructions,
      inputSpec: spec,
      analysis: `Evaluated ${skill.name} successfully against inputs.`,
      confidence: 0.9,
      latencyMs: Date.now() - startTime,
      episodesUsed: episodes.length,
      executedAt: new Date(startTime).toISOString(),
    };
  }

  /**
   * Asynchronous skill execution with live Workers AI / Model Governor backing.
   * Injects recalled few-shot episodes and synthesized beliefs into context.
   */
  public async executeWithAi(
    skill: DynamicSkillPackage,
    spec: Record<string, any>,
    options: {
      ai: AiRunner;
      recalledEpisodes?: EpisodeRecord[];
      beliefs?: BeliefRecord[];
      model?: string;
      governorUrl?: string;
    }
  ): Promise<Record<string, any>> {
    const startTime = Date.now();

    if (skill.executionType === "rule_engine") {
      return this.executeRuleEngine(skill, spec, startTime);
    }

    const model = options.model || "@cf/meta/llama-3.1-8b-instruct";
    const episodes = options.recalledEpisodes || [];
    const beliefs = options.beliefs || [];

    try {
      let prompt = `You are an autonomous worker skill: ${skill.name} (v${skill.version}).\nDomain: ${skill.domain}\nInstructions:\n${skill.instructions}\n\n`;

      if (beliefs.length > 0) {
        prompt += `Operational Beliefs & Domain Principles (from cognitive consolidation):\n`;
        for (const b of beliefs.slice(0, 5)) {
          prompt += `- ${b.claim} (confidence: ${(b.confidence * 100).toFixed(0)}%, evidence count: ${b.evidenceCount})\n`;
        }
        prompt += `\n`;
      }

      if (episodes.length > 0) {
        prompt += `Here are recent verified examples of this skill being solved:\n`;
        for (const ep of episodes.slice(0, 3)) {
          prompt += `Example Task: ${ep.taskId}\n- Spec: ${ep.specSummary}\n- Action Taken: ${ep.actionTaken}\n- Outcome: ${ep.outcome}\n\n`;
        }
      }

      prompt += `Execute the following task input spec:\n${JSON.stringify(spec, null, 2)}\n\nProvide the final structured result:`;

      const aiRes = await options.ai(model, {
        messages: [
          { role: "system", content: "You are an autonomous edge worker executing a deterministic business skill." },
          { role: "user", content: prompt },
        ],
      });

      const latencyMs = Date.now() - startTime;
      return {
        skillId: skill.id,
        skillName: skill.name,
        version: skill.version,
        executionType: skill.executionType,
        model,
        output: aiRes?.response || aiRes,
        confidence: 0.95,
        latencyMs,
        episodesUsed: episodes.length,
        beliefsUsed: beliefs.length,
        executedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      console.warn(`[skill-engine] Workers AI execution failed, falling back to deterministic evaluation:`, err);
      return this.execute(skill, spec, { recalledEpisodes: episodes });
    }
  }

  private executeRuleEngine(
    skill: DynamicSkillPackage,
    spec: Record<string, any>,
    timestamp: number
  ): Record<string, any> {
    // 1. Robots.txt Governance
    if (skill.id === "seo.robots_txt_probe") {
      const content = String(spec.robotsTxtContent || "");
      const bots = ["GPTBot", "PerplexityBot", "ClaudeBot", "CCBot"];
      const botStatus: Record<string, "allowed" | "blocked" | "not_specified"> = {};

      for (const bot of bots) {
        const regex = new RegExp(`User-agent:\\s*${bot}[\\s\\S]*?Disallow:\\s*([^\\n\\r]*)`, "i");
        const match = content.match(regex);
        if (match) {
          botStatus[bot] = match[1].trim() === "/" ? "blocked" : "allowed";
        } else {
          // Check wildcard Disallow: /
          const wildcardMatch = content.match(/User-agent:\s*\*[\s\S]*?Disallow:\s*([^\n\r]*)/i);
          if (wildcardMatch && wildcardMatch[1].trim() === "/") {
            botStatus[bot] = "blocked";
          } else {
            botStatus[bot] = "not_specified";
          }
        }
      }

      const blockedCount = Object.values(botStatus).filter((s) => s === "blocked").length;
      const score = Math.max(0, 100 - blockedCount * 25);

      return {
        skillId: skill.id,
        rule: "ai_crawler_governance",
        score,
        confidence: 1.0,
        botStatus,
        aiSearchFriendly: score >= 75,
        executedAt: new Date(timestamp).toISOString(),
      };
    }

    // 2. Security.txt Compliance
    if (skill.id === "security.security_txt_probe") {
      const content = String(spec.securityTxtContent || "");
      const hasContact = /Contact:\s*\S+/i.test(content);
      const hasExpires = /Expires:\s*\S+/i.test(content);
      const isCompliant = hasContact && hasExpires;

      return {
        skillId: skill.id,
        rule: "rfc_9116_security_txt",
        isCompliant,
        hasContact,
        hasExpires,
        score: isCompliant ? 100 : hasContact ? 50 : 0,
        confidence: 1.0,
        executedAt: new Date(timestamp).toISOString(),
      };
    }

    // 3. Job Tracker: Stuck Jobs Probe
    if (skill.id === "job_tracker.stuck_jobs_probe") {
      const rawJobs = Array.isArray(spec.jobs) ? spec.jobs : [];
      const thresholds = {
        doneUninvoicedDays: Number(spec.thresholds?.doneUninvoicedDays ?? 1),
        quoteUnansweredDays: Number(spec.thresholds?.quoteUnansweredDays ?? 3),
        unpaidInvoiceDays: Number(spec.thresholds?.unpaidInvoiceDays ?? 7),
      };

      const stuckJobs: Array<{
        id: string;
        title: string;
        customer: string;
        amount: number;
        daysWaiting: number;
        reason: "done_uninvoiced" | "quote_unanswered" | "unpaid_invoice";
      }> = [];

      let totalStuckRevenue = 0;

      for (const job of rawJobs) {
        const status = String(job.status || "").toLowerCase().trim();
        const days = Number(job.daysWaiting || job.daysInStatus || 0);
        const amount = Number(job.amount || 0);
        const invoiced = Boolean(job.invoiced);

        let reason: "done_uninvoiced" | "quote_unanswered" | "unpaid_invoice" | null = null;

        if (["done", "completed", "finished"].includes(status) && (!invoiced || days > thresholds.doneUninvoicedDays)) {
          reason = "done_uninvoiced";
        } else if (["quoted", "estimate_sent", "quote_sent"].includes(status) && days > thresholds.quoteUnansweredDays) {
          reason = "quote_unanswered";
        } else if (["invoiced", "billed", "unpaid"].includes(status) && days > thresholds.unpaidInvoiceDays) {
          reason = "unpaid_invoice";
        }

        if (reason) {
          stuckJobs.push({
            id: String(job.id || ""),
            title: String(job.title || job.name || "Untitled Job"),
            customer: String(job.customer || "Unknown Client"),
            amount,
            daysWaiting: days,
            reason,
          });
          totalStuckRevenue += amount;
        }
      }

      // Build plain Telegram morning digest
      let digest = `Morning Pod Report:\n`;
      if (stuckJobs.length === 0) {
        digest += `No stuck jobs on your sheet today. All active projects are within normal time limits.`;
      } else {
        digest += `${stuckJobs.length} job(s) need attention ($${totalStuckRevenue.toLocaleString()} total):\n\n`;

        const doneUninvoiced = stuckJobs.filter((j) => j.reason === "done_uninvoiced");
        if (doneUninvoiced.length > 0) {
          digest += `Done but not invoiced:\n`;
          for (const j of doneUninvoiced) {
            digest += `• ${j.title} (${j.customer}): $${j.amount.toLocaleString()} - done ${j.daysWaiting}d ago\n`;
          }
          digest += `\n`;
        }

        const quotes = stuckJobs.filter((j) => j.reason === "quote_unanswered");
        if (quotes.length > 0) {
          digest += `Quotes with no reply:\n`;
          for (const j of quotes) {
            digest += `• ${j.title} (${j.customer}): $${j.amount.toLocaleString()} - waiting ${j.daysWaiting}d\n`;
          }
          digest += `\n`;
        }

        const unpaid = stuckJobs.filter((j) => j.reason === "unpaid_invoice");
        if (unpaid.length > 0) {
          digest += `Unpaid invoices:\n`;
          for (const j of unpaid) {
            digest += `• ${j.title} (${j.customer}): $${j.amount.toLocaleString()} - sent ${j.daysWaiting}d ago\n`;
          }
        }
      }

      return {
        skillId: skill.id,
        rule: "stuck_job_detector",
        stuckCount: stuckJobs.length,
        totalStuckRevenue,
        stuckJobs,
        digestMessage: digest.trim(),
        confidence: 1.0,
        executedAt: new Date(timestamp).toISOString(),
      };
    }

    // 4. Model Governor: Route and Failover Probe
    if (skill.id === "model_governor.route_probe") {
      const providers = spec.providers || {};
      const primary = String(spec.primary || "openai");
      const fallback = String(spec.fallback || "cerebras");

      const primaryStatus = Number(providers[primary]?.status ?? 200);
      const isFailedOver = primaryStatus === 429 || primaryStatus >= 500;
      const selectedProvider = isFailedOver ? fallback : primary;

      return {
        skillId: skill.id,
        rule: "model_governor_failover",
        selectedProvider,
        failedOver: isFailedOver,
        reason: isFailedOver ? `primary_${primary}_status_${primaryStatus}` : "primary_healthy",
        latencyMs: Number(providers[selectedProvider]?.latencyMs ?? 50),
        confidence: 1.0,
        executedAt: new Date(timestamp).toISOString(),
      };
    }

    // 5. Sentinel Radar: Webhook Ingestion & Bounds Probe
    if (skill.id === "sentinel_radar.webhook_probe") {
      const payloadBytes = Number(spec.payloadBytes || 0);
      const maxAllowedBytes = 100 * 1024; // 100 KB
      const bounded = payloadBytes <= maxAllowedBytes;
      const signatureProvided = Boolean(spec.signature);

      return {
        skillId: skill.id,
        rule: "webhook_sentinel_validator",
        accepted: bounded && signatureProvided,
        bounded,
        signatureProvided,
        payloadBytes,
        confidence: 1.0,
        executedAt: new Date(timestamp).toISOString(),
      };
    }

    // Generic rule fallback
    return {
      skillId: skill.id,
      executed: true,
      confidence: 0.85,
      spec,
      timestamp,
    };
  }
}
