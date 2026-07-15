-- Forward-compatible hardening for databases that applied the first 003 migration.
ALTER TABLE work_fabric_delivery_attempts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_delivery_attempts DISABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_outbox NO FORCE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_outbox DISABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_projection_failures
  DROP CONSTRAINT IF EXISTS work_fabric_projection_failures_pkey;
ALTER TABLE work_fabric_projection_failures
  ADD PRIMARY KEY (tenant_id, projector_id, partition_id, event_id, position);

ALTER TABLE work_fabric_delivery_attempts
  DROP CONSTRAINT IF EXISTS work_fabric_delivery_attempts_pkey;
DELETE FROM work_fabric_delivery_attempts newer
USING work_fabric_delivery_attempts older
WHERE newer.ctid > older.ctid
  AND newer.tenant_id = older.tenant_id
  AND newer.subscription_id = older.subscription_id
  AND newer.event_id = older.event_id
  AND newer.attempt = older.attempt;
ALTER TABLE work_fabric_delivery_attempts
  ADD PRIMARY KEY (tenant_id, subscription_id, event_id, attempt);

ALTER TABLE work_fabric_outbox ALTER COLUMN attempt SET DEFAULT 1;
UPDATE work_fabric_outbox SET attempt = 1 WHERE attempt = 0;

ALTER TABLE work_fabric_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_delivery_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_outbox FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS work_fabric_delivery_active (
  tenant_id text NOT NULL, subscription_id text NOT NULL, partition_id text NOT NULL,
  delivery_id text NOT NULL, PRIMARY KEY (tenant_id, subscription_id, partition_id),
  UNIQUE (tenant_id, delivery_id)
);
ALTER TABLE work_fabric_delivery_active ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_delivery_active FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_fabric_delivery_active_tenant_isolation ON work_fabric_delivery_active;
CREATE POLICY work_fabric_delivery_active_tenant_isolation ON work_fabric_delivery_active
  USING (tenant_id = work_fabric_current_tenant())
  WITH CHECK (tenant_id = work_fabric_current_tenant());
