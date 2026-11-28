import type { AuditEventRecord, PodConfig, TaskRecord } from "./types.js";

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
    vaultBackendCount: number;
    principalCount: number;
    accountCount: number;
    connectionCount: number;
    assetCount: number;
    bindingCount: number;
    recentAudit: AuditEventRecord[];
  },
  tasks: TaskRecord[],
  lastHb: any
): string {
  const auditRows = snapshot.recentAudit
    .map(
      (ev) => `
      <tr>
        <td><code>#${escapeHtml(ev.eventSeq)}</code></td>
        <td><code>${escapeHtml(ev.tenantId)}</code></td>
        <td>${escapeHtml(ev.entityType)}</td>
        <td><code>${escapeHtml(ev.entityId)}</code></td>
        <td><span class="badge">${escapeHtml(ev.action)}</span></td>
        <td>${escapeHtml(ev.summary)}</td>
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
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card { background: #141923; border: 1px solid #262e3d; border-radius: 10px; padding: 16px; }
    .card .label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: .04em; }
    .card .value { font-size: 28px; font-weight: 700; margin-top: 6px; }
    table { width: 100%; border-collapse: collapse; background: #141923; border: 1px solid #262e3d; border-radius: 10px; overflow: hidden; margin-bottom: 24px; font-size: 13px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #222938; }
    th { color: #8b949e; font-weight: 500; }
    .badge { padding: 2px 8px; border-radius: 999px; font-size: 12px; background: #262e3d; }
    code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; color: #79c0ff; }
  </style>
</head>
<body>
  <h1>${escapeHtml(config.name)}</h1>
  <div class="meta">
    Pod: <code>${escapeHtml(config.id)}</code> · Role: <code>${escapeHtml(config.role)}</code> ·
    Vault-Agnostic Zero-Secret Registry · MCP: <code>2026-07-28 + Code Mode</code> ·
    Heartbeat: <code>${escapeHtml(lastHb?.status || "healthy")}</code>
  </div>

  <div class="grid">
    <div class="card"><div class="label">Vault Backends</div><div class="value">${snapshot.vaultBackendCount}</div></div>
    <div class="card"><div class="label">Principals</div><div class="value">${snapshot.principalCount}</div></div>
    <div class="card"><div class="label">Accounts</div><div class="value">${snapshot.accountCount}</div></div>
    <div class="card"><div class="label">Connections</div><div class="value">${snapshot.connectionCount}</div></div>
    <div class="card"><div class="label">Assets</div><div class="value">${snapshot.assetCount}</div></div>
    <div class="card"><div class="label">Bindings</div><div class="value">${snapshot.bindingCount}</div></div>
    <div class="card"><div class="label">Mesh Tasks</div><div class="value">${tasks.length}</div></div>
  </div>

  <h2>Recent Audit Events (Zero-Secret Control Plane)</h2>
  <table>
    <thead><tr><th>Seq</th><th>Tenant</th><th>Entity</th><th>ID</th><th>Action</th><th>Summary</th></tr></thead>
    <tbody>${auditRows || '<tr><td colspan="6">No audit events recorded yet.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
}
