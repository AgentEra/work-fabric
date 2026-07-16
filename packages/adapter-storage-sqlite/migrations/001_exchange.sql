CREATE TABLE IF NOT EXISTS work_fabric_events (
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  partition_id TEXT NOT NULL,
  partition_position INTEGER NOT NULL CHECK (partition_position > 0),
  stream_id TEXT NOT NULL,
  stream_version INTEGER NOT NULL CHECK (stream_version > 0),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, partition_id, partition_position),
  UNIQUE (tenant_id, stream_id, stream_version)
);

CREATE INDEX IF NOT EXISTS work_fabric_events_stream
  ON work_fabric_events (tenant_id, stream_id, stream_version);
CREATE INDEX IF NOT EXISTS work_fabric_events_partition
  ON work_fabric_events (tenant_id, partition_id, partition_position);

CREATE TABLE IF NOT EXISTS work_fabric_commands (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  first_request_message_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (json_valid(outcome)),
  PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS work_fabric_snapshots (
  tenant_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_version INTEGER NOT NULL CHECK (stream_version >= 0),
  schema_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (json_valid(state)),
  PRIMARY KEY (tenant_id, stream_id)
);

CREATE TABLE IF NOT EXISTS work_fabric_outbox (
  tenant_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  partition_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position > 0),
  event TEXT NOT NULL CHECK (json_valid(event)),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  next_attempt_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  PRIMARY KEY (tenant_id, outbox_id),
  UNIQUE (tenant_id, partition_id, position)
);

CREATE INDEX IF NOT EXISTS work_fabric_outbox_claim
  ON work_fabric_outbox (
    tenant_id, partition_id, next_attempt_at, lease_expires_at, position
  );

CREATE TABLE IF NOT EXISTS work_fabric_projection_checkpoints (
  tenant_id TEXT NOT NULL,
  projector_id TEXT NOT NULL,
  partition_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (tenant_id, projector_id, partition_id)
);

CREATE TABLE IF NOT EXISTS work_fabric_projection_failures (
  tenant_id TEXT NOT NULL,
  projector_id TEXT NOT NULL,
  partition_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position > 0),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (tenant_id, projector_id, partition_id, event_id, position)
);

CREATE TABLE IF NOT EXISTS work_fabric_delivery_positions (
  tenant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  partition_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (tenant_id, subscription_id, partition_id)
);

CREATE TABLE IF NOT EXISTS work_fabric_delivery_attempts (
  tenant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (tenant_id, subscription_id, event_id, attempt)
);

CREATE TABLE IF NOT EXISTS work_fabric_dead_letters (
  tenant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  partition_id TEXT NOT NULL,
  partition_position INTEGER NOT NULL CHECK (partition_position > 0),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (tenant_id, subscription_id, event_id)
);

CREATE TABLE IF NOT EXISTS work_fabric_deliveries (
  tenant_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  partition_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (tenant_id, delivery_id)
);

CREATE TABLE IF NOT EXISTS work_fabric_delivery_active (
  tenant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  partition_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, subscription_id, partition_id),
  FOREIGN KEY (tenant_id, delivery_id)
    REFERENCES work_fabric_deliveries (tenant_id, delivery_id)
);

CREATE TABLE IF NOT EXISTS work_fabric_subscriptions (
  tenant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (tenant_id, subscription_id)
);

CREATE TABLE IF NOT EXISTS work_fabric_worker_leases (
  tenant_id TEXT NOT NULL,
  lease_key TEXT NOT NULL,
  owner TEXT,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, lease_key)
);
