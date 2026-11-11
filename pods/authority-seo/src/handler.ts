import { TaskRecord, HandlerContext, TaskHandler } from "./types.js";
import { OrreryConnector } from "./orrery-connector.js";

/**
 * ============================================================================
 * AUTHORITY NETWORK SEO POD HANDLER
 * ============================================================================
 * Production SEO execution engine for the Authority Network (96+ commercial
 * web properties, PBN syndication nodes, and niche authority portals).
 *
 * Core Capabilities:
 *  1. 2026 AI Search Engine & Web Crawler Governance (robots.txt generation)
 *  2. Schema.org JSON-LD Structured Data Generation
 *  3. On-Page Metadata & OpenGraph Optimization
 *  4. Orrery Pod Connector (Deep 16-check crawler & citation classifier)
 *  5. Complete Automated Site Fix Packs (e.g. Example Clinic)
 *  6. Instant IndexNow protocol submission (Bing, Yandex, Seznam)
 *  7. Live Google SERP query & competitive rank analysis (Serper API)
 */

export interface SeoRobotsConfig {
  domain: string;
  sitemapUrl?: string;
  allowAiSearch?: boolean;      // Allow Perplexity, OAI-SearchBot, Claude-Web
  allowAiTraining?: boolean;    // Allow AI training crawlers, including Bytespider; false blocks them (default: true)
  disallowPaths?: string[];     // Private paths repeated in every group (e.g. lead funnels)
}

const SEARCH_ENGINE_AGENTS = ["Googlebot", "Bingbot", "Applebot", "Slurp", "DuckDuckBot", "YandexBot", "Baiduspider"];
const AI_SEARCH_AGENTS = [
  "OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "Perplexity-User",
  "Claude-SearchBot", "Claude-User", "Claude-Web", "Meta-ExternalAgent",
];
const AI_TRAINING_AGENTS = [
  "GPTBot", "CCBot", "Bytespider", "ClaudeBot", "anthropic-ai", "Google-Extended", "Applebot-Extended",
  "cohere-ai", "cohere-training-data-crawler", "Amazonbot", "Meta-ExternalFetcher", "FacebookBot",
  "Diffbot", "MistralAI-User",
];

export interface SeoSchemaConfig {
  type: "Organization" | "WebSite" | "Article" | "LocalBusiness" | "MedicalBusiness" | "FAQPage";
  domain: string;
  name: string;
  description: string;
  url: string;
  details?: Record<string, any>;
}

export interface SeoMetaConfig {
  title: string;
  targetKeyword: string;
  description: string;
  url: string;
}

export class AuthoritySeoPodHandler implements TaskHandler {
  public name = "authority-seo-handler";

  public canHandle(topic: string, _spec: any): boolean {
    return topic.startsWith("seo.") || topic === "task.assigned";
  }

