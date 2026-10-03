-- Durable configuration identities are scoped to a project; review data can be
-- collected after its explicit retention horizon without permitting identity reuse.
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_user_id_id_unique UNIQUE (user_id, id);
ALTER TABLE audit_events ADD CONSTRAINT audit_events_organization_resource_id_id_unique
  UNIQUE (organization_id, resource_id, id);

CREATE TABLE project_configuration_plans (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  actor_id uuid NOT NULL,
  session_id uuid NOT NULL,
  protocol_version integer NOT NULL CHECK (protocol_version = 1),
  configuration_version integer NOT NULL CHECK (configuration_version = 1),
  normalization_version integer NOT NULL CHECK (normalization_version = 1),
  base_revision bigint NOT NULL CHECK (base_revision BETWEEN 1 AND 9007199254740990),
  base_input_hash_sha256 text NOT NULL CHECK (base_input_hash_sha256 ~ '^[a-f0-9]{64}$'),
  desired_input_hash_sha256 text NOT NULL CHECK (desired_input_hash_sha256 ~ '^[a-f0-9]{64}$'),
  request_hash_sha256 text NOT NULL CHECK (request_hash_sha256 ~ '^[a-f0-9]{64}$'),
  reviewed_digest text NOT NULL CHECK (reviewed_digest ~ '^[a-f0-9]{64}$'),
  no_op boolean NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  artifacts_keep_until timestamptz NOT NULL,
  plan_audit_id uuid NOT NULL,
  PRIMARY KEY (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id, session_id) REFERENCES auth_sessions(user_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, project_id, plan_audit_id)
    REFERENCES audit_events(organization_id, resource_id, id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
  CHECK (artifacts_keep_until >= expires_at AND artifacts_keep_until <= created_at + interval '24 hours'),
  CHECK (NOT no_op OR base_input_hash_sha256 = desired_input_hash_sha256)
);
CREATE INDEX project_configuration_actor_created_idx
  ON project_configuration_plans (organization_id, project_id, actor_id, created_at DESC);
CREATE INDEX project_configuration_project_created_idx
  ON project_configuration_plans (organization_id, project_id, created_at DESC)
  INCLUDE (actor_id, expires_at, id);
CREATE INDEX project_configuration_project_pending_idx
  ON project_configuration_plans (organization_id, project_id, expires_at);

CREATE TABLE project_configuration_outcomes (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'no_op', 'cancelled')),
  previous_revision bigint NOT NULL CHECK (previous_revision BETWEEN 1 AND 9007199254740990),
  committed_revision bigint CHECK (committed_revision BETWEEN 1 AND 9007199254740991),
  base_input_hash_sha256 text NOT NULL CHECK (base_input_hash_sha256 ~ '^[a-f0-9]{64}$'),
  committed_input_hash_sha256 text CHECK (committed_input_hash_sha256 ~ '^[a-f0-9]{64}$'),
  reviewed_digest text NOT NULL CHECK (reviewed_digest ~ '^[a-f0-9]{64}$'),
  provenance_audit_id uuid NOT NULL,
  schedule_edit_audit_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  receipt_json text NOT NULL CHECK (octet_length(receipt_json) BETWEEN 1 AND 16384),
  receipt_hash_sha256 text NOT NULL CHECK (receipt_hash_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (organization_id, project_id, plan_id),
  FOREIGN KEY (organization_id, project_id, plan_id)
    REFERENCES project_configuration_plans(organization_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, project_id, provenance_audit_id)
    REFERENCES audit_events(organization_id, resource_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, project_id, schedule_edit_audit_id)
    REFERENCES audit_events(organization_id, resource_id, id) ON DELETE RESTRICT,
  CHECK ((outcome = 'cancelled' AND committed_revision IS NULL AND committed_input_hash_sha256 IS NULL
          AND schedule_edit_audit_id IS NULL)
    OR (outcome = 'no_op' AND committed_revision = previous_revision AND
        committed_input_hash_sha256 = base_input_hash_sha256 AND schedule_edit_audit_id IS NULL)
    OR (outcome = 'applied' AND committed_revision = previous_revision + 1 AND
        committed_input_hash_sha256 IS NOT NULL AND schedule_edit_audit_id IS NOT NULL)),
  CONSTRAINT configuration_receipt_hash_integrity CHECK (receipt_hash_sha256 = encode(sha256(convert_to(receipt_json, 'UTF8')), 'hex')),
  CHECK (jsonb_typeof(receipt_json::jsonb) = 'object' AND
    receipt_json::jsonb->>'planId' IS NOT DISTINCT FROM plan_id::text AND
    receipt_json::jsonb->>'organizationId' IS NOT DISTINCT FROM organization_id::text AND
    receipt_json::jsonb->>'projectId' IS NOT DISTINCT FROM project_id::text AND
    receipt_json::jsonb->>'outcome' IS NOT DISTINCT FROM outcome)
);

