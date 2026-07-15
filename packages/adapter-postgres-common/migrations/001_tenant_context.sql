CREATE OR REPLACE FUNCTION work_fabric_current_tenant()
RETURNS text
LANGUAGE sql
STABLE
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '') $$;

CREATE TABLE IF NOT EXISTS work_fabric_tenant_probe (
  tenant_id text NOT NULL,
  probe_id text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, probe_id)
);

ALTER TABLE work_fabric_tenant_probe ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_fabric_tenant_probe_isolation ON work_fabric_tenant_probe;
CREATE POLICY work_fabric_tenant_probe_isolation ON work_fabric_tenant_probe
  USING (tenant_id = work_fabric_current_tenant())
  WITH CHECK (tenant_id = work_fabric_current_tenant());