  public async handle(task: TaskRecord, context: HandlerContext): Promise<any> {
    const { podConfig, now, publishEvent } = context;

    console.log(`[${podConfig.id}] Processing SEO task: ${task.taskId} (Topic: ${task.topic})`);

    const spec = task.spec || {};
    const subAction = spec.action || (task.topic.includes(".") ? task.topic.split(".")[1] : "audit");

    let seoResult: any;

    switch (subAction) {
      case "robots":
      case "crawler_policy": {
        seoResult = this.generateRobotsTxt(spec);
        break;
      }
      case "schema": {
        seoResult = this.generateSchemaJsonLd(spec);
        break;
      }
      case "sample_fixpack":
      case "fixpack":
      case "seo_fixpack": {
        seoResult = this.generateSampleFixpack();
        break;
      }
      case "indexnow":
      case "submit_indexnow": {
        seoResult = await this.submitIndexNow(spec, context);
        break;
      }
      case "serp":
      case "google_serp": {
        seoResult = await this.searchGoogleSerp(spec, context);
        break;
      }
      case "meta": {
        seoResult = this.auditAndOptimizeMeta(spec);
        break;
      }
      case "audit":
      case "scan":
      default: {
        const targetUrl = spec.url || (spec.domain ? `https://${spec.domain}/` : undefined);
        if (targetUrl) {
          const connector = new OrreryConnector({
            orreryUrl: podConfig.orreryUrl,
            FACTORY_HUB_TOKEN: podConfig.hubToken,
            ORRERY: context.orreryBinding || (podConfig as any).ORRERY || (podConfig as any).orreryBinding,
          });
          const audit = await connector.auditDomain(targetUrl, { sampleCap: spec.sampleCap || 10 });
          let domain = "target.domain";
          try { domain = new URL(targetUrl).hostname; } catch {}

          const recommendedRobots = this.generateRobotsTxt({ domain });
          const recommendedSchema = this.generateSchemaJsonLd({
            type: domain.includes("Example Clinic") ? "MedicalBusiness" : "Organization",
            domain,
            name: spec.brandName || domain.split(".")[0],
            description: spec.description || `Official web property for ${domain}`,
            url: targetUrl,
          });

          seoResult = {
            audit,
            remediation: {
              recommendedRobots,
              recommendedSchema,
            },
          };
        } else {
          seoResult = this.auditAndOptimizeMeta(spec);
        }
        break;
      }
    }

    const payload = {
      status: "success",
      completedBy: podConfig.id,
      role: podConfig.role,
      lob: podConfig.lob,
      taskId: task.taskId,
      topic: task.topic,
      action: subAction,
      result: seoResult,
      timestamp: now,
      processedAt: now,
    };

    // Broadcast task completion back to the PM Pod via Tincan mesh
    await publishEvent("task.completed", "pod:pm", {
      taskId: task.taskId,
      workerPod: podConfig.id,
      event: "completed",
      result: payload,
      timestamp: now,
      summary: seoResult?.summary || "SEO remediation complete",
    });

    return payload;
  }

  /**
   * Generates a 2026 AI Search & Crawler Governance policy.
   *
   * Default posture is allow-all: search engines, AI citation engines AND AI
   * training crawlers, so the property is cited today and present in future
   * model knowledge. Training can still be opted out per property.
   *
   * A crawler obeys only the most specific group that names it, so
   * `disallowPaths` is repeated in every group rather than only under `*`.
   */
  public generateRobotsTxt(config: Partial<SeoRobotsConfig>): { robotsTxt: string; summary: string } {
    const domain = config.domain || "example.com";
    const sitemapUrl = config.sitemapUrl || `https://${domain}/sitemap.xml`;
    const allowAiSearch = config.allowAiSearch !== false; // Default: true
    const allowAiTraining = config.allowAiTraining !== false; // Default: true (opt in to future models)
    const disallowPaths = (config.disallowPaths ?? []).filter((path) => path.startsWith("/") && path !== "/");

    const group = (comment: string, agents: string[], allow: boolean): string[] => [
      comment,
      ...agents.map((agent) => `User-agent: ${agent}`),
      ...(allow ? ["Allow: /", ...disallowPaths.map((path) => `Disallow: ${path}`)] : ["Disallow: /"]),
      "",
    ];

    const lines: string[] = [
      "# ===========================================================================",
      `# 2026 AI Search Engine & Web Crawler Governance Policy`,
      `# Property: ${domain}`,
      `# Generated: ${new Date().toISOString()}`,
      "# Cloudflare Managed robots.txt / Block AI bots must stay OFF: they",
      "# prepend Disallow groups that override this policy at the edge.",
      "# ===========================================================================",
      "",
      ...group("# Standard Search Engines (Always Allowed)", SEARCH_ENGINE_AGENTS, true),
      ...group(
        allowAiSearch
          ? "# AI Citation & Search Engines (Allowed for LLM citations and AI answers)"
          : "# AI Citation & Search Engines (Disallowed)",
        AI_SEARCH_AGENTS,
        allowAiSearch,
      ),
      ...group(
        allowAiTraining
          ? "# AI Model Training Crawlers (Allowed: include this property in future models)"
          : "# AI Model Training Crawlers (Disallowed)",
        AI_TRAINING_AGENTS,
        allowAiTraining,
      ),
      "# Fallback Policy for All Other User Agents",
      "User-agent: *",
      `Content-Signal: search=yes, ai-input=${allowAiSearch ? "yes" : "no"}, ai-train=${allowAiTraining ? "yes" : "no"}`,
      "Allow: /",
      ...disallowPaths.map((path) => `Disallow: ${path}`),
      "",
      `Sitemap: ${sitemapUrl}`,
    ];

    return {
      robotsTxt: lines.join("\n"),
      summary: `Generated 2026 crawler governance for ${domain} (AI Search: ${allowAiSearch ? 'ALLOWED' : 'BLOCKED'}, Training Scrapers: ${allowAiTraining ? 'ALLOWED' : 'BLOCKED'}).`,
    };
  }

