CREATE TABLE IF NOT EXISTS work_fabric_local_store_operations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  store_kind TEXT NOT NULL,
  operation TEXT NOT NULL,
  arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'committed')),
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS work_fabric_local_store_replay
  ON work_fabric_local_store_operations (tenant_id, store_kind, state, sequence);
