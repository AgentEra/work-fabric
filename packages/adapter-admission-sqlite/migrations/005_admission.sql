CREATE TABLE IF NOT EXISTS work_fabric_admission_bindings (
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  external_tenant_id TEXT NOT NULL,
  external_subject_type TEXT NOT NULL CHECK (external_subject_type IN ('human', 'agent', 'system')),
  external_subject_fingerprint TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
  endpoint_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, connector_id, source_system, external_tenant_id, external_subject_type, external_subject_fingerprint),
  UNIQUE (tenant_id, actor_id),
  UNIQUE (tenant_id, endpoint_id)
);

CREATE TABLE IF NOT EXISTS work_fabric_admission_decisions (
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  external_tenant_id TEXT NOT NULL,
  ingress_id TEXT NOT NULL,
  decision_kind TEXT NOT NULL CHECK (decision_kind IN ('allow', 'deny')),
  reason_code TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  external_subject_fingerprint TEXT NOT NULL,
  binding_external_subject_type TEXT,
  binding_external_subject_fingerprint TEXT,
  binding_actor_id TEXT,
  binding_actor_type TEXT,
  binding_endpoint_id TEXT,
  binding_created_at TEXT,
  evidence_present INTEGER NOT NULL CHECK (evidence_present IN (0, 1)),
  evidence_membership TEXT CHECK (evidence_membership IS NULL OR evidence_membership IN ('internal', 'external', 'unknown')),
  evidence_active INTEGER CHECK (evidence_active IS NULL OR evidence_active IN (0, 1)),
  evidence_observed_at TEXT,
  evidence_provider_revision TEXT CHECK (evidence_provider_revision IS NULL OR length(evidence_provider_revision) <= 255),
  recorded_at TEXT NOT NULL,
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
    (evidence_present = 1
      AND evidence_membership IS NOT NULL
      AND evidence_observed_at IS NOT NULL
      AND evidence_provider_revision IS NOT NULL)
    OR
    (evidence_present = 0
      AND evidence_membership IS NULL
      AND evidence_active IS NULL
      AND evidence_observed_at IS NULL
      AND evidence_provider_revision IS NULL)
  )
);
