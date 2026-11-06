CREATE TABLE processed_files (
  key TEXT PRIMARY KEY,
  etag TEXT,
  size INTEGER,
  processed_at TEXT NOT NULL,
  records_seen INTEGER NOT NULL DEFAULT 0,
  records_inserted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processed',
  error TEXT
);

CREATE TABLE workflow_runs (
  run_id TEXT PRIMARY KEY,
  period TEXT,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  current_prefix TEXT,
  current_cursor TEXT,
  files_seen INTEGER NOT NULL DEFAULT 0,
  files_processed INTEGER NOT NULL DEFAULT 0,
  records_inserted INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE access_events (
  ray_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  period TEXT NOT NULL,
  user_uid TEXT NOT NULL,
  email TEXT,
  app_uuid TEXT NOT NULL,
  app_domain TEXT
);

CREATE INDEX idx_access_events_period_user ON access_events(period, user_uid);
CREATE INDEX idx_access_events_period_app ON access_events(period, app_uuid);

CREATE TABLE users (
  user_uid TEXT PRIMARY KEY,
  email TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE usage (
  period TEXT NOT NULL,
  user_uid TEXT NOT NULL,
  app_uuid TEXT NOT NULL,
  app_domain TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  login_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (period, user_uid, app_uuid)
);

CREATE TABLE app_owner_snapshot (
  period TEXT NOT NULL,
  app_uuid TEXT NOT NULL,
  app_domain TEXT,
  owner_team TEXT,
  cost_center TEXT,
  source TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (period, app_uuid)
);

CREATE TABLE app_owner_override (
  app_uuid TEXT PRIMARY KEY,
  owner_team TEXT NOT NULL,
  cost_center TEXT,
  reason TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE report_exports (
  report_id TEXT PRIMARY KEY,
  period TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  timezone TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  data_as_of TEXT NOT NULL,
  coverage_status TEXT NOT NULL,
  method_version TEXT NOT NULL,
  session_assumption TEXT NOT NULL,
  disclaimer_text TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  ownership_snapshot_ref TEXT,
  created_by TEXT,
  scope TEXT NOT NULL DEFAULT 'finance_review'
);

CREATE TABLE report_export_files (
  report_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  storage_key TEXT,
  checksum TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (report_id, artifact_type),
  FOREIGN KEY (report_id) REFERENCES report_exports(report_id)
);

CREATE TABLE run_state (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
