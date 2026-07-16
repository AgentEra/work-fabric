ALTER TABLE work_fabric_dead_letters ADD COLUMN recorded_at TEXT;

UPDATE work_fabric_dead_letters
SET recorded_at = json_extract(payload, '$.recorded_at')
WHERE recorded_at IS NULL;

CREATE INDEX IF NOT EXISTS work_fabric_projection_failures_scan
  ON work_fabric_projection_failures
    (tenant_id, projector_id, partition_id, position, event_id);

CREATE INDEX IF NOT EXISTS work_fabric_dead_letters_scan
  ON work_fabric_dead_letters
    (tenant_id, subscription_id, recorded_at DESC, event_id);
