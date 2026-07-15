CREATE TABLE IF NOT EXISTS work_fabric_context_bundles (
  tenant_id text NOT NULL,
  context_id text NOT NULL,
  version bigint NOT NULL,
  digest text,
  expires_at text,
  bundle jsonb NOT NULL,
  actor_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  endpoint_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (tenant_id, context_id, version)
);
ALTER TABLE work_fabric_context_bundles ADD COLUMN IF NOT EXISTS expires_at text;

ALTER TABLE work_fabric_context_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_context_bundles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_fabric_context_bundles_tenant_isolation ON work_fabric_context_bundles;
CREATE POLICY work_fabric_context_bundles_tenant_isolation ON work_fabric_context_bundles
  USING (tenant_id = work_fabric_current_tenant())
  WITH CHECK (tenant_id = work_fabric_current_tenant());
