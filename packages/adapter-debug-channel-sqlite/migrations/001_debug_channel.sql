CREATE TABLE IF NOT EXISTS work_fabric_debug_submissions (
  tenant_id TEXT NOT NULL,
  plugin_instance_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (tenant_id, plugin_instance_id, submission_id),
  UNIQUE (tenant_id, plugin_instance_id, conversation_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS work_fabric_debug_submissions_expiry_idx
  ON work_fabric_debug_submissions
  (tenant_id, plugin_instance_id, expires_at, submission_id);

CREATE TABLE IF NOT EXISTS work_fabric_debug_captures (
  tenant_id TEXT NOT NULL,
  plugin_instance_id TEXT NOT NULL,
  capture_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (tenant_id, plugin_instance_id, capture_id),
  UNIQUE (tenant_id, plugin_instance_id, event_id, destination_id)
);

CREATE INDEX IF NOT EXISTS work_fabric_debug_captures_page_idx
  ON work_fabric_debug_captures
  (tenant_id, plugin_instance_id, conversation_id, captured_at, capture_id);

CREATE INDEX IF NOT EXISTS work_fabric_debug_captures_expiry_idx
  ON work_fabric_debug_captures
  (tenant_id, plugin_instance_id, expires_at, capture_id);
