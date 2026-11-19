-- Optional per-event observed usage fields for governor-owned upstream deadlines.
ALTER TABLE llm_usage_events ADD COLUMN recovery_metadata_json TEXT;
