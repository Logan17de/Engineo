CREATE TABLE schedule_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  engine_contract_version integer NOT NULL CHECK (engine_contract_version = 1),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  result_hash text NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  input_bytes text NOT NULL CHECK (octet_length(input_bytes) <= 33554432),
  result_bytes text NOT NULL CHECK (octet_length(result_bytes) <= 33554432),
  created_by uuid NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES projects(organization_id, id) ON DELETE RESTRICT,
  CHECK ((
    jsonb_typeof(input_bytes::jsonb) = 'object'
    AND input_bytes::jsonb->>'schemaVersion' = '1'
    AND input_bytes::jsonb->'project'->>'id' = project_id::text
  ) IS TRUE),
  CHECK ((
    jsonb_typeof(result_bytes::jsonb) = 'object'
    AND result_bytes::jsonb->>'schemaVersion' = '1'
  ) IS TRUE)
);

CREATE INDEX schedule_runs_current_revision_idx
  ON schedule_runs (organization_id, project_id, revision, completed_at DESC, id DESC);

CREATE FUNCTION engineo_reject_schedule_run_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'schedule_runs are append-only';
END;
$$;

CREATE TRIGGER schedule_runs_no_update
BEFORE UPDATE OR DELETE ON schedule_runs
FOR EACH ROW EXECUTE FUNCTION engineo_reject_schedule_run_mutation();
