CREATE TABLE agent_private_state (
  tenant_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  state_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, namespace, state_key)
);