  /**
   * Generates Schema.org JSON-LD structured data for knowledge graph expansion
   */
  public generateSchemaJsonLd(config: Partial<SeoSchemaConfig>): Record<string, any> {
    const schemaType = config.type || "Organization";
    const domain = config.domain || "example.com";
    const name = config.name || "Default Entity";
    const url = config.url || `https://${domain}/`;
    const description = config.description || "Leading authority in our domain space.";

    const baseSchema: Record<string, any> = {
      "@context": "https://schema.org",
      "@type": schemaType,
      name,
      url,
      description,
    };

    if (schemaType === "Organization" || schemaType === "LocalBusiness" || schemaType === "MedicalBusiness") {
      baseSchema.logo = `${url.replace(/\/+$/, "")}/logo.png`;
      if (config.details?.phone) {
        baseSchema.telephone = config.details.phone;
      }
      if (config.details?.addressLocality && config.details?.addressCountry) {
        baseSchema.address = {
          "@type": "PostalAddress",
          addressLocality: config.details.addressLocality,
          addressRegion: config.details.addressRegion || "",
          addressCountry: config.details.addressCountry,
        };
      }
      if (schemaType === "MedicalBusiness" && config.details?.medicalSpecialty) {
        baseSchema.medicalSpecialty = config.details.medicalSpecialty;
      }
      if (config.details?.services && Array.isArray(config.details.services)) {
        baseSchema.hasOfferCatalog = {
          "@type": "OfferCatalog",
          name: `${name} Services`,
          itemListElement: config.details.services.map((svc: string, idx: number) => ({
            "@type": "Offer",
            itemOffered: {
              "@type": "Service",
              name: svc,
            },
            position: idx + 1,
          })),
        };
      }
    }

    return baseSchema;
  }

