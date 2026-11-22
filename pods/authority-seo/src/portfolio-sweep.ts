import { PodStorage } from "@futr-work/pod-kernel/storage";
import { OrreryConnector, OrreryConnectorEnv } from "./orrery-connector.js";

/**
 * Canonical active portfolio domains for scheduled SEO/AEO sweeps.
 * Excludes lost/dropped domains and cold-email redirect aliases.
 */
export const PORTFOLIO_SWEEP_DOMAINS: string[] = [
  "https://birthverse.com",
  "https://caryemergencytreeremoval.com",
  "https://brazenkitchen.com",
  "https://medsafewaste.com",
  "https://shredmotoco.com",
  "https://solarpowersurvey.com",
  "https://5bestsupplements.com",
  "https://applyforsavings.com",
  "https://nailfungusalert.com",
  "https://aaa-credit.com",
  "https://quoteotter.com",
  "https://callfinix.com",
  "https://mediwells.com",
  "https://callexchange.io",
  "https://pearlfinancing.com",
  "https://fractionpath.com",
  "https://futr.work",
  "https://rxrev.com",
  "https://golfinggurus.com",
  "https://astrologytraining.com",
  "https://stock-market-lessons.com",
  "https://supplementheadquarters.com",
  "https://usefulspaces.net",
  "https://firehawkcoffee.com",
  "https://flexformlabs.com",
  "https://patriotwarrior.org",
  "https://realestateinthesanjuans.com",
  "https://hayekgold.co",
];

export interface SweepDomainSummary {
  url: string;
  status: string;
  pagesCrawled: number;
  totalFindings: number;
  hasSchema: boolean;
  hasRobotsTxt: boolean;
  schemaTypesFound: string[];
  auditedAt: number;
  error?: string;
}

export interface PortfolioSweepState {
  cursor: number;
  lastRunAt: number;
  totalPortfolio: number;
  domains: Record<string, SweepDomainSummary>;
}

export interface PortfolioSweepResult {
  sweptCount: number;
  cursor: number;
  nextCursor: number;
  totalPortfolio: number;
  results: SweepDomainSummary[];
}

export async function getPortfolioSweepState(db: PodStorage): Promise<PortfolioSweepState> {
  try {
    const row = await db
      .prepare("SELECT value_json FROM pod_info WHERE key = 'portfolio_sweep_latest'")
      .first<any>();
    if (row?.value_json) {
      return JSON.parse(row.value_json) as PortfolioSweepState;
    }
  } catch {}
  return {
    cursor: 0,
    lastRunAt: 0,
    totalPortfolio: PORTFOLIO_SWEEP_DOMAINS.length,
    domains: {},
  };
}

export async function runPortfolioSweep(
  env: OrreryConnectorEnv,
  db: PodStorage,
  options: { batchSize?: number; domains?: string[]; cursor?: number } = {}
): Promise<PortfolioSweepResult> {
  const state = await getPortfolioSweepState(db);
  const totalPortfolio = PORTFOLIO_SWEEP_DOMAINS.length;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 6, 12));
  const startCursor =
    typeof options.cursor === "number" && options.cursor >= 0
      ? options.cursor % totalPortfolio
      : state.cursor % totalPortfolio;

  let targets: string[];
  let nextCursor = startCursor;
  if (Array.isArray(options.domains) && options.domains.length > 0) {
    targets = options.domains.slice(0, 12);
  } else {
    targets = [];
    for (let i = 0; i < Math.min(batchSize, totalPortfolio); i++) {
      targets.push(PORTFOLIO_SWEEP_DOMAINS[(startCursor + i) % totalPortfolio]);
    }
    nextCursor = (startCursor + targets.length) % totalPortfolio;
  }

  const connector = new OrreryConnector(env);
  const results: SweepDomainSummary[] = [];

  for (const targetUrl of targets) {
    const auditedAt = Date.now();
    try {
      const audit = await connector.auditDomain(targetUrl, { sampleCap: 3, requestBudget: 6 });
      const summary: SweepDomainSummary = {
        url: targetUrl,
        status: audit.status,
        pagesCrawled: audit.pagesCrawled,
        totalFindings: audit.summary.totalFindings,
        hasSchema: audit.summary.hasSchema,
        hasRobotsTxt: audit.summary.hasRobotsTxt,
        schemaTypesFound: audit.summary.schemaTypesFound,
        auditedAt,
      };
      results.push(summary);
      state.domains[targetUrl] = summary;
    } catch (err: any) {
      const summary: SweepDomainSummary = {
        url: targetUrl,
        status: "error",
        pagesCrawled: 0,
        totalFindings: 0,
        hasSchema: false,
        hasRobotsTxt: false,
        schemaTypesFound: [],
        auditedAt,
        error: err?.message || String(err),
      };
      results.push(summary);
      state.domains[targetUrl] = summary;
    }
  }

  const now = Date.now();
  const updatedState: PortfolioSweepState = {
    cursor: nextCursor,
    lastRunAt: now,
    totalPortfolio,
    domains: state.domains,
  };

  try {
    await db
      .prepare(`
        INSERT INTO pod_info (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `)
      .bind("portfolio_sweep_latest", JSON.stringify(updatedState), now)
      .run();
  } catch (err) {
    console.warn("[portfolio-sweep] Failed to persist sweep state:", err);
  }

  return {
    sweptCount: results.length,
    cursor: startCursor,
    nextCursor,
    totalPortfolio,
    results,
  };
}
