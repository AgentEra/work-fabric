CREATE TABLE IF NOT EXISTS work_fabric_partition_readiness (
  tenant_id text NOT NULL,
  partition_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'outbox_wakeup',
    'handoff_projection',
    'collaboration_projection',
    'signal_delivery'
  )),
  kind_rank smallint GENERATED ALWAYS AS (
    CASE kind
      WHEN 'outbox_wakeup' THEN 0
      WHEN 'handoff_projection' THEN 1
      WHEN 'collaboration_projection' THEN 2
      WHEN 'signal_delivery' THEN 3
    END
  ) STORED,
  observed_position bigint NOT NULL CHECK (observed_position > 0),
  available_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, partition_id, kind)
);

CREATE INDEX IF NOT EXISTS work_fabric_partition_readiness_scan_idx
  ON work_fabric_partition_readiness
  (tenant_id, available_at ASC, partition_id ASC, kind_rank ASC);
CREATE INDEX IF NOT EXISTS work_fabric_outbox_cluster_ready_idx
  ON work_fabric_outbox
  (tenant_id, partition_id, work_fabric_timestamp_key(COALESCE(next_attempt_at, '1970-01-01T00:00:00.000Z')), position)
  INCLUDE (lease_expires_at);
CREATE INDEX IF NOT EXISTS work_fabric_events_partition_head_idx
  ON work_fabric_events (tenant_id, partition_id, partition_position DESC);
CREATE INDEX IF NOT EXISTS work_fabric_subscriptions_cluster_active_idx
  ON work_fabric_subscriptions
  (tenant_id, (payload->>'state'), (payload->>'delivery_mode'), subscription_id);

ALTER TABLE work_fabric_partition_readiness ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fabric_partition_readiness FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_fabric_partition_readiness_tenant_isolation
  ON work_fabric_partition_readiness;
CREATE POLICY work_fabric_partition_readiness_tenant_isolation
  ON work_fabric_partition_readiness
  USING (tenant_id = work_fabric_current_tenant())
  WITH CHECK (tenant_id = work_fabric_current_tenant());

CREATE OR REPLACE FUNCTION work_fabric_note_event_readiness()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO work_fabric_partition_readiness (
    tenant_id, partition_id, kind, observed_position, available_at
  )
  SELECT NEW.tenant_id, NEW.partition_id, work_kind,
         NEW.partition_position, NEW.occurred_at::timestamptz
  FROM unnest(ARRAY[
    'handoff_projection',
    'collaboration_projection',
    'signal_delivery'
  ]) AS work_kind
  ON CONFLICT (tenant_id, partition_id, kind) DO UPDATE SET
    observed_position = GREATEST(
      work_fabric_partition_readiness.observed_position,
      EXCLUDED.observed_position
    ),
    available_at = LEAST(
      work_fabric_partition_readiness.available_at,
      EXCLUDED.available_at
    );
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS work_fabric_events_cluster_readiness
  ON work_fabric_events;
CREATE TRIGGER work_fabric_events_cluster_readiness
AFTER INSERT ON work_fabric_events
FOR EACH ROW EXECUTE FUNCTION work_fabric_note_event_readiness();

CREATE OR REPLACE FUNCTION work_fabric_note_outbox_readiness()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO work_fabric_partition_readiness (
    tenant_id, partition_id, kind, observed_position, available_at
  ) VALUES (
    NEW.tenant_id,
    NEW.partition_id,
    'outbox_wakeup',
    NEW.position,
    COALESCE(
      NEW.next_attempt_at,
      NEW.event->>'occurred_at',
      '1970-01-01T00:00:00.000Z'
    )::timestamptz
  )
  ON CONFLICT (tenant_id, partition_id, kind) DO UPDATE SET
    observed_position = GREATEST(
      work_fabric_partition_readiness.observed_position,
      EXCLUDED.observed_position
    ),
    available_at = LEAST(
      work_fabric_partition_readiness.available_at,
      EXCLUDED.available_at
    );
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS work_fabric_outbox_cluster_readiness
  ON work_fabric_outbox;
CREATE TRIGGER work_fabric_outbox_cluster_readiness
AFTER INSERT OR UPDATE OF next_attempt_at, lease_expires_at ON work_fabric_outbox
FOR EACH ROW EXECUTE FUNCTION work_fabric_note_outbox_readiness();

INSERT INTO work_fabric_partition_readiness (
  tenant_id, partition_id, kind, observed_position, available_at
)
SELECT events.tenant_id, events.partition_id, work_kind,
       MAX(events.partition_position), MIN(events.occurred_at::timestamptz)
FROM work_fabric_events AS events
CROSS JOIN unnest(ARRAY[
  'handoff_projection',
  'collaboration_projection',
  'signal_delivery'
]) AS work_kind
GROUP BY events.tenant_id, events.partition_id, work_kind
ON CONFLICT (tenant_id, partition_id, kind) DO UPDATE SET
  observed_position = GREATEST(
    work_fabric_partition_readiness.observed_position,
    EXCLUDED.observed_position
  ),
  available_at = LEAST(
    work_fabric_partition_readiness.available_at,
    EXCLUDED.available_at
  );

INSERT INTO work_fabric_partition_readiness (
  tenant_id, partition_id, kind, observed_position, available_at
)
SELECT tenant_id, partition_id, 'outbox_wakeup', MAX(position),
       MIN(COALESCE(
         next_attempt_at,
         event->>'occurred_at',
         '1970-01-01T00:00:00.000Z'
       )::timestamptz)
FROM work_fabric_outbox
GROUP BY tenant_id, partition_id
ON CONFLICT (tenant_id, partition_id, kind) DO UPDATE SET
  observed_position = GREATEST(
    work_fabric_partition_readiness.observed_position,
    EXCLUDED.observed_position
  ),
  available_at = LEAST(
    work_fabric_partition_readiness.available_at,
    EXCLUDED.available_at
  );
