CREATE TABLE IF NOT EXISTS work_fabric_events (
  tenant_id text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  schema_version text NOT NULL,
  exchange_id text NOT NULL,
  request_message_id text NOT NULL,
  idempotency_key text NOT NULL,
  correlation_id text,
  causation_id text,
  thread_id text NOT NULL,
  handoff_id text NOT NULL,
  actor_id text NOT NULL,
  endpoint_id text NOT NULL,
  visibility text NOT NULL,
  visible_actor_ids jsonb NOT NULL,
  visible_endpoint_ids jsonb NOT NULL,
  occurred_at text NOT NULL,
  domain_data jsonb NOT NULL,
  protocol_data jsonb NOT NULL,
  partition_id text NOT NULL,
  partition_position bigint NOT NULL,
  stream_id text NOT NULL,
  stream_version bigint NOT NULL,
  commit_id text NOT NULL,
  commit_ordinal bigint NOT NULL,
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, stream_id, stream_version),
  UNIQUE (tenant_id, partition_id, partition_position)
);

CREATE TABLE IF NOT EXISTS work_fabric_commands (
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL,
  payload_digest text NOT NULL,
  first_request_message_id text NOT NULL,
  outcome jsonb NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS work_fabric_snapshots (
  tenant_id text NOT NULL,
  stream_id text NOT NULL,
  stream_version bigint NOT NULL,
  schema_version text NOT NULL,
  state jsonb NOT NULL,
  PRIMARY KEY (tenant_id, stream_id)
);

CREATE TABLE IF NOT EXISTS work_fabric_outbox (
  tenant_id text NOT NULL,
  outbox_id text NOT NULL,
  partition_id text NOT NULL,
  position bigint NOT NULL,
  event jsonb NOT NULL,
  attempt bigint NOT NULL DEFAULT 1,
  next_attempt_at text,
  lease_owner text,
  lease_expires_at text,
  fencing_token bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, outbox_id),
  UNIQUE (tenant_id, partition_id, position)
);

ALTER TABLE work_fabric_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_fabric_events_tenant_isolation ON work_fabric_events;
CREATE POLICY work_fabric_events_tenant_isolation ON work_fabric_events
  USING (tenant_id = work_fabric_current_tenant())
  WITH CHECK (tenant_id = work_fabric_current_tenant());

ALTER TABLE work_fabric_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_commands FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_fabric_commands_tenant_isolation ON work_fabric_commands;
CREATE POLICY work_fabric_commands_tenant_isolation ON work_fabric_commands
  USING (tenant_id = work_fabric_current_tenant())
  WITH CHECK (tenant_id = work_fabric_current_tenant());

ALTER TABLE work_fabric_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_fabric_snapshots_tenant_isolation ON work_fabric_snapshots;
CREATE POLICY work_fabric_snapshots_tenant_isolation ON work_fabric_snapshots
  USING (tenant_id = work_fabric_current_tenant())
  WITH CHECK (tenant_id = work_fabric_current_tenant());

ALTER TABLE work_fabric_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_fabric_outbox_tenant_isolation ON work_fabric_outbox;
CREATE POLICY work_fabric_outbox_tenant_isolation ON work_fabric_outbox
  USING (tenant_id = work_fabric_current_tenant())
  WITH CHECK (tenant_id = work_fabric_current_tenant());

ALTER TABLE work_fabric_outbox ALTER COLUMN attempt SET DEFAULT 1;
