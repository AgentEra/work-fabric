CREATE OR REPLACE FUNCTION work_fabric_semver_satisfies(version text, constraint_text text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  candidate_match text[];
  expected_match text[];
  candidate integer[];
  expected integer[];
  ceiling integer[];
  expression text;
  operator text;
  expected_text text;
BEGIN
  candidate_match := regexp_match(version, '^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$');
  IF candidate_match IS NULL OR btrim(constraint_text) = '' THEN RETURN false; END IF;
  candidate := ARRAY[candidate_match[1]::integer, candidate_match[2]::integer, candidate_match[3]::integer];
  FOREACH expression IN ARRAY regexp_split_to_array(btrim(constraint_text), '\s+') LOOP
    IF left(expression, 1) = '^' THEN
      expected_match := regexp_match(substr(expression, 2), '^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$');
      IF expected_match IS NULL THEN RETURN false; END IF;
      expected := ARRAY[expected_match[1]::integer, expected_match[2]::integer, expected_match[3]::integer];
      ceiling := CASE
        WHEN expected[1] > 0 THEN ARRAY[expected[1] + 1, 0, 0]
        WHEN expected[2] > 0 THEN ARRAY[0, expected[2] + 1, 0]
        ELSE ARRAY[0, 0, expected[3] + 1]
      END;
      IF candidate < expected OR candidate >= ceiling THEN RETURN false; END IF;
      CONTINUE;
    ELSIF left(expression, 1) = '~' THEN
      expected_match := regexp_match(substr(expression, 2), '^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$');
      IF expected_match IS NULL THEN RETURN false; END IF;
      expected := ARRAY[expected_match[1]::integer, expected_match[2]::integer, expected_match[3]::integer];
      ceiling := ARRAY[expected[1], expected[2] + 1, 0];
      IF candidate < expected OR candidate >= ceiling THEN RETURN false; END IF;
      CONTINUE;
    END IF;

    operator := COALESCE((regexp_match(expression, '^(>=|<=|>|<|=)'))[1], '=');
    expected_text := regexp_replace(expression, '^(>=|<=|>|<|=)', '');
    expected_match := regexp_match(expected_text, '^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$');
    IF expected_match IS NULL THEN RETURN false; END IF;
    expected := ARRAY[expected_match[1]::integer, expected_match[2]::integer, expected_match[3]::integer];
    IF operator = '>=' AND NOT candidate >= expected THEN RETURN false;
    ELSIF operator = '<=' AND NOT candidate <= expected THEN RETURN false;
    ELSIF operator = '>' AND NOT candidate > expected THEN RETURN false;
    ELSIF operator = '<' AND NOT candidate < expected THEN RETURN false;
    ELSIF operator = '=' AND NOT candidate = expected THEN RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END $$;

CREATE TABLE IF NOT EXISTS work_fabric_endpoint_registrations (
  tenant_id text NOT NULL,
  endpoint_id text NOT NULL,
  actor_id text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
  administrative_state text NOT NULL CHECK (administrative_state IN ('enabled', 'disabled')),
  registration_version bigint NOT NULL CHECK (registration_version > 0),
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, endpoint_id)
);

CREATE INDEX IF NOT EXISTS work_fabric_endpoint_registrations_actor_idx
  ON work_fabric_endpoint_registrations (tenant_id, actor_id, endpoint_id);
CREATE INDEX IF NOT EXISTS work_fabric_endpoint_registrations_state_idx
  ON work_fabric_endpoint_registrations (tenant_id, administrative_state, endpoint_id);

CREATE TABLE IF NOT EXISTS work_fabric_endpoint_fencing (
  tenant_id text NOT NULL,
  endpoint_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  PRIMARY KEY (tenant_id, endpoint_id),
  FOREIGN KEY (tenant_id, endpoint_id)
    REFERENCES work_fabric_endpoint_registrations (tenant_id, endpoint_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS work_fabric_endpoint_sessions (
  tenant_id text NOT NULL,
  endpoint_id text NOT NULL,
  session_id text NOT NULL,
  client_session_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  heartbeat_sequence bigint NOT NULL CHECK (heartbeat_sequence >= 0),
  state text NOT NULL CHECK (state IN ('active', 'closed', 'fenced')),
  availability text NOT NULL CHECK (availability IN ('available', 'busy', 'draining', 'unavailable')),
  registration_version bigint NOT NULL CHECK (registration_version > 0),
  request_digest text NOT NULL,
  expires_at text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, endpoint_id, session_id),
  UNIQUE (tenant_id, endpoint_id, client_session_id),
  FOREIGN KEY (tenant_id, endpoint_id)
    REFERENCES work_fabric_endpoint_registrations (tenant_id, endpoint_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS work_fabric_endpoint_sessions_lease_idx
  ON work_fabric_endpoint_sessions (tenant_id, state, expires_at, endpoint_id);
CREATE INDEX IF NOT EXISTS work_fabric_endpoint_sessions_capabilities_gin
  ON work_fabric_endpoint_sessions USING gin ((payload->'capabilities') jsonb_path_ops);

CREATE TABLE IF NOT EXISTS work_fabric_endpoint_active_sessions (
  tenant_id text NOT NULL,
  endpoint_id text NOT NULL,
  session_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  PRIMARY KEY (tenant_id, endpoint_id),
  FOREIGN KEY (tenant_id, endpoint_id, session_id)
    REFERENCES work_fabric_endpoint_sessions (tenant_id, endpoint_id, session_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS work_fabric_endpoint_inbox_facts (
  tenant_id text NOT NULL,
  handoff_id text NOT NULL,
  partition_id text NOT NULL,
  resource_version bigint NOT NULL CHECK (resource_version > 0),
  observed_position bigint NOT NULL CHECK (observed_position > 0),
  active boolean NOT NULL,
  visible_actor_ids text[] NOT NULL,
  visible_endpoint_ids text[] NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, handoff_id)
);

CREATE INDEX IF NOT EXISTS work_fabric_endpoint_inbox_partition_idx
  ON work_fabric_endpoint_inbox_facts (tenant_id, active, partition_id, observed_position);
CREATE INDEX IF NOT EXISTS work_fabric_endpoint_inbox_actor_gin
  ON work_fabric_endpoint_inbox_facts USING gin (visible_actor_ids);
CREATE INDEX IF NOT EXISTS work_fabric_endpoint_inbox_endpoint_gin
  ON work_fabric_endpoint_inbox_facts USING gin (visible_endpoint_ids);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'work_fabric_endpoint_registrations',
    'work_fabric_endpoint_fencing',
    'work_fabric_endpoint_sessions',
    'work_fabric_endpoint_active_sessions',
    'work_fabric_endpoint_inbox_facts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_tenant_isolation', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = work_fabric_current_tenant()) WITH CHECK (tenant_id = work_fabric_current_tenant())',
      table_name || '_tenant_isolation',
      table_name
    );
  END LOOP;
END $$;
