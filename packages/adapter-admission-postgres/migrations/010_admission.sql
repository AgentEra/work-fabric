CREATE TABLE IF NOT EXISTS work_fabric_admission_bindings (
  tenant_id text NOT NULL,
  connector_id text NOT NULL,
  source_system text NOT NULL,
  external_tenant_id text NOT NULL,
  external_subject_type text NOT NULL CHECK (external_subject_type IN ('human', 'agent', 'system')),
  external_subject_fingerprint text NOT NULL,
  actor_id text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
  endpoint_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, connector_id, source_system, external_tenant_id, external_subject_type, external_subject_fingerprint),
  UNIQUE (tenant_id, actor_id),
  UNIQUE (tenant_id, endpoint_id)
);

ALTER TABLE work_fabric_admission_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_admission_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_fabric_admission_bindings_tenant ON work_fabric_admission_bindings;
CREATE POLICY work_fabric_admission_bindings_tenant ON work_fabric_admission_bindings
  USING (tenant_id = work_fabric_current_tenant())
  WITH CHECK (tenant_id = work_fabric_current_tenant());

CREATE TABLE IF NOT EXISTS work_fabric_admission_decisions (
  tenant_id text NOT NULL,
  connector_id text NOT NULL,
  source_system text NOT NULL,
  external_tenant_id text NOT NULL,
  ingress_id text NOT NULL,
  decision_kind text NOT NULL CHECK (decision_kind IN ('allow', 'deny')),
  reason_code text NOT NULL,
  policy_id text NOT NULL,
  policy_revision text NOT NULL,
  decision_id text NOT NULL,
  external_subject_fingerprint text NOT NULL,
  binding_external_subject_type text,
  binding_external_subject_fingerprint text,
  binding_actor_id text,
  binding_actor_type text,
  binding_endpoint_id text,
  binding_created_at timestamptz,
  evidence_present boolean NOT NULL,
  evidence_membership text CHECK (evidence_membership IS NULL OR evidence_membership IN ('internal', 'external', 'unknown')),
  evidence_active boolean,
  evidence_observed_at timestamptz,
  evidence_provider_revision text CHECK (evidence_provider_revision IS NULL OR length(evidence_provider_revision) <= 255),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, connector_id, source_system, external_tenant_id, ingress_id),
  CHECK (
    (decision_kind = 'allow'
      AND binding_external_subject_type IS NOT NULL
      AND binding_external_subject_fingerprint IS NOT NULL
      AND binding_actor_id IS NOT NULL
      AND binding_actor_type IS NOT NULL
      AND binding_endpoint_id IS NOT NULL
      AND binding_created_at IS NOT NULL)
    OR
    (decision_kind = 'deny'
      AND binding_external_subject_type IS NULL
      AND binding_external_subject_fingerprint IS NULL
      AND binding_actor_id IS NULL
      AND binding_actor_type IS NULL
      AND binding_endpoint_id IS NULL
      AND binding_created_at IS NULL)
  ),
  CHECK (
    (evidence_present
      AND evidence_membership IS NOT NULL
      AND evidence_observed_at IS NOT NULL
      AND evidence_provider_revision IS NOT NULL)
    OR
    (NOT evidence_present
      AND evidence_membership IS NULL
      AND evidence_active IS NULL
      AND evidence_observed_at IS NULL
      AND evidence_provider_revision IS NULL)
  )
);

ALTER TABLE work_fabric_admission_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_admission_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_fabric_admission_decisions_tenant ON work_fabric_admission_decisions;
CREATE POLICY work_fabric_admission_decisions_tenant ON work_fabric_admission_decisions
  USING (tenant_id = work_fabric_current_tenant())
  WITH CHECK (tenant_id = work_fabric_current_tenant());