  /**
   * Evaluates on-page title, meta description, and target keyword density
   */
  public auditAndOptimizeMeta(config: Partial<SeoMetaConfig>): Record<string, any> {
    const rawTitle = config.title || "Authority Portal - Industry Insights";
    const rawDesc = config.description || "Discover verified analysis and expert guides.";
    const keyword = config.targetKeyword || "commercial finance";

    // Optimization rules: Title <= 60 chars, Desc <= 155 chars
    let optimizedTitle = rawTitle;
    if (optimizedTitle.length > 60) {
      optimizedTitle = optimizedTitle.slice(0, 57) + "...";
    }

    let optimizedDesc = rawDesc;
    if (optimizedDesc.length > 155) {
      optimizedDesc = optimizedDesc.slice(0, 152) + "...";
    }

    const keywordInTitle = optimizedTitle.toLowerCase().includes(keyword.toLowerCase());
    const keywordInDesc = optimizedDesc.toLowerCase().includes(keyword.toLowerCase());

    const titleLength = rawTitle.length;
    const descLength = rawDesc.length;

    const titleStatus =
      titleLength >= 50 && titleLength <= 60
        ? "optimal"
        : titleLength < 50
        ? "too_short"
        : "too_long";

    const descStatus =
      descLength >= 140 && descLength <= 160
        ? "optimal"
        : descLength < 140
        ? "too_short"
        : "too_long";

    return {
      url: config.url || "https://example.com/",
      score: (keywordInTitle ? 40 : 0) + (keywordInDesc ? 30 : 0) + (optimizedTitle.length <= 60 ? 15 : 0) + (optimizedDesc.length <= 155 ? 15 : 0),
      title: {
        value: optimizedTitle,
        text: rawTitle,
        length: optimizedTitle.length,
        rawLength: titleLength,
        optimalLength: optimizedTitle.length <= 60,
        status: titleStatus,
        hasKeyword: keywordInTitle,
        recommendation:
          titleStatus === "optimal"
            ? "Title length is ideal."
            : titleLength < 50
            ? "Expand title to between 50-60 characters with high-intent modifiers."
            : "Shorten title to <= 60 characters to avoid SERP ellipsis truncation.",
      },
      description: {
        value: optimizedDesc,
        text: rawDesc,
        length: optimizedDesc.length,
        rawLength: descLength,
        optimalLength: optimizedDesc.length <= 155,
        status: descStatus,
        hasKeyword: keywordInDesc,
        recommendation:
          descStatus === "optimal"
            ? "Meta description length is ideal."
            : descLength < 140
            ? "Expand meta description to 140-160 characters for higher CTR."
            : "Shorten meta description to <= 160 characters.",
      },
      openGraph: {
        "og:title": optimizedTitle,
        "og:description": optimizedDesc,
        "og:type": "website",
        "og:url": config.url || "https://example.com",
      },
    };
  }

  /**
   * Generates a complete production SEO & AI search fix pack
   */
  public generateProductionFixpack(options: { domain?: string } = {}): {
    robotsTxt: string;
    schemaOrgJsonLd: Record<string, any>;
    onPageRecommendations: Record<string, any>;
    summary: string;
  } {
    const domain = options.domain || "clinic.example.com";
    if (domain === "clinic.example.com") {
      return this.generateSampleFixpack();
    }

    const robots = this.generateRobotsTxt({
      domain,
      sitemapUrl: `https://${domain}/sitemap.xml`,
      allowAiSearch: true,
      allowAiTraining: true,
    });

    const schema = this.generateSchemaJsonLd({
      type: "Organization",
      domain,
      name: options.domain?.split(".")[0] || "Example Organization",
      url: `https://${domain}/`,
      description: `Official web property for ${domain}`,
    });

    const homeMeta = this.auditAndOptimizeMeta({
      title: `${domain} — High Performance Edge Platform`,
      description: `Explore enterprise solutions, autonomous worker pods, and edge infrastructure with ${domain}.`,
      targetKeyword: "edge infrastructure",
      url: `https://${domain}/`,
    });

    return {
      robotsTxt: robots.robotsTxt,
      schemaOrgJsonLd: schema,
      onPageRecommendations: { home: homeMeta },
      summary: `Generated production fix pack for ${domain}: AI robots.txt allowing search, AI citation and AI training crawlers, Schema.org Organization JSON-LD, and metadata recommendations.`,
    };
  }

