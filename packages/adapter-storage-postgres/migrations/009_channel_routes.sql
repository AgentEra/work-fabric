CREATE TABLE IF NOT EXISTS work_fabric_channel_routes (
  tenant_id text NOT NULL,
  plugin_instance_id text NOT NULL,
  handoff_id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, plugin_instance_id, handoff_id)
);
CREATE INDEX IF NOT EXISTS work_fabric_channel_routes_page_idx
  ON work_fabric_channel_routes (tenant_id, plugin_instance_id, handoff_id);
ALTER TABLE work_fabric_channel_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_channel_routes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_fabric_channel_routes_tenant ON work_fabric_channel_routes;
CREATE POLICY work_fabric_channel_routes_tenant ON work_fabric_channel_routes
  USING (tenant_id = current_setting('work_fabric.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('work_fabric.tenant_id', true));
