CREATE TABLE IF NOT EXISTS work_fabric_handoff_read_models (
  tenant_id text NOT NULL,
  partition_id text NOT NULL,
  handoff_id text NOT NULL,
  stream_version bigint NOT NULL CHECK (stream_version > 0),
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, handoff_id)
);
CREATE INDEX IF NOT EXISTS work_fabric_handoff_read_models_partition_idx
  ON work_fabric_handoff_read_models (tenant_id, partition_id, handoff_id);

CREATE TABLE IF NOT EXISTS work_fabric_responsibility_views (
  tenant_id text NOT NULL,
  partition_id text NOT NULL,
  thread_id text NOT NULL,
  handoff_id text NOT NULL,
  stream_version bigint NOT NULL CHECK (stream_version > 0),
  responsible_actor_id text,
  lifecycle_state text NOT NULL,
  priority text NOT NULL,
  result_due_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, handoff_id)
);
CREATE INDEX IF NOT EXISTS work_fabric_responsibility_views_query_idx
  ON work_fabric_responsibility_views
  (tenant_id, partition_id, updated_at DESC, handoff_id ASC);
CREATE INDEX IF NOT EXISTS work_fabric_responsibility_views_actor_idx
  ON work_fabric_responsibility_views
  (tenant_id, partition_id, responsible_actor_id, updated_at DESC, handoff_id ASC);
CREATE INDEX IF NOT EXISTS work_fabric_responsibility_views_thread_idx
  ON work_fabric_responsibility_views
  (tenant_id, partition_id, thread_id, updated_at DESC, handoff_id ASC);

CREATE TABLE IF NOT EXISTS work_fabric_timeline_entries (
  tenant_id text NOT NULL,
  partition_id text NOT NULL,
  partition_position bigint NOT NULL CHECK (partition_position > 0),
  event_id text NOT NULL,
  handoff_id text NOT NULL,
  thread_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, partition_id, event_id),
  UNIQUE (tenant_id, partition_id, partition_position, event_id)
);
CREATE INDEX IF NOT EXISTS work_fabric_timeline_entries_query_idx
  ON work_fabric_timeline_entries
  (tenant_id, partition_id, partition_position ASC, event_id ASC);
CREATE INDEX IF NOT EXISTS work_fabric_timeline_entries_handoff_idx
  ON work_fabric_timeline_entries
  (tenant_id, partition_id, handoff_id, partition_position ASC, event_id ASC);
CREATE INDEX IF NOT EXISTS work_fabric_timeline_entries_thread_idx
  ON work_fabric_timeline_entries
  (tenant_id, partition_id, thread_id, partition_position ASC, event_id ASC);

CREATE TABLE IF NOT EXISTS work_fabric_relationship_versions (
  tenant_id text NOT NULL,
  partition_id text NOT NULL,
  handoff_id text NOT NULL,
  stream_version bigint NOT NULL CHECK (stream_version > 0),
  PRIMARY KEY (tenant_id, partition_id, handoff_id)
);
CREATE TABLE IF NOT EXISTS work_fabric_relationship_views (
  tenant_id text NOT NULL,
  partition_id text NOT NULL,
  thread_id text NOT NULL,
  handoff_id text NOT NULL,
  relationship_id text NOT NULL,
  relationship_kind text NOT NULL,
  stream_version bigint NOT NULL CHECK (stream_version > 0),
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, partition_id, relationship_id),
  FOREIGN KEY (tenant_id, partition_id, handoff_id)
    REFERENCES work_fabric_relationship_versions (tenant_id, partition_id, handoff_id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS work_fabric_relationship_views_query_idx
  ON work_fabric_relationship_views
  (tenant_id, partition_id, observed_at DESC, relationship_id ASC);
CREATE INDEX IF NOT EXISTS work_fabric_relationship_views_handoff_idx
  ON work_fabric_relationship_views
  (tenant_id, partition_id, handoff_id, observed_at DESC, relationship_id ASC);
CREATE INDEX IF NOT EXISTS work_fabric_relationship_views_thread_idx
  ON work_fabric_relationship_views
  (tenant_id, partition_id, thread_id, observed_at DESC, relationship_id ASC);

CREATE TABLE IF NOT EXISTS work_fabric_operation_audit (
  tenant_id text NOT NULL,
  audit_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  principal_id text NOT NULL,
  operation text NOT NULL,
  outcome text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, audit_id)
);
CREATE INDEX IF NOT EXISTS work_fabric_operation_audit_query_idx
  ON work_fabric_operation_audit
  (tenant_id, occurred_at DESC, audit_id ASC);
CREATE INDEX IF NOT EXISTS work_fabric_operation_audit_principal_idx
  ON work_fabric_operation_audit
  (tenant_id, principal_id, occurred_at DESC, audit_id ASC);
CREATE INDEX IF NOT EXISTS work_fabric_operation_audit_operation_idx
  ON work_fabric_operation_audit
  (tenant_id, operation, occurred_at DESC, audit_id ASC);

CREATE TABLE IF NOT EXISTS work_fabric_connector_discrepancies (
  tenant_id text NOT NULL,
  discrepancy_id text NOT NULL,
  connector_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'acknowledged')),
  version bigint NOT NULL CHECK (version > 0),
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, discrepancy_id)
);
CREATE INDEX IF NOT EXISTS work_fabric_connector_discrepancies_query_idx
  ON work_fabric_connector_discrepancies
  (tenant_id, observed_at DESC, discrepancy_id ASC);
CREATE INDEX IF NOT EXISTS work_fabric_connector_discrepancies_connector_idx
  ON work_fabric_connector_discrepancies
  (tenant_id, connector_id, status, observed_at DESC, discrepancy_id ASC);

CREATE TABLE IF NOT EXISTS work_fabric_recovery_requests (
  tenant_id text NOT NULL,
  recovery_id text NOT NULL,
  idempotency_key text NOT NULL,
  requested_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'processing', 'completed', 'failed')),
  version bigint NOT NULL CHECK (version > 0),
  attempt integer NOT NULL CHECK (attempt >= 0),
  claim_owner text,
  claim_token text,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_expires_at timestamptz,
  outcome_code text,
  completed_at timestamptz,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, recovery_id),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS work_fabric_recovery_requests_claim_idx
  ON work_fabric_recovery_requests
  (tenant_id, state, lease_expires_at, requested_at ASC, recovery_id ASC);

ALTER TABLE work_fabric_handoff_read_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_handoff_read_models FORCE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_responsibility_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_responsibility_views FORCE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_timeline_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_timeline_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_relationship_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_relationship_views FORCE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_relationship_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_relationship_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_operation_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_operation_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_connector_discrepancies ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_connector_discrepancies FORCE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_recovery_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_recovery_requests FORCE ROW LEVEL SECURITY;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'work_fabric_handoff_read_models',
    'work_fabric_responsibility_views',
    'work_fabric_timeline_entries',
    'work_fabric_relationship_views',
    'work_fabric_relationship_versions',
    'work_fabric_operation_audit',
    'work_fabric_connector_discrepancies',
    'work_fabric_recovery_requests'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_tenant_isolation', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = work_fabric_current_tenant()) WITH CHECK (tenant_id = work_fabric_current_tenant())',
      table_name || '_tenant_isolation',
      table_name
    );
  END LOOP;
END $$;
