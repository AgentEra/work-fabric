ALTER TABLE work_fabric_connector_ingress
  ALTER COLUMN occurred_at TYPE timestamptz USING occurred_at::timestamptz,
  ALTER COLUMN received_at TYPE timestamptz USING received_at::timestamptz,
  ALTER COLUMN available_at TYPE timestamptz USING available_at::timestamptz,
  ALTER COLUMN accepted_at TYPE timestamptz USING accepted_at::timestamptz,
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at::timestamptz,
  ALTER COLUMN completed_at TYPE timestamptz USING completed_at::timestamptz,
  ALTER COLUMN last_requeued_at TYPE timestamptz USING last_requeued_at::timestamptz,
  ALTER COLUMN lease_expires_at TYPE timestamptz USING lease_expires_at::timestamptz,
  ALTER COLUMN retention_expires_at TYPE timestamptz USING retention_expires_at::timestamptz;

DROP INDEX IF EXISTS work_fabric_connector_ingress_claim_idx;
CREATE INDEX work_fabric_connector_ingress_claim_idx
  ON work_fabric_connector_ingress (
    tenant_id, connector_id, state, available_at, received_at, ingress_id
  );

DROP INDEX IF EXISTS work_fabric_connector_ingress_lease_idx;
CREATE INDEX work_fabric_connector_ingress_lease_idx
  ON work_fabric_connector_ingress (
    tenant_id, connector_id, state, lease_expires_at
  )
  WHERE state = 'processing';

DROP INDEX IF EXISTS work_fabric_connector_ingress_retention_idx;
CREATE INDEX work_fabric_connector_ingress_retention_idx
  ON work_fabric_connector_ingress (
    tenant_id, connector_id, retention_expires_at, ingress_id
  )
  WHERE retention_expires_at IS NOT NULL;
