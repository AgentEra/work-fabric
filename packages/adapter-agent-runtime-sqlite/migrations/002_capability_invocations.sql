CREATE TABLE agent_capability_invocations (
  tenant_id TEXT NOT NULL,
  original_handoff_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'requested','offered','waiting','succeeded',
      'rejected','failed','cancelled'
    )
  ),
  request_digest TEXT NOT NULL,
  owner TEXT,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  lease_expires_at TEXT,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, original_handoff_id, invocation_id)
);

CREATE INDEX agent_capability_invocations_recovery
  ON agent_capability_invocations (
    tenant_id,
    state,
    lease_expires_at,
    updated_at,
    invocation_id
  );
