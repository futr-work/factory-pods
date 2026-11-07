-- Daily model usage analysis: one stored report per UTC day (analysis of the previous complete day).
CREATE TABLE IF NOT EXISTS usage_reports (
  report_date TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  report_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
