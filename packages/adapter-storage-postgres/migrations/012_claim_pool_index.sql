CREATE INDEX IF NOT EXISTS work_fabric_endpoint_claim_pool_state_idx
  ON work_fabric_endpoint_inbox_facts
  (tenant_id, (payload->>'lifecycle_state'), handoff_id)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS work_fabric_endpoint_claim_pool_capabilities_idx
  ON work_fabric_endpoint_inbox_facts
  USING gin ((payload->'capability_ids'));

ALTER TABLE work_fabric_endpoint_inbox_facts
  ADD COLUMN IF NOT EXISTS claim_id text,
  ADD COLUMN IF NOT EXISTS claim_fencing_token bigint,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS work_fabric_endpoint_expired_claim_idx
  ON work_fabric_endpoint_inbox_facts
  (tenant_id, claim_expires_at, handoff_id)
  WHERE active = true AND claim_expires_at IS NOT NULL;
