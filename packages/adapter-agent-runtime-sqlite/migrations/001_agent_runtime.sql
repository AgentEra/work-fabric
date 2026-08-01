CREATE TABLE agent_runtime_deliveries (
  tenant_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  partition_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  acknowledged_at TEXT,
  PRIMARY KEY (tenant_id, delivery_id)
);

CREATE TABLE agent_runtime_runs (
  tenant_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('received','accepted','running','result_ready','succeeded','failed','cancelled')),
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  owner TEXT,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  lease_expires_at TEXT,
  last_progress_sequence INTEGER NOT NULL CHECK (last_progress_sequence >= 0),
  result_digest TEXT,
  result_json TEXT,
  failure_code TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, handoff_id)
);

CREATE TABLE agent_runtime_commands (
  tenant_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  command TEXT NOT NULL CHECK (command IN ('accept','decline','status','result')),
  idempotency_key TEXT NOT NULL,
  resource_version INTEGER NOT NULL CHECK (resource_version > 0),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, handoff_id, idempotency_key)
);

CREATE INDEX agent_runtime_runs_recovery
  ON agent_runtime_runs (tenant_id, state, lease_expires_at, updated_at);

CREATE INDEX agent_runtime_commands_by_handoff
  ON agent_runtime_commands (tenant_id, handoff_id, command, recorded_at);
