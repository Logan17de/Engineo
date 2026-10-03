-- A completed immutable run retains the exact canonical input and serialized
-- result. Project edits never rewrite history. No pending jobs are persisted.
ALTER TABLE audit_events ADD CONSTRAINT audit_events_organization_id_id_unique
  UNIQUE (organization_id, id);

CREATE TABLE schedule_calculations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  project_revision bigint NOT NULL CHECK (project_revision BETWEEN 1 AND 9007199254740991),
  input_hash_sha256 text NOT NULL CHECK (input_hash_sha256 ~ '^[a-f0-9]{64}$'),
  result_hash_sha256 text NOT NULL CHECK (result_hash_sha256 ~ '^[a-f0-9]{64}$'),
  engine_contract_version integer NOT NULL CHECK (engine_contract_version = 1),
  engine_version text NOT NULL CHECK (engine_version ~ '^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,127}$'),
  input_canonical text NOT NULL CHECK (octet_length(input_canonical) BETWEEN 1 AND 33554432),
  result_json text NOT NULL CHECK (octet_length(result_json) BETWEEN 1 AND 33554432),
  calculated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  audit_event_id uuid NOT NULL,
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, audit_event_id) REFERENCES audit_events(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (organization_id, project_id, project_revision, input_hash_sha256, engine_contract_version, engine_version),
  CONSTRAINT calculation_input_contract CHECK (
    jsonb_typeof(input_canonical::jsonb) = 'object'
    AND (input_canonical::jsonb)->>'schemaVersion' IS NOT DISTINCT FROM '1'
    AND (input_canonical::jsonb)->'project'->>'id' IS NOT DISTINCT FROM project_id::text
  ),
  CONSTRAINT calculation_result_contract CHECK (
    jsonb_typeof(result_json::jsonb) = 'object'
    AND (result_json::jsonb)->>'schemaVersion' IS NOT DISTINCT FROM '1'
  )
);

CREATE FUNCTION engineo_reject_calculation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'schedule_calculations are append-only';
END;
$$;
CREATE TRIGGER schedule_calculations_no_mutation
BEFORE UPDATE OR DELETE ON schedule_calculations
FOR EACH ROW EXECUTE FUNCTION engineo_reject_calculation_mutation();
CREATE TRIGGER schedule_calculations_no_truncate
BEFORE TRUNCATE ON schedule_calculations
FOR EACH STATEMENT EXECUTE FUNCTION engineo_reject_calculation_mutation();
