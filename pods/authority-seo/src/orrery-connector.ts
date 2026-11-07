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
      console.warn(`[OrreryConnector] Direct audit failed (${err.message}). Using structured fallback analysis.`);
      return this.fallbackAnalysis(url);
    }
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