  /**
   * Generates the complete production fix pack for Example Clinic (clinic.example.com)
   */
  public generateSampleFixpack(): {
    robotsTxt: string;
    schemaOrgJsonLd: Record<string, any>;
    onPageRecommendations: Record<string, any>;
    summary: string;
  } {
    const robots = this.generateRobotsTxt({
      domain: "clinic.example.com",
      sitemapUrl: "https://clinic.example.com/sitemap.xml",
      allowAiSearch: true,
      allowAiTraining: true,
    });

    const schema = this.generateSchemaJsonLd({
      type: "MedicalBusiness",
      domain: "clinic.example.com",
      name: "Example Clinic",
      url: "https://clinic.example.com/",
      description: "Online clinical care and personalized health concierge services.",
      details: {
        phone: "+1-555-0100",
        addressLocality: "Denver",
        addressRegion: "CO",
        addressCountry: "US",
        medicalSpecialty: "PrimaryCare",
        services: ["GLP-1 Medical Weight Management", "Telehealth Clinical Evaluation", "Care Concierge Support"],
      },
    });

    const homeMeta = this.auditAndOptimizeMeta({
      title: "Example Clinic — Online care with a personal helping hand.",
      description: "Prepare for online care with Example Clinic. Learn how a Care Concierge can help with the practical steps.",
      targetKeyword: "online care",
      url: "https://clinic.example.com/",
    });

    const glp1Meta = this.auditAndOptimizeMeta({
      title: "GLP-1 Medical Weight Management | Example Clinic Online Care",
      description: "Explore clinician-guided GLP-1 weight management programs, personalized care plans, and ongoing clinical concierge support with Example Clinic.",
      targetKeyword: "GLP-1 medical weight management",
      url: "https://clinic.example.com/glp-1",
    });

    return {
      robotsTxt: robots.robotsTxt,
      schemaOrgJsonLd: schema,
      onPageRecommendations: {
        home: homeMeta,
        glp1: glp1Meta,
      },
      summary: "Generated 2026 AI Search crawler policy, MedicalBusiness Schema.org JSON-LD, and on-page metadata fixes for Example Clinic.",
    };
  }

  /**
   * Submits URLs to the IndexNow protocol for immediate search engine crawling
   */
  public async submitIndexNow(
    options: {
      domain?: string;
      urls?: string[];
      key?: string;
    },
    context?: HandlerContext
  ): Promise<{ status: number; success: boolean; submitted: number; host: string; message: string }> {
    const domain = options.domain || "clinic.example.com";
    const key = options.key || context?.env?.INDEXNOW_KEY || (typeof process !== "undefined" ? process.env?.INDEXNOW_KEY : "") || "";
    if (!key) {
      return {
        status: 400,
        success: false,
        submitted: 0,
        host: domain,
        message: "INDEXNOW_KEY is not configured; set it as a Worker secret and host it at /<key>.txt.",
      };
    }
    const urls = options.urls && options.urls.length > 0 ? options.urls : [`https://${domain}/`, `https://${domain}/glp-1`, `https://${domain}/guides/glp-1-care-cycle`];

    const payload = {
      host: domain,
      key,
      keyLocation: `https://${domain}/${key}.txt`,
      urlList: urls,
    };

    try {
      const resp = await fetch("https://api.indexnow.org/IndexNow", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
      });

      return {
        status: resp.status,
        success: resp.status === 200 || resp.status === 202,
        submitted: urls.length,
        host: domain,
        message: resp.status === 200 || resp.status === 202
          ? "URLs submitted successfully to IndexNow."
          : `IndexNow returned status ${resp.status}`,
      };
    } catch (err: any) {
      return {
        status: 500,
        success: false,
        submitted: 0,
        host: domain,
        message: `Failed to submit to IndexNow: ${err.message}`,
      };
    }
  }

  /**
   * Executes a live Google SERP query using Serper.dev API
   */
  public async searchGoogleSerp(
    options: {
      query: string;
      apiKey?: string;
      num?: number;
      country?: string;
    },
    context?: HandlerContext
  ): Promise<any> {
    const apiKey = options.apiKey || context?.env?.SERPER_API_KEY || context?.env?.SISTRIX_API_KEY || (typeof process !== "undefined" ? (process.env?.SERPER_API_KEY || process.env?.SISTRIX_API_KEY) : "");
    if (!apiKey) {
      throw new Error("SERPER_API_KEY is required to query live Google SERP");
    }

    const resp = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: options.query,
        num: options.num || 10,
        gl: options.country || "us",
      }),
    });

    if (!resp.ok) {
      throw new Error(`Serper API returned status ${resp.status}: ${await resp.text()}`);
    }

    return await resp.json();
  }
}

export const activeHandler: TaskHandler = new AuthoritySeoPodHandler();
export { AuthoritySeoPodHandler as DefaultPodHandler };
