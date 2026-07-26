DROP INDEX IF EXISTS work_fabric_partition_readiness_scan_idx;

ALTER TABLE work_fabric_partition_readiness
  DROP CONSTRAINT IF EXISTS work_fabric_partition_readiness_kind_check;
ALTER TABLE work_fabric_partition_readiness
  DROP COLUMN IF EXISTS kind_rank;
ALTER TABLE work_fabric_partition_readiness
  ADD CONSTRAINT work_fabric_partition_readiness_kind_check CHECK (kind IN (
    'outbox_wakeup',
    'handoff_projection',
    'endpoint_inbox_projection',
    'collaboration_projection',
    'signal_delivery'
  ));
ALTER TABLE work_fabric_partition_readiness
  ADD COLUMN kind_rank smallint GENERATED ALWAYS AS (
    CASE kind
      WHEN 'outbox_wakeup' THEN 0
      WHEN 'handoff_projection' THEN 1
      WHEN 'endpoint_inbox_projection' THEN 2
      WHEN 'collaboration_projection' THEN 3
      WHEN 'signal_delivery' THEN 4
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS work_fabric_partition_readiness_scan_idx
  ON work_fabric_partition_readiness
  (tenant_id, available_at ASC, partition_id ASC, kind_rank ASC);

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
    'endpoint_inbox_projection',
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

INSERT INTO work_fabric_partition_readiness (
  tenant_id, partition_id, kind, observed_position, available_at
)
SELECT events.tenant_id, events.partition_id, 'endpoint_inbox_projection',
       MAX(events.partition_position), MIN(events.occurred_at::timestamptz)
FROM work_fabric_events AS events
GROUP BY events.tenant_id, events.partition_id
ON CONFLICT (tenant_id, partition_id, kind) DO UPDATE SET
  observed_position = GREATEST(
    work_fabric_partition_readiness.observed_position,
    EXCLUDED.observed_position
  ),
  available_at = LEAST(
    work_fabric_partition_readiness.available_at,
    EXCLUDED.available_at
  );
