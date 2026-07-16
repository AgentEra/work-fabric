CREATE TABLE IF NOT EXISTS work_fabric_connector_ingress (
  tenant_id text NOT NULL,
  connector_id text NOT NULL,
  ingress_id text NOT NULL,
  source_system text NOT NULL,
  external_event_id text NOT NULL,
  dedupe_key text NOT NULL,
  event_type text NOT NULL,
  partition_key text,
  occurred_at text NOT NULL,
  received_at text NOT NULL,
  envelope jsonb NOT NULL,
  state text NOT NULL CHECK (
    state IN ('pending', 'processing', 'retry_wait', 'completed', 'dead_letter')
  ),
  attempt bigint NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  available_at text NOT NULL,
  accepted_at text NOT NULL,
  updated_at text NOT NULL,
  completed_at text,
  last_error_code text,
  last_error_detail text,
  last_requeue_reason text,
  last_requeued_at text,
  claim_owner text,
  claim_token text,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_expires_at text,
  retention_expires_at text,
  PRIMARY KEY (tenant_id, connector_id, ingress_id),
  UNIQUE (tenant_id, connector_id, source_system, dedupe_key),
  CHECK (
    (state = 'processing' AND claim_owner IS NOT NULL AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (state <> 'processing' AND claim_owner IS NULL AND claim_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS work_fabric_connector_ingress_claim_idx
  ON work_fabric_connector_ingress (
    tenant_id,
    connector_id,
    state,
    available_at,
    received_at,
    ingress_id
  );

CREATE INDEX IF NOT EXISTS work_fabric_connector_ingress_lease_idx
  ON work_fabric_connector_ingress (
    tenant_id,
    connector_id,
    state,
    lease_expires_at
  )
  WHERE state = 'processing';

CREATE INDEX IF NOT EXISTS work_fabric_connector_ingress_retention_idx
  ON work_fabric_connector_ingress (tenant_id, retention_expires_at)
  WHERE retention_expires_at IS NOT NULL;

ALTER TABLE work_fabric_connector_ingress ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_connector_ingress FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_fabric_connector_ingress_tenant_isolation
  ON work_fabric_connector_ingress;
CREATE POLICY work_fabric_connector_ingress_tenant_isolation
  ON work_fabric_connector_ingress
  USING (tenant_id = work_fabric_current_tenant())
  WITH CHECK (tenant_id = work_fabric_current_tenant());
