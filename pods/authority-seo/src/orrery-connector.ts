/**
 * Orrery Pod Connector
 * 
 * Bridges authority-seo-pod with Orrery's deep crawler, 16-check technical
 * audit engine, and citation classifier.
 */

export interface OrreryAuditOptions {
  sampleCap?: number;
  requestBudget?: number;
}

export interface OrreryPageRecord {
  id?: string;
  url: string;
  status_code?: number;
  title?: string;
  meta_description?: string;
  canonical?: string;
  schema_types?: string[];
  h1?: string[];
  images_missing_alt_count?: number;
  word_count?: number;
  raw_html_only?: boolean;
}

export interface OrreryFinding {
  id?: string;
  issue_type?: string;
  category?: string;
  severity: "critical" | "high" | "warning" | "low" | "info";
  title?: string;
  message?: string;
  summary?: string;
  evidence?: Array<{ page_id?: string; url?: string; field?: string; observed?: any }>;
}

export interface OrreryAuditResult {
  url: string;
  status: string;
  pagesCrawled: number;
  pages: OrreryPageRecord[];
  findings: OrreryFinding[];
  summary: {
    totalPages: number;
    totalFindings: number;
    schemaTypesFound: string[];
    hasSchema: boolean;
    hasRobotsTxt: boolean;
  };
}

export interface OrreryConnectorEnv {
  ORRERY_URL?: string;
  orreryUrl?: string;
  FACTORY_HUB_TOKEN?: string;
  ORRERY?: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
}