-- O(1) counter consistency evidence. This is non-secret integrity state, not
-- authentication: the trusted artifact trigger is the only supported writer.
CREATE FUNCTION engineo_configuration_counter_hash(scope text, bytes bigint, count bigint)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT encode(sha256(convert_to(scope || ':' || bytes::text || ':' || count::text, 'UTF8')), 'hex')
$$;
CREATE TABLE project_configuration_storage_budget (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes BETWEEN 0 AND 1073741824),
  artifact_count bigint NOT NULL DEFAULT 0 CHECK (artifact_count BETWEEN 0 AND 214748364),
  state_hash_sha256 text NOT NULL DEFAULT engineo_configuration_counter_hash('global', 0, 0)
    CHECK (state_hash_sha256 ~ '^[a-f0-9]{64}$')
);
INSERT INTO project_configuration_storage_budget DEFAULT VALUES;
CREATE TABLE project_configuration_project_storage (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes BETWEEN 0 AND 134217728),
  artifact_count bigint NOT NULL DEFAULT 0 CHECK (artifact_count BETWEEN 0 AND 26843545),
  state_hash_sha256 text NOT NULL CHECK (state_hash_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (organization_id, project_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE RESTRICT
);
CREATE FUNCTION engineo_protect_configuration_counter() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope text; transition jsonb; delta_bytes bigint; delta_count bigint; call_context text;
BEGIN
  -- Exact nesting and scoped transitions, not a blanket nested-trigger capability.
  IF TG_OP IN ('DELETE', 'TRUNCATE') OR pg_trigger_depth() <> 2 THEN
    RAISE EXCEPTION 'configuration counters are artifact-trigger managed' USING ERRCODE = 'P0003';
  END IF;
  GET DIAGNOSTICS call_context = PG_CONTEXT;
  IF position('engineo_configuration_artifact_budget()' IN call_context) = 0 OR
    TG_TABLE_NAME NOT IN ('project_configuration_storage_budget', 'project_configuration_project_storage') THEN
    RAISE EXCEPTION 'configuration counter writer invalid' USING ERRCODE = 'P0003';
  END IF;
  transition := nullif(current_setting('engineo.configuration_counter_transition', true), '')::jsonb;
  IF transition IS NULL OR transition->>'operation' NOT IN ('INSERT', 'DELETE') THEN
    RAISE EXCEPTION 'configuration counter transition missing' USING ERRCODE = 'P0003';
  END IF;
  delta_bytes := (transition->>'deltaBytes')::bigint;
  delta_count := CASE WHEN transition->>'operation' = 'INSERT' THEN 1 ELSE -1 END;
  IF delta_bytes IS NULL OR abs(delta_bytes::numeric) NOT BETWEEN 5 AND 33554432 OR (delta_count = 1 AND delta_bytes <= 0) OR (delta_count = -1 AND delta_bytes >= 0) THEN
    RAISE EXCEPTION 'configuration counter delta invalid' USING ERRCODE = 'P0003';
  END IF;
  IF TG_TABLE_NAME = 'project_configuration_storage_budget' THEN
    scope := 'global';
    IF TG_OP <> 'UPDATE' OR NEW.singleton IS DISTINCT FROM OLD.singleton THEN
      RAISE EXCEPTION 'configuration global counter scope invalid' USING ERRCODE = 'P0003';
    END IF;
  ELSE
    scope := NEW.organization_id::text || '/' || NEW.project_id::text;
    IF transition->>'organizationId' IS DISTINCT FROM NEW.organization_id::text OR
      transition->>'projectId' IS DISTINCT FROM NEW.project_id::text OR
      (TG_OP = 'UPDATE' AND (NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.project_id IS DISTINCT FROM OLD.project_id)) THEN
      RAISE EXCEPTION 'configuration project counter scope invalid' USING ERRCODE = 'P0003';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF transition->>'operation' <> 'INSERT' OR NEW.used_bytes <> 0 OR NEW.artifact_count <> 0 THEN
      RAISE EXCEPTION 'configuration initial counter invalid' USING ERRCODE = 'P0003';
    END IF;
  ELSE
    IF OLD.state_hash_sha256 IS DISTINCT FROM engineo_configuration_counter_hash(scope, OLD.used_bytes, OLD.artifact_count) OR
      NEW.used_bytes::numeric <> OLD.used_bytes::numeric + delta_bytes::numeric OR
      NEW.artifact_count::numeric <> OLD.artifact_count::numeric + delta_count::numeric THEN
      RAISE EXCEPTION 'configuration counter state or transition invalid' USING ERRCODE = 'P0003';
    END IF;
  END IF;
  NEW.state_hash_sha256 := engineo_configuration_counter_hash(scope, NEW.used_bytes, NEW.artifact_count);
  RETURN NEW;
END;
$$;
CREATE TRIGGER configuration_global_counter_managed BEFORE INSERT OR UPDATE OR DELETE ON project_configuration_storage_budget
  FOR EACH ROW EXECUTE FUNCTION engineo_protect_configuration_counter();
CREATE TRIGGER configuration_global_counter_no_truncate BEFORE TRUNCATE ON project_configuration_storage_budget
  FOR EACH STATEMENT EXECUTE FUNCTION engineo_protect_configuration_counter();
CREATE TRIGGER configuration_project_counter_managed BEFORE INSERT OR UPDATE OR DELETE ON project_configuration_project_storage
  FOR EACH ROW EXECUTE FUNCTION engineo_protect_configuration_counter();
CREATE TRIGGER configuration_project_counter_no_truncate BEFORE TRUNCATE ON project_configuration_project_storage
  FOR EACH STATEMENT EXECUTE FUNCTION engineo_protect_configuration_counter();

CREATE TABLE project_configuration_artifacts (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  base_canonical text NOT NULL CHECK (octet_length(base_canonical) BETWEEN 1 AND 4194304),
  candidate_canonical text NOT NULL CHECK (octet_length(candidate_canonical) BETWEEN 1 AND 4194304),
  diff_json text NOT NULL CHECK (octet_length(diff_json) BETWEEN 2 AND 8388608),
  review_json text NOT NULL CHECK (octet_length(review_json) BETWEEN 1 AND 16777216),
  keep_until timestamptz NOT NULL,
  byte_count bigint GENERATED ALWAYS AS (octet_length(base_canonical)::bigint +
    octet_length(candidate_canonical)::bigint + octet_length(diff_json)::bigint +
    octet_length(review_json)::bigint) STORED,
  PRIMARY KEY (organization_id, project_id, plan_id),
  FOREIGN KEY (organization_id, project_id, plan_id)
    REFERENCES project_configuration_plans(organization_id, project_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(base_canonical::jsonb) = 'object' AND
    base_canonical::jsonb->'project'->>'id' IS NOT DISTINCT FROM project_id::text),
  CHECK (jsonb_typeof(candidate_canonical::jsonb) = 'object' AND
    candidate_canonical::jsonb->'project'->>'id' IS NOT DISTINCT FROM project_id::text),
  CHECK (jsonb_typeof(diff_json::jsonb) = 'array'),
  CHECK (jsonb_typeof(review_json::jsonb) = 'object')
);
CREATE INDEX project_configuration_artifact_retention_idx
  ON project_configuration_artifacts (keep_until, organization_id, project_id, plan_id);

CREATE FUNCTION engineo_reject_configuration_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'configuration identities and outcomes are append-only'; END;
$$;
CREATE TRIGGER configuration_plans_no_mutation BEFORE UPDATE OR DELETE ON project_configuration_plans
  FOR EACH ROW EXECUTE FUNCTION engineo_reject_configuration_mutation();
CREATE TRIGGER configuration_plans_no_truncate BEFORE TRUNCATE ON project_configuration_plans
  FOR EACH STATEMENT EXECUTE FUNCTION engineo_reject_configuration_mutation();
CREATE TRIGGER configuration_outcomes_no_mutation BEFORE UPDATE OR DELETE ON project_configuration_outcomes
  FOR EACH ROW EXECUTE FUNCTION engineo_reject_configuration_mutation();
CREATE TRIGGER configuration_outcomes_no_truncate BEFORE TRUNCATE ON project_configuration_outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION engineo_reject_configuration_mutation();
CREATE TRIGGER configuration_artifacts_no_update BEFORE UPDATE ON project_configuration_artifacts
  FOR EACH ROW EXECUTE FUNCTION engineo_reject_configuration_mutation();
CREATE TRIGGER configuration_artifacts_no_truncate BEFORE TRUNCATE ON project_configuration_artifacts
  FOR EACH STATEMENT EXECUTE FUNCTION engineo_reject_configuration_mutation();

CREATE FUNCTION engineo_validate_configuration_plan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session_expiry timestamptz; audit audit_events%ROWTYPE;
BEGIN
  SELECT expires_at INTO session_expiry FROM auth_sessions WHERE id = NEW.session_id AND user_id = NEW.actor_id;
  IF session_expiry IS NULL OR NEW.expires_at > session_expiry THEN
    RAISE EXCEPTION 'configuration plan session boundary invalid' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO STRICT audit FROM audit_events WHERE organization_id = NEW.organization_id
    AND resource_id = NEW.project_id AND id = NEW.plan_audit_id;
  IF audit.actor_id IS DISTINCT FROM NEW.actor_id OR audit.actor_type <> 'user' OR
    audit.action <> 'configuration.plan' OR audit.source <> 'api' OR audit.resource_type <> 'project' OR
    audit.payload->>'planId' IS DISTINCT FROM NEW.id::text OR
    audit.payload->>'sessionId' IS DISTINCT FROM NEW.session_id::text OR
    audit.payload->>'reviewedDigest' IS DISTINCT FROM NEW.reviewed_digest THEN
    RAISE EXCEPTION 'configuration plan audit boundary invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER configuration_plan_session_bound BEFORE INSERT ON project_configuration_plans
  FOR EACH ROW EXECUTE FUNCTION engineo_validate_configuration_plan();

CREATE FUNCTION engineo_validate_configuration_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE plan project_configuration_plans%ROWTYPE; provenance audit_events%ROWTYPE; edit audit_events%ROWTYPE;
BEGIN
  SELECT * INTO STRICT plan FROM project_configuration_plans WHERE organization_id = NEW.organization_id
    AND project_id = NEW.project_id AND id = NEW.plan_id;
  IF NEW.previous_revision <> plan.base_revision OR NEW.base_input_hash_sha256 <> plan.base_input_hash_sha256
    OR NEW.reviewed_digest <> plan.reviewed_digest OR
    (NEW.outcome <> 'cancelled' AND NEW.committed_input_hash_sha256 <> plan.desired_input_hash_sha256)
    OR (NEW.outcome = 'no_op' AND NOT plan.no_op) OR (NEW.outcome = 'applied' AND plan.no_op) THEN
    RAISE EXCEPTION 'configuration outcome plan boundary invalid' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO STRICT provenance FROM audit_events WHERE organization_id = NEW.organization_id
    AND resource_id = NEW.project_id AND id = NEW.provenance_audit_id;
  IF provenance.actor_id IS DISTINCT FROM plan.actor_id OR provenance.actor_type <> 'user' OR
    provenance.source <> 'api' OR provenance.resource_type <> 'project' OR
    provenance.action <> (CASE WHEN NEW.outcome = 'cancelled' THEN 'configuration.cancel' ELSE 'configuration.apply' END) OR
    provenance.payload->>'planId' IS DISTINCT FROM NEW.plan_id::text OR
    provenance.payload->>'sessionId' IS DISTINCT FROM plan.session_id::text OR
    provenance.payload->>'reviewedDigest' IS DISTINCT FROM NEW.reviewed_digest THEN
    RAISE EXCEPTION 'configuration outcome audit boundary invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.schedule_edit_audit_id IS NOT NULL THEN
    SELECT * INTO STRICT edit FROM audit_events WHERE organization_id = NEW.organization_id
      AND resource_id = NEW.project_id AND id = NEW.schedule_edit_audit_id;
    IF edit.actor_id IS DISTINCT FROM plan.actor_id OR edit.actor_type <> 'user' OR edit.action <> 'project.schedule.edit' OR
      edit.source <> 'api' OR edit.resource_type <> 'project' OR
      edit.payload->>'planId' IS DISTINCT FROM NEW.plan_id::text OR
      edit.payload->>'sessionId' IS DISTINCT FROM plan.session_id::text OR
      edit.payload->>'reviewedDigest' IS DISTINCT FROM NEW.reviewed_digest OR
      edit.payload->>'schemaVersion' IS DISTINCT FROM '1' OR
      edit.payload->>'kind' IS DISTINCT FROM 'engineo-configuration-schedule-edit' OR
      edit.payload->>'operation' IS DISTINCT FROM 'configuration.apply' OR
      edit.payload->>'inputHashSerialization' IS DISTINCT FROM 'engineo-schedule-input-v1-canonical' OR
      edit.payload->>'baseInputHashSha256' IS DISTINCT FROM plan.base_input_hash_sha256 OR
      edit.payload->>'committedInputHashSha256' IS DISTINCT FROM plan.desired_input_hash_sha256 THEN
      RAISE EXCEPTION 'configuration edit audit boundary invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER configuration_outcome_plan_bound BEFORE INSERT ON project_configuration_outcomes
  FOR EACH ROW EXECUTE FUNCTION engineo_validate_configuration_outcome();

-- All budget updates take the singleton first, then the project counter. The
-- generated byte count prevents an API caller from understating its allocation.
CREATE FUNCTION engineo_configuration_artifact_budget() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bytes bigint; changed bigint; retention timestamptz;
  global_state project_configuration_storage_budget%ROWTYPE;
  project_state project_configuration_project_storage%ROWTYPE;
  plan project_configuration_plans%ROWTYPE; previous_transition text;
BEGIN
  IF TG_TABLE_NAME <> 'project_configuration_artifacts' OR TG_LEVEL <> 'ROW' OR TG_OP NOT IN ('INSERT', 'DELETE') THEN
    RAISE EXCEPTION 'configuration artifact transition invalid' USING ERRCODE = 'P0003';
  END IF;
  previous_transition := current_setting('engineo.configuration_counter_transition', true);
  -- Constant-size accounting checks under the shared admission lock. Generated
  -- artifact bytes, immutable rows and protected atomic writers establish totals;
  -- no retained-history SUM scan runs on admission or each maintenance deletion.
  SELECT * INTO global_state FROM project_configuration_storage_budget WHERE singleton FOR UPDATE;
  IF NOT FOUND OR global_state.state_hash_sha256 IS DISTINCT FROM
    engineo_configuration_counter_hash('global', global_state.used_bytes, global_state.artifact_count) THEN
    RAISE EXCEPTION 'configuration storage accounting invalid' USING ERRCODE = 'P0003';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO STRICT plan FROM project_configuration_plans WHERE organization_id = NEW.organization_id
      AND project_id = NEW.project_id AND id = NEW.plan_id;
    retention := plan.artifacts_keep_until;
    IF NEW.keep_until <> retention OR retention <= clock_timestamp() THEN
      RAISE EXCEPTION 'configuration artifact retention invalid' USING ERRCODE = '23514';
    END IF;
    IF encode(sha256(convert_to(NEW.base_canonical, 'UTF8')), 'hex') <> plan.base_input_hash_sha256 OR
      encode(sha256(convert_to(NEW.candidate_canonical, 'UTF8')), 'hex') <> plan.desired_input_hash_sha256 OR
      encode(sha256(convert_to(NEW.review_json, 'UTF8')), 'hex') <> plan.reviewed_digest THEN
      RAISE EXCEPTION 'configuration artifact integrity invalid' USING ERRCODE = '23514';
    END IF;
    bytes := octet_length(NEW.base_canonical)::bigint + octet_length(NEW.candidate_canonical)::bigint +
      octet_length(NEW.diff_json)::bigint + octet_length(NEW.review_json)::bigint;
    PERFORM set_config('engineo.configuration_counter_transition', jsonb_build_object(
      'operation', 'INSERT', 'organizationId', NEW.organization_id::text, 'projectId', NEW.project_id::text,
      'planId', NEW.plan_id::text, 'deltaBytes', bytes)::text, true);
    UPDATE project_configuration_storage_budget SET used_bytes = used_bytes + bytes, artifact_count = artifact_count + 1
      WHERE singleton AND used_bytes + bytes <= 1073741824 RETURNING used_bytes INTO changed;
    IF NOT FOUND THEN RAISE EXCEPTION 'configuration artifact capacity' USING ERRCODE = 'P0002'; END IF;
    -- Only an actually empty artifact scope may initialize a zero counter.
    -- The shared admission lock serializes initialization across replicas.
    IF NOT EXISTS (SELECT 1 FROM project_configuration_project_storage
      WHERE organization_id = NEW.organization_id AND project_id = NEW.project_id) THEN
      IF EXISTS (SELECT 1 FROM project_configuration_artifacts
        WHERE organization_id = NEW.organization_id AND project_id = NEW.project_id) THEN
        RAISE EXCEPTION 'configuration project counter missing for retained data' USING ERRCODE = 'P0003';
      END IF;
      INSERT INTO project_configuration_project_storage (organization_id, project_id)
        VALUES (NEW.organization_id, NEW.project_id);
    END IF;
    SELECT * INTO project_state FROM project_configuration_project_storage
      WHERE organization_id = NEW.organization_id AND project_id = NEW.project_id FOR UPDATE;
    IF NOT FOUND OR project_state.state_hash_sha256 IS DISTINCT FROM
      engineo_configuration_counter_hash(NEW.organization_id::text || '/' || NEW.project_id::text,
        project_state.used_bytes, project_state.artifact_count) THEN
      RAISE EXCEPTION 'configuration storage accounting invalid' USING ERRCODE = 'P0003';
    END IF;
    UPDATE project_configuration_project_storage SET used_bytes = used_bytes + bytes, artifact_count = artifact_count + 1
      WHERE organization_id = NEW.organization_id AND project_id = NEW.project_id AND used_bytes + bytes <= 134217728
      RETURNING used_bytes INTO changed;
    IF NOT FOUND THEN RAISE EXCEPTION 'configuration artifact capacity' USING ERRCODE = 'P0002'; END IF;
    PERFORM set_config('engineo.configuration_counter_transition', COALESCE(previous_transition, ''), true);
    RETURN NEW;
  END IF;
  IF global_state.used_bytes < OLD.byte_count OR global_state.artifact_count < 1 THEN
    RAISE EXCEPTION 'configuration global accounting underflow' USING ERRCODE = 'P0003';
  END IF;
  IF OLD.keep_until > clock_timestamp() THEN
    RAISE EXCEPTION 'configuration artifacts remain immutable during retention' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO project_state FROM project_configuration_project_storage
    WHERE organization_id = OLD.organization_id AND project_id = OLD.project_id FOR UPDATE;
  IF NOT FOUND OR project_state.state_hash_sha256 IS DISTINCT FROM
    engineo_configuration_counter_hash(OLD.organization_id::text || '/' || OLD.project_id::text,
      project_state.used_bytes, project_state.artifact_count) THEN
    RAISE EXCEPTION 'configuration storage accounting invalid' USING ERRCODE = 'P0003';
  END IF;
  IF project_state.used_bytes < OLD.byte_count OR project_state.artifact_count < 1 THEN
    RAISE EXCEPTION 'configuration project accounting underflow' USING ERRCODE = 'P0003';
  END IF;
  PERFORM set_config('engineo.configuration_counter_transition', jsonb_build_object(
    'operation', 'DELETE', 'organizationId', OLD.organization_id::text, 'projectId', OLD.project_id::text,
    'planId', OLD.plan_id::text, 'deltaBytes', -OLD.byte_count)::text, true);
  UPDATE project_configuration_storage_budget SET used_bytes = used_bytes - OLD.byte_count, artifact_count = artifact_count - 1 WHERE singleton;
  UPDATE project_configuration_project_storage SET used_bytes = used_bytes - OLD.byte_count, artifact_count = artifact_count - 1
    WHERE organization_id = OLD.organization_id AND project_id = OLD.project_id;
  PERFORM set_config('engineo.configuration_counter_transition', COALESCE(previous_transition, ''), true);
  RETURN OLD;
END;
$$;
CREATE TRIGGER configuration_artifact_budget BEFORE INSERT OR DELETE ON project_configuration_artifacts
  FOR EACH ROW EXECUTE FUNCTION engineo_configuration_artifact_budget();
