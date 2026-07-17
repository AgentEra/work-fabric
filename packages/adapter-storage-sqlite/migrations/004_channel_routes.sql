CREATE TABLE IF NOT EXISTS work_fabric_channel_routes (
  tenant_id TEXT NOT NULL,
  plugin_instance_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (tenant_id, plugin_instance_id, handoff_id)
);

CREATE INDEX IF NOT EXISTS work_fabric_channel_routes_page_idx
  ON work_fabric_channel_routes (tenant_id, plugin_instance_id, handoff_id);
