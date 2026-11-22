import type { PodConfig, TaskRecord } from "./types.js";

function escapeHtml(val: unknown): string {
  return String(val ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderPodUiHtml(
  config: PodConfig,
  snapshot: {
    resourceCount: number;
    definitionCount: number;
    observationCount: number;
    recentCoverage: any[];
    recentAnnotations: any[];
  },
  tasks: TaskRecord[],
  lastHb: any
): string {
  const coverageRows = snapshot.recentCoverage
    .map(
      (c) => `
      <tr>
        <td><code>${escapeHtml(c.resource_id)}</code></td>
        <td>${escapeHtml(c.source)}</td>
        <td>${escapeHtml(c.window_start)} → ${escapeHtml(c.window_end)}</td>
        <td><span class="badge status-${escapeHtml(c.status)}">${escapeHtml(c.status)}</span></td>
        <td>${escapeHtml(c.reconciliation_status)}</td>
        <td>${escapeHtml(c.freshness_at || "—")}</td>
      </tr>`
    )
    .join("");

  const annotationRows = snapshot.recentAnnotations
    .map(
      (a) => `
      <tr>
        <td><code>${escapeHtml(a.entity_urn)}</code></td>
        <td>${escapeHtml(a.pod_id)}</td>
        <td>${escapeHtml(a.kind)}</td>
        <td>${escapeHtml(a.summary)}</td>
        <td>${escapeHtml(a.occurred_at)}</td>
      </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(config.name)} — Factory Pod Cockpit</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: #0b0e14; color: #e6edf3; padding: 24px; }
    h1, h2 { margin: 0 0 12px; font-weight: 600; }
    .meta { color: #8b949e; font-size: 13px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card { background: #141923; border: 1px solid #262e3d; border-radius: 10px; padding: 16px; }
    .card .label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: .04em; }
    .card .value { font-size: 28px; font-weight: 700; margin-top: 6px; }
    table { width: 100%; border-collapse: collapse; background: #141923; border: 1px solid #262e3d; border-radius: 10px; overflow: hidden; margin-bottom: 24px; font-size: 13px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #222938; }
    th { color: #8b949e; font-weight: 500; }
    .badge { padding: 2px 8px; border-radius: 999px; font-size: 12px; background: #262e3d; }
    .status-successful { background: #133b2a; color: #56d364; }
    .status-partial, .status-stale { background: #3b2e13; color: #e3b341; }
    .status-failed, .status-blocked { background: #3b171b; color: #f85149; }
    code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; color: #79c0ff; }
  </style>
</head>
<body>
  <h1>${escapeHtml(config.name)}</h1>
  <div class="meta">
    Pod: <code>${escapeHtml(config.id)}</code> · Role: <code>${escapeHtml(config.role)}</code> ·
    MCP: <code>2026-07-28 + Code Mode</code> ·
    Heartbeat: <code>${escapeHtml(lastHb?.status || "healthy")}</code>
  </div>

  <div class="grid">
    <div class="card"><div class="label">Resources</div><div class="value">${snapshot.resourceCount}</div></div>
    <div class="card"><div class="label">Definitions</div><div class="value">${snapshot.definitionCount}</div></div>
    <div class="card"><div class="label">Observations</div><div class="value">${snapshot.observationCount}</div></div>
    <div class="card"><div class="label">Mesh Tasks</div><div class="value">${tasks.length}</div></div>
  </div>

  <h2>Coverage &amp; Reconciliation Matrix</h2>
  <table>
    <thead><tr><th>Resource</th><th>Source</th><th>Window</th><th>Status</th><th>Reconciliation</th><th>Freshness</th></tr></thead>
    <tbody>${coverageRows || '<tr><td colspan="6">No coverage records yet.</td></tr>'}</tbody>
  </table>

  <h2>Recent Non-Causal Work Annotations</h2>
  <table>
    <thead><tr><th>Entity URN</th><th>Pod</th><th>Kind</th><th>Summary</th><th>Occurred At</th></tr></thead>
    <tbody>${annotationRows || '<tr><td colspan="5">No annotations recorded yet.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
}
