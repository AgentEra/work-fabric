CREATE TABLE IF NOT EXISTS network_citizen_provisioning (
  tenant_id TEXT NOT NULL,
  citizen_id TEXT NOT NULL,
  citizen_kind TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  administrative_state TEXT NOT NULL,
  registration_version INTEGER NOT NULL,
  registration_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, citizen_id)
);

CREATE TABLE IF NOT EXISTS network_citizen_sessions (
  tenant_id TEXT NOT NULL,
  citizen_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  client_session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  availability TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  heartbeat_sequence INTEGER NOT NULL,
  registration_version INTEGER NOT NULL,
  declaration_version INTEGER NOT NULL,
  declaration_digest TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  renew_after TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  session_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, citizen_id, session_id),
  UNIQUE (tenant_id, citizen_id, client_session_id)
);

CREATE INDEX IF NOT EXISTS network_citizen_sessions_projection
  ON network_citizen_sessions (tenant_id, citizen_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS network_citizen_active_sessions (
  tenant_id TEXT NOT NULL,
  citizen_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, citizen_id),
  FOREIGN KEY (tenant_id, citizen_id, session_id)
    REFERENCES network_citizen_sessions (tenant_id, citizen_id, session_id)
);

CREATE TABLE IF NOT EXISTS network_citizen_schema_digests (
  tenant_id TEXT NOT NULL,
  schema_uri TEXT NOT NULL,
  schema_digest TEXT NOT NULL,
  PRIMARY KEY (tenant_id, schema_uri)
);
