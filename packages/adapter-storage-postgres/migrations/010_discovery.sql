CREATE TABLE IF NOT EXISTS work_fabric_discovery_records (
  tenant_id text NOT NULL,
  tenant_view_id text NOT NULL,
  origin_exchange_id text NOT NULL,
  record_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  is_tombstone boolean NOT NULL,
  expires_at timestamptz,
  retain_until timestamptz,
  source_peer_id text,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, tenant_view_id, origin_exchange_id, record_id),
  CHECK ((is_tombstone AND retain_until IS NOT NULL AND expires_at IS NULL) OR
         (NOT is_tombstone AND expires_at IS NOT NULL AND retain_until IS NULL))
);

CREATE TABLE IF NOT EXISTS work_fabric_discovery_changes (
  change_sequence bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  tenant_view_id text NOT NULL,
  origin_exchange_id text NOT NULL,
  record_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS work_fabric_discovery_peers (
  tenant_id text NOT NULL,
  tenant_view_id text NOT NULL,
  peer_id text NOT NULL,
  exchange_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, tenant_view_id, peer_id),
  UNIQUE (tenant_id, tenant_view_id, exchange_id)
);

CREATE INDEX IF NOT EXISTS work_fabric_discovery_records_query_idx
  ON work_fabric_discovery_records (tenant_id, tenant_view_id, is_tombstone, expires_at, origin_exchange_id, record_id);
CREATE INDEX IF NOT EXISTS work_fabric_discovery_records_tombstone_idx
  ON work_fabric_discovery_records (tenant_id, tenant_view_id, retain_until)
  WHERE is_tombstone;
CREATE INDEX IF NOT EXISTS work_fabric_discovery_changes_cursor_idx
  ON work_fabric_discovery_changes (tenant_id, tenant_view_id, change_sequence);
CREATE INDEX IF NOT EXISTS work_fabric_discovery_peers_list_idx
  ON work_fabric_discovery_peers (tenant_id, tenant_view_id, peer_id);

ALTER TABLE work_fabric_discovery_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_discovery_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_fabric_discovery_records_tenant ON work_fabric_discovery_records;
CREATE POLICY work_fabric_discovery_records_tenant ON work_fabric_discovery_records
  USING (tenant_id = work_fabric_current_tenant())
  WITH CHECK (tenant_id = work_fabric_current_tenant());

ALTER TABLE work_fabric_discovery_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_discovery_changes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_fabric_discovery_changes_tenant ON work_fabric_discovery_changes;
CREATE POLICY work_fabric_discovery_changes_tenant ON work_fabric_discovery_changes
  USING (tenant_id = work_fabric_current_tenant())
  WITH CHECK (tenant_id = work_fabric_current_tenant());

ALTER TABLE work_fabric_discovery_peers ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_discovery_peers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_fabric_discovery_peers_tenant ON work_fabric_discovery_peers;
CREATE POLICY work_fabric_discovery_peers_tenant ON work_fabric_discovery_peers
  USING (tenant_id = work_fabric_current_tenant())
  WITH CHECK (tenant_id = work_fabric_current_tenant());