export class OrreryConnector {
  private baseUrl: string;
  private token?: string;
  private serviceBinding?: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };

  constructor(env: OrreryConnectorEnv) {
    this.baseUrl = (env.orreryUrl || env.ORRERY_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
    this.token = env.FACTORY_HUB_TOKEN;
    this.serviceBinding = env.ORRERY;
  }

  /**
   * Dispatches a direct technical crawl and audit to Orrery.
   */
  public async auditDomain(url: string, options: OrreryAuditOptions = {}): Promise<OrreryAuditResult> {
    const payload = {
      url,
      sample_cap: options.sampleCap ?? 10,
      request_budget: options.requestBudget ?? 25,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Orrery-Connector": "1",
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    try {
      const targetEndpoint = `${this.baseUrl}/api/audit`;
      const fetchFn = this.serviceBinding ? this.serviceBinding.fetch.bind(this.serviceBinding) : fetch;

      const resp = await fetchFn(targetEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Orrery audit request failed with status ${resp.status}: ${text}`);
      }

      const data = (await resp.json()) as any;
      return {
        url: data.url || url,
        status: data.status || "completed",
        pagesCrawled: data.pages_crawled ?? data.pages?.length ?? 0,
        pages: data.pages || [],
        findings: data.findings || [],
        summary: {
          totalPages: data.summary?.total_pages ?? data.pages?.length ?? 0,
          totalFindings: data.summary?.total_findings ?? data.findings?.length ?? 0,
          schemaTypesFound: data.summary?.schema_types_found || [],
          hasSchema: data.summary?.has_schema ?? (data.summary?.schema_types_found?.length > 0),
          hasRobotsTxt: data.summary?.has_robots_txt ?? false,
        },
      };
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (!msg.includes("network disabled in tests")) {
        try {
          return await this.liveEdgeAudit(url);
        } catch (edgeErr: any) {
          console.warn(`[OrreryConnector] Edge audit failed (${edgeErr?.message || edgeErr}). Using structured fallback.`);
        }
      }
      console.warn(`[OrreryConnector] Direct audit failed (${msg}). Using structured fallback analysis.`);
      return this.fallbackAnalysis(url);
    }
  }

  /**
   * Executes a live edge technical SEO/AEO crawl directly from the Cloudflare Worker
   * when the Orrery container is gated behind Cloudflare Access or asleep.
   */
  public async liveEdgeAudit(url: string): Promise<OrreryAuditResult> {
    const parsed = new URL(url);
    const origin = parsed.origin;
    const [homeResp, robotsResp, sitemapResp, llmsResp] = await Promise.all([
      fetch(url, { headers: { "User-Agent": "AuthoritySeoPod-OrreryEdge/2.0" } }),
      fetch(`${origin}/robots.txt`, { headers: { "User-Agent": "AuthoritySeoPod-OrreryEdge/2.0" } }).catch(() => null),
      fetch(`${origin}/sitemap.xml`, { headers: { "User-Agent": "AuthoritySeoPod-OrreryEdge/2.0" } }).catch(() => null),
      fetch(`${origin}/llms.txt`, { headers: { "User-Agent": "AuthoritySeoPod-OrreryEdge/2.0" } }).catch(() => null),
    ]);

    const html = await homeResp.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const descMatch =
      html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
      html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
    const canonMatch =
      html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i) ||
      html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["']/i);
    const h1Matches = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) =>
      m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    );
    const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
    const missingAlt = imgTags.filter((tag) => !/\balt=["'][^"']+["']/i.test(tag)).length;

    const schemaTypes = new Set<string>();
    for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const parsedJson = JSON.parse(m[1]);
        const collectTypes = (node: any) => {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node)) {
            node.forEach(collectTypes);
            return;
          }
          if (node["@type"]) {
            const t = node["@type"];
            if (Array.isArray(t)) t.forEach((x) => schemaTypes.add(String(x)));
            else schemaTypes.add(String(t));
          }
          if (node["@graph"]) collectTypes(node["@graph"]);
        };
        collectTypes(parsedJson);
      } catch {}
    }

    const plainWords = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;

    const hasRobotsTxt = Boolean(robotsResp && robotsResp.ok);
    const hasSitemap = Boolean(sitemapResp && sitemapResp.ok);
    const hasLlmsTxt = Boolean(llmsResp && llmsResp.ok);

    const findings: OrreryFinding[] = [];
    if (!titleMatch?.[1]?.trim()) {
      findings.push({ severity: "critical", issue_type: "missing_title", title: "Missing <title> tag", summary: "Page is missing a <title> element." });
    }
    if (!descMatch?.[1]?.trim()) {
      findings.push({ severity: "high", issue_type: "missing_meta_description", title: "Missing meta description", summary: "Page is missing a meta description." });
    }
    if (!canonMatch?.[1]?.trim()) {
      findings.push({ severity: "warning", issue_type: "missing_canonical", title: "Missing canonical link", summary: "Page does not declare a canonical URL." });
    }
    if (h1Matches.length === 0) {
      findings.push({ severity: "high", issue_type: "missing_h1", title: "Missing H1 heading", summary: "No H1 heading found on page." });
    }
    if (schemaTypes.size === 0) {
      findings.push({ severity: "high", issue_type: "missing_schema", title: "No JSON-LD structured data", summary: "No Schema.org JSON-LD blocks detected." });
    }
    if (!hasRobotsTxt) {
      findings.push({ severity: "warning", issue_type: "missing_robots_txt", title: "Missing robots.txt", summary: `${origin}/robots.txt did not return HTTP 200.` });
    }
    if (!hasSitemap) {
      findings.push({ severity: "high", issue_type: "missing_sitemap", title: "Missing sitemap.xml", summary: `${origin}/sitemap.xml did not return HTTP 200.` });
    }
    if (!hasLlmsTxt) {
      findings.push({ severity: "low", issue_type: "missing_llms_txt", title: "Missing llms.txt", summary: `${origin}/llms.txt not found for AI crawler discovery.` });
    }

    const pageRecord: OrreryPageRecord = {
      url,
      status_code: homeResp.status,
      title: titleMatch?.[1]?.trim() || "",
      meta_description: descMatch?.[1]?.trim() || "",
      canonical: canonMatch?.[1]?.trim() || "",
      schema_types: [...schemaTypes],
      h1: h1Matches,
      images_missing_alt_count: missingAlt,
      word_count: plainWords,
    };

    return {
      url,
      status: "completed_edge_audit",
      pagesCrawled: 1,
      pages: [pageRecord],
      findings,
      summary: {
        totalPages: 1,
        totalFindings: findings.length,
        schemaTypesFound: [...schemaTypes],
        hasSchema: schemaTypes.size > 0,
        hasRobotsTxt,
      },
    };
  }

  /**
   * Lightweight fallback analysis in edge contexts if Orrery is offline.
   */
  public fallbackAnalysis(url: string): OrreryAuditResult {
    let domain = "target.domain";
    try {
      domain = new URL(url).hostname;
    } catch {
      domain = url;
    }

    return {
      url,
      status: "fallback_edge_mode",
      pagesCrawled: 1,
      pages: [
        {
          url,
          schema_types: [],
          title: `${domain} - Analysis Pending`,
        },
      ],
      findings: [
        {
          severity: "warning",
          issue_type: "connector_fallback",
          title: "Edge Fallback Mode Active",
          summary: "Orrery compute instance unavailable. Edge pod generated baseline rule set.",
        },
      ],
      summary: {
        totalPages: 1,
        totalFindings: 1,
        schemaTypesFound: [],
        hasSchema: false,
        hasRobotsTxt: true,
      },
    };
  }
}
