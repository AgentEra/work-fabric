CREATE TABLE IF NOT EXISTS work_fabric_projection_checkpoints (
  tenant_id text NOT NULL, projector_id text NOT NULL, partition_id text NOT NULL,
  position bigint NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, projector_id, partition_id)
);
CREATE TABLE IF NOT EXISTS work_fabric_projection_failures (
  tenant_id text NOT NULL, projector_id text NOT NULL, partition_id text NOT NULL,
  event_id text NOT NULL, position bigint NOT NULL, reason text NOT NULL,
  recorded_at text NOT NULL, PRIMARY KEY (tenant_id, projector_id, partition_id, event_id)
);
CREATE TABLE IF NOT EXISTS work_fabric_subscriptions (
  tenant_id text NOT NULL, subscription_id text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, subscription_id)
);
CREATE TABLE IF NOT EXISTS work_fabric_delivery_positions (
  tenant_id text NOT NULL, subscription_id text NOT NULL, partition_id text NOT NULL,
  position bigint NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, subscription_id, partition_id)
);
CREATE TABLE IF NOT EXISTS work_fabric_delivery_attempts (
  tenant_id text NOT NULL, subscription_id text NOT NULL, partition_id text NOT NULL,
  event_id text NOT NULL, attempt bigint NOT NULL, attempted_at text NOT NULL,
  outcome text NOT NULL, detail text, next_attempt_at text,
  PRIMARY KEY (tenant_id, subscription_id, partition_id, event_id, attempt)
);
CREATE TABLE IF NOT EXISTS work_fabric_dead_letters (
  tenant_id text NOT NULL, subscription_id text NOT NULL, event_id text NOT NULL,
  payload jsonb NOT NULL, attempts bigint NOT NULL, reason text NOT NULL,
  recorded_at text NOT NULL, PRIMARY KEY (tenant_id, subscription_id, event_id)
);
CREATE TABLE IF NOT EXISTS work_fabric_deliveries (
  tenant_id text NOT NULL, delivery_id text NOT NULL, subscription_id text NOT NULL,
  partition_id text NOT NULL, from_position bigint NOT NULL, to_position bigint NOT NULL,
  next_cursor text NOT NULL, events jsonb NOT NULL, attempt bigint NOT NULL,
  delivered_at text NOT NULL, visibility_expires_at text NOT NULL,
  outcome text NOT NULL, PRIMARY KEY (tenant_id, delivery_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS work_fabric_active_delivery_key
  ON work_fabric_deliveries (tenant_id, subscription_id, partition_id)
  WHERE outcome = 'pending';
CREATE TABLE IF NOT EXISTS work_fabric_worker_leases (
  tenant_id text NOT NULL, lease_key text NOT NULL, owner text NOT NULL,
  fencing_token bigint NOT NULL, expires_at text NOT NULL,
  PRIMARY KEY (tenant_id, lease_key)
);

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'work_fabric_projection_checkpoints','work_fabric_projection_failures',
    'work_fabric_subscriptions','work_fabric_delivery_positions',
    'work_fabric_delivery_attempts','work_fabric_dead_letters',
    'work_fabric_deliveries','work_fabric_worker_leases'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_tenant_isolation', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = work_fabric_current_tenant()) WITH CHECK (tenant_id = work_fabric_current_tenant())', table_name || '_tenant_isolation', table_name);
  END LOOP;
END $$;
