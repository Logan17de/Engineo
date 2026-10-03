-- Private presentation state is independent of every schedule/configuration
-- revision. This forward migration never alters an applied migration or the
-- existing append-only audit triggers. Limits are logical allocation ceilings,
-- not a promise about physical pages, indexes, WAL, or PostgreSQL dead tuples.
-- One trusted SQL clock reader, with no caller-provided override. A monotonic
-- UTC-day checkpoint fences operation admission after clock regressions.
CREATE FUNCTION engineo_planner_view_current_utc_day() RETURNS date LANGUAGE sql VOLATILE
SET search_path = pg_catalog AS $$
  SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date
$$;

CREATE FUNCTION engineo_planner_view_counter_hash(
  scope text, config_bytes bigint, config_count bigint,
  receipt_bytes bigint, receipt_count bigint, rate_bytes bigint,
  rate_count bigint, audit_admissions bigint, scope_bytes bigint DEFAULT 0, scope_count bigint DEFAULT 0,
  operation_window_high_water date DEFAULT DATE '0001-01-01'
) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(concat_ws(':', scope, config_bytes, config_count,
    receipt_bytes, receipt_count, rate_bytes, rate_count, audit_admissions, scope_bytes, scope_count,
    operation_window_high_water - DATE '0001-01-01'), 'UTF8')), 'hex')
$$;

CREATE TABLE project_planner_views (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  view_revision bigint NOT NULL CHECK (view_revision BETWEEN 1 AND 9007199254740991),
  protocol_version integer NOT NULL DEFAULT 1 CHECK (protocol_version = 1),
  projection_version integer NOT NULL DEFAULT 1 CHECK (projection_version = 1),
  normalization_version integer NOT NULL DEFAULT 1 CHECK (normalization_version = 1),
  config_json text NOT NULL CHECK (octet_length(config_json) BETWEEN 1 AND 8192),
  config_hash_sha256 text NOT NULL CHECK (config_hash_sha256 ~ '^[a-f0-9]{64}$'),
  byte_count bigint GENERATED ALWAYS AS (octet_length(config_json)::bigint) STORED,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  PRIMARY KEY (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE RESTRICT,
  CHECK (config_hash_sha256 = encode(sha256(convert_to(
    '{"kind":"engineo-planner-view-v1-canonical","projectionVersion":1,"normalizationVersion":1,"configuration":' || config_json || '}', 'UTF8')), 'hex')),
  CHECK ((jsonb_typeof(config_json::jsonb) = 'object' AND
    config_json::jsonb->>'schemaVersion' = '1' AND
    config_json::jsonb->>'kind' = 'engineo-planner-view' AND
    config_json::jsonb->>'visibility' = 'private' AND
    jsonb_typeof(config_json::jsonb->'name') = 'string' AND
    jsonb_typeof(config_json::jsonb->'presentation') = 'object') IS TRUE),
  CHECK (isfinite(created_at) AND isfinite(updated_at) AND updated_at >= created_at)
);
CREATE INDEX project_planner_views_owner_list_idx ON project_planner_views
  (organization_id, project_id, owner_user_id, ((config_json::jsonb->>'name') COLLATE "C"), id);

CREATE TABLE planner_view_operations (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  operation_window_id date NOT NULL CHECK (operation_window_id BETWEEN DATE '0001-01-01' AND DATE '9999-12-29'),
  operation_id uuid NOT NULL,
  creator_session_id uuid NOT NULL,
  request_hash_sha256 text NOT NULL CHECK (request_hash_sha256 ~ '^[a-f0-9]{64}$'),
  reviewed_digest text NOT NULL CHECK (reviewed_digest ~ '^[a-f0-9]{64}$'),
  operation text NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  outcome text NOT NULL CHECK (outcome IN ('applied', 'no_op', 'deleted')),
  view_id uuid NOT NULL,
  previous_view_revision bigint NOT NULL CHECK (previous_view_revision BETWEEN 0 AND 9007199254740991),
  committed_view_revision bigint CHECK (committed_view_revision BETWEEN 1 AND 9007199254740991),
  base_config_hash_sha256 text CHECK (base_config_hash_sha256 ~ '^[a-f0-9]{64}$'),
  committed_config_hash_sha256 text CHECK (committed_config_hash_sha256 ~ '^[a-f0-9]{64}$'),
  observed_schedule_revision bigint NOT NULL CHECK (observed_schedule_revision BETWEEN 1 AND 9007199254740991),
  audit_event_id uuid NOT NULL,
  receipt_json text NOT NULL CHECK (octet_length(receipt_json) BETWEEN 1 AND 2048),
  receipt_hash_sha256 text NOT NULL CHECK (receipt_hash_sha256 ~ '^[a-f0-9]{64}$'),
  byte_count bigint GENERATED ALWAYS AS (octet_length(receipt_json)::bigint) STORED,
  recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  keep_until timestamptz NOT NULL,
  PRIMARY KEY (organization_id, project_id, actor_id, operation_window_id, operation_id),
  UNIQUE (audit_event_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id, creator_session_id) REFERENCES auth_sessions(user_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, project_id, audit_event_id)
    REFERENCES audit_events(organization_id, resource_id, id) ON DELETE RESTRICT,
  CHECK (receipt_hash_sha256 = encode(sha256(convert_to(receipt_json, 'UTF8')), 'hex')),
  CHECK ((jsonb_typeof(receipt_json::jsonb) = 'object') IS TRUE),
  CHECK (isfinite(recorded_at) AND isfinite(keep_until) AND
    recorded_at >= (operation_window_id::timestamp AT TIME ZONE 'UTC') AND
    recorded_at < ((operation_window_id + 1)::timestamp AT TIME ZONE 'UTC') AND
    keep_until = ((operation_window_id + 2)::timestamp AT TIME ZONE 'UTC') AND
    keep_until <= recorded_at + interval '48 hours'),
  -- Every nullable material-state branch must be a definite TRUE, never UNKNOWN.
  CHECK (((operation = 'create' AND outcome = 'applied' AND previous_view_revision = 0 AND
      base_config_hash_sha256 IS NULL AND committed_view_revision = 1 AND committed_config_hash_sha256 IS NOT NULL)
    OR (operation = 'update' AND previous_view_revision >= 1 AND base_config_hash_sha256 IS NOT NULL AND
      committed_view_revision IS NOT NULL AND committed_config_hash_sha256 IS NOT NULL AND
      ((outcome = 'applied' AND committed_view_revision = previous_view_revision + 1 AND
          committed_config_hash_sha256 <> base_config_hash_sha256)
        OR (outcome = 'no_op' AND committed_view_revision = previous_view_revision AND
          committed_config_hash_sha256 = base_config_hash_sha256)))
    OR (operation = 'delete' AND outcome = 'deleted' AND previous_view_revision >= 1 AND
      base_config_hash_sha256 IS NOT NULL AND committed_view_revision IS NULL AND committed_config_hash_sha256 IS NULL)) IS TRUE)
);
CREATE INDEX planner_view_operations_retention_idx ON planner_view_operations
  (keep_until, organization_id, project_id, actor_id, operation_window_id, operation_id);
CREATE INDEX planner_view_operations_actor_time_idx ON planner_view_operations
  (organization_id, project_id, actor_id, recorded_at DESC);
CREATE INDEX planner_view_operations_project_time_idx ON planner_view_operations
  (organization_id, project_id, recorded_at DESC);
CREATE INDEX planner_view_apply_audit_scope_idx ON audit_events (organization_id, resource_id, id)
  WHERE action = 'view.apply';

-- Two rate records (actor/project) per bounded clock bucket. There is no
-- process-local limiter, retained request list, or permanent per-actor tombstone.
CREATE TABLE planner_view_rate_limits (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  actor_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  subject_key text GENERATED ALWAYS AS (coalesce(actor_id::text, 'project')) STORED,
  rate_class text NOT NULL CHECK (rate_class IN ('read', 'write')),
  bucket_start timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 600),
  byte_count bigint GENERATED ALWAYS AS (256::bigint) STORED,
  PRIMARY KEY (organization_id, project_id, rate_class, subject_key, bucket_start),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE RESTRICT,
  CHECK (isfinite(bucket_start) AND isfinite(expires_at) AND
    ((rate_class = 'read' AND bucket_start = date_trunc('minute', bucket_start, 'UTC') AND
      expires_at = bucket_start + interval '1 minute') OR
    (rate_class = 'write' AND bucket_start = date_trunc('hour', bucket_start, 'UTC') AND
      expires_at = bucket_start + interval '1 hour')))
);
CREATE INDEX planner_view_rate_limits_retention_idx ON planner_view_rate_limits
  (expires_at, organization_id, project_id, rate_class, subject_key, bucket_start);

CREATE TABLE planner_view_storage_budget (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  operation_window_high_water date NOT NULL
    CHECK (operation_window_high_water BETWEEN DATE '0001-01-01' AND DATE '9999-12-29'),
  scope_bytes bigint NOT NULL DEFAULT 0 CHECK (scope_bytes BETWEEN 0 AND 8388608),
  scope_count bigint NOT NULL DEFAULT 0 CHECK (scope_count BETWEEN 0 AND 32768),
  CHECK (scope_bytes = scope_count * 256),
  config_bytes bigint NOT NULL DEFAULT 0 CHECK (config_bytes BETWEEN 0 AND 67108864),
  config_count bigint NOT NULL DEFAULT 0 CHECK (config_count BETWEEN 0 AND 100000),
  receipt_bytes bigint NOT NULL DEFAULT 0 CHECK (receipt_bytes BETWEEN 0 AND 134217728),
  receipt_count bigint NOT NULL DEFAULT 0 CHECK (receipt_count BETWEEN 0 AND 100000),
  rate_bytes bigint NOT NULL DEFAULT 0 CHECK (rate_bytes BETWEEN 0 AND 8388608),
  rate_count bigint NOT NULL DEFAULT 0 CHECK (rate_count BETWEEN 0 AND 32768),
  audit_admissions bigint NOT NULL DEFAULT 0 CHECK (audit_admissions BETWEEN 0 AND 100000),
  state_hash_sha256 text NOT NULL CHECK (state_hash_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (config_bytes + receipt_bytes + rate_bytes + scope_bytes <= 134217728),
  CHECK (rate_bytes = rate_count * 256)
);
-- One stable transaction clock sample seeds both checkpoint and integrity hash.
WITH stamp AS MATERIALIZED (SELECT (transaction_timestamp() AT TIME ZONE 'UTC')::date AS utc_day)
INSERT INTO planner_view_storage_budget (operation_window_high_water, state_hash_sha256)
  SELECT utc_day, engineo_planner_view_counter_hash('global', 0, 0, 0, 0, 0, 0, 0, 0, 0, utc_day) FROM stamp;
CREATE TABLE planner_view_project_storage (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  config_bytes bigint NOT NULL DEFAULT 0 CHECK (config_bytes BETWEEN 0 AND 1048576),
  config_count bigint NOT NULL DEFAULT 0 CHECK (config_count BETWEEN 0 AND 128),
  receipt_bytes bigint NOT NULL DEFAULT 0 CHECK (receipt_bytes BETWEEN 0 AND 4194304),
  receipt_count bigint NOT NULL DEFAULT 0 CHECK (receipt_count BETWEEN 0 AND 100000),
  rate_bytes bigint NOT NULL DEFAULT 0 CHECK (rate_bytes BETWEEN 0 AND 262144),
  rate_count bigint NOT NULL DEFAULT 0 CHECK (rate_count BETWEEN 0 AND 1024),
  audit_admissions bigint NOT NULL DEFAULT 0 CHECK (audit_admissions BETWEEN 0 AND 100000),
  state_hash_sha256 text NOT NULL CHECK (state_hash_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (organization_id, project_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE RESTRICT,
  CHECK (config_bytes + receipt_bytes + rate_bytes + 256 <= 4194304),
  CHECK (rate_bytes = rate_count * 256)
);

-- Counter transitions are accepted only from the named accounting call stack at
-- the exact trigger depth. A settable GUC alone is never an authority. The hash
-- is non-secret corruption evidence, not an authorization token/signature.
CREATE FUNCTION engineo_protect_planner_view_counter() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE scope text; transition jsonb; call_context text; d bigint[]; sb bigint := 0; sc bigint := 0; scope_changed boolean := false;
  hw date := DATE '0001-01-01'; old_hw date := DATE '0001-01-01'; clock_changed boolean := false;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'view counters cannot be reset' USING ERRCODE = 'P0003';
  END IF;
  GET DIAGNOSTICS call_context = PG_CONTEXT;
  IF TG_TABLE_NAME = 'planner_view_storage_budget' THEN
    scope := 'global'; sb := NEW.scope_bytes; sc := NEW.scope_count;
    hw := NEW.operation_window_high_water; old_hw := OLD.operation_window_high_water;
    clock_changed := hw IS DISTINCT FROM old_hw;
    scope_changed := NEW.scope_bytes IS DISTINCT FROM OLD.scope_bytes OR NEW.scope_count IS DISTINCT FROM OLD.scope_count;
    IF TG_OP <> 'UPDATE' OR NEW.singleton IS DISTINCT FROM OLD.singleton THEN
      RAISE EXCEPTION 'view global counter scope invalid' USING ERRCODE = 'P0003';
    END IF;
  ELSE
    scope := NEW.organization_id::text || '/' || NEW.project_id::text;
    IF TG_OP = 'UPDATE' AND (NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
      NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
      RAISE EXCEPTION 'view project counter scope invalid' USING ERRCODE = 'P0003';
    END IF;
  END IF;
  transition := nullif(current_setting('engineo.planner_view_counter_transition', true), '')::jsonb;
  IF TG_TABLE_NAME = 'planner_view_storage_budget' AND TG_OP = 'UPDATE' AND
    transition->>'kind' = 'clock' THEN
    IF pg_trigger_depth() NOT IN (1, 2) OR position('engineo_planner_view_lock_storage(' IN call_context) = 0 OR
      OLD.state_hash_sha256 IS DISTINCT FROM engineo_planner_view_counter_hash('global', OLD.config_bytes,
        OLD.config_count, OLD.receipt_bytes, OLD.receipt_count, OLD.rate_bytes, OLD.rate_count,
        OLD.audit_admissions, OLD.scope_bytes, OLD.scope_count, old_hw) OR
      hw IS DISTINCT FROM engineo_planner_view_current_utc_day() OR hw <= old_hw OR
      transition->>'utcDay' IS DISTINCT FROM hw::text OR scope_changed OR
      NEW.config_bytes <> OLD.config_bytes OR NEW.config_count <> OLD.config_count OR
      NEW.receipt_bytes <> OLD.receipt_bytes OR NEW.receipt_count <> OLD.receipt_count OR
      NEW.rate_bytes <> OLD.rate_bytes OR NEW.rate_count <> OLD.rate_count OR NEW.audit_admissions <> OLD.audit_admissions THEN
      RAISE EXCEPTION 'view clock checkpoint transition invalid' USING ERRCODE = 'P0003';
    END IF;
    NEW.state_hash_sha256 := engineo_planner_view_counter_hash('global', NEW.config_bytes, NEW.config_count,
      NEW.receipt_bytes, NEW.receipt_count, NEW.rate_bytes, NEW.rate_count, NEW.audit_admissions, sb, sc, hw);
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'planner_view_storage_budget' AND TG_OP = 'UPDATE' AND
    transition->>'kind' = 'scope' THEN
    IF pg_trigger_depth() NOT IN (1, 2) OR position('engineo_planner_view_lock_storage(' IN call_context) = 0 OR
      OLD.state_hash_sha256 IS DISTINCT FROM engineo_planner_view_counter_hash('global', OLD.config_bytes,
        OLD.config_count, OLD.receipt_bytes, OLD.receipt_count, OLD.rate_bytes, OLD.rate_count,
        OLD.audit_admissions, OLD.scope_bytes, OLD.scope_count, old_hw) OR
      NEW.scope_bytes <> OLD.scope_bytes + 256 OR NEW.scope_count <> OLD.scope_count + 1 OR clock_changed OR
      NEW.config_bytes <> OLD.config_bytes OR NEW.config_count <> OLD.config_count OR
      NEW.receipt_bytes <> OLD.receipt_bytes OR NEW.receipt_count <> OLD.receipt_count OR
      NEW.rate_bytes <> OLD.rate_bytes OR NEW.rate_count <> OLD.rate_count OR NEW.audit_admissions <> OLD.audit_admissions OR
      EXISTS (SELECT 1 FROM planner_view_project_storage
        WHERE organization_id = (transition->>'organizationId')::uuid AND project_id = (transition->>'projectId')::uuid) THEN
      RAISE EXCEPTION 'view scope accounting transition invalid' USING ERRCODE = 'P0003';
    END IF;
    NEW.state_hash_sha256 := engineo_planner_view_counter_hash('global', NEW.config_bytes, NEW.config_count,
      NEW.receipt_bytes, NEW.receipt_count, NEW.rate_bytes, NEW.rate_count, NEW.audit_admissions, sb, sc, hw);
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF pg_trigger_depth() NOT IN (1, 2) OR
      position('engineo_planner_view_lock_storage(' IN call_context) = 0 OR
      NEW.config_bytes <> 0 OR NEW.config_count <> 0 OR NEW.receipt_bytes <> 0 OR
      NEW.receipt_count <> 0 OR NEW.rate_bytes <> 0 OR NEW.rate_count <> 0 OR NEW.audit_admissions <> 0 THEN
      RAISE EXCEPTION 'view initial counter invalid' USING ERRCODE = 'P0003';
    END IF;
  ELSE
    IF pg_trigger_depth() <> 2 OR position('engineo_planner_view_adjust_budget(' IN call_context) = 0 THEN
      RAISE EXCEPTION 'view counters are accounting-trigger managed' USING ERRCODE = 'P0003';
    END IF;
    transition := nullif(current_setting('engineo.planner_view_counter_transition', true), '')::jsonb;
    IF transition IS NULL OR transition->>'organizationId' IS NULL OR transition->>'projectId' IS NULL OR
      (scope <> 'global' AND scope <> ((transition->>'organizationId') || '/' || (transition->>'projectId'))) THEN
      RAISE EXCEPTION 'view counter transition scope invalid' USING ERRCODE = 'P0003';
    END IF;
    SELECT array_agg(value::bigint ORDER BY ordinality) INTO d
      FROM jsonb_array_elements_text(transition->'delta') WITH ORDINALITY;
    IF array_length(d, 1) IS DISTINCT FROM 7 OR
      OLD.state_hash_sha256 IS DISTINCT FROM engineo_planner_view_counter_hash(scope,
        OLD.config_bytes, OLD.config_count, OLD.receipt_bytes, OLD.receipt_count,
        OLD.rate_bytes, OLD.rate_count, OLD.audit_admissions,
        CASE WHEN scope = 'global' THEN sb ELSE 0 END, CASE WHEN scope = 'global' THEN sc ELSE 0 END, old_hw) OR
      NEW.config_bytes <> OLD.config_bytes + d[1] OR NEW.config_count <> OLD.config_count + d[2] OR
      NEW.receipt_bytes <> OLD.receipt_bytes + d[3] OR NEW.receipt_count <> OLD.receipt_count + d[4] OR
      NEW.rate_bytes <> OLD.rate_bytes + d[5] OR NEW.rate_count <> OLD.rate_count + d[6] OR
      NEW.audit_admissions <> OLD.audit_admissions + d[7] OR d[7] NOT IN (0, 1) OR
      scope_changed OR clock_changed THEN
      RAISE EXCEPTION 'view counter drift or invalid transition' USING ERRCODE = 'P0003';
    END IF;
  END IF;
  NEW.state_hash_sha256 := engineo_planner_view_counter_hash(scope,
    NEW.config_bytes, NEW.config_count, NEW.receipt_bytes, NEW.receipt_count,
    NEW.rate_bytes, NEW.rate_count, NEW.audit_admissions, sb, sc, hw);
  RETURN NEW;
END;
$$;
CREATE TRIGGER planner_view_global_counter_managed BEFORE INSERT OR UPDATE OR DELETE ON planner_view_storage_budget
  FOR EACH ROW EXECUTE FUNCTION engineo_protect_planner_view_counter();
CREATE TRIGGER planner_view_global_counter_no_truncate BEFORE TRUNCATE ON planner_view_storage_budget
  FOR EACH STATEMENT EXECUTE FUNCTION engineo_protect_planner_view_counter();
CREATE TRIGGER planner_view_project_counter_managed BEFORE INSERT OR UPDATE OR DELETE ON planner_view_project_storage
  FOR EACH ROW EXECUTE FUNCTION engineo_protect_planner_view_counter();
CREATE TRIGGER planner_view_project_counter_no_truncate BEFORE TRUNCATE ON planner_view_project_storage
  FOR EACH STATEMENT EXECUTE FUNCTION engineo_protect_planner_view_counter();

-- API admission calls this after live authorization locks and before view or
-- operation row locks. Accounting triggers also call it defensively. No SUM of
-- retained history is needed: immutable allocations + guarded deltas are exact.
CREATE FUNCTION engineo_planner_view_lock_storage(org uuid, project uuid) RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE g planner_view_storage_budget%ROWTYPE; p planner_view_project_storage%ROWTYPE; prior text; today date;
BEGIN
  IF (org IS NULL) <> (project IS NULL) THEN
    RAISE EXCEPTION 'view storage scope invalid' USING ERRCODE = 'P0003';
  END IF;
  SELECT * INTO g FROM planner_view_storage_budget WHERE singleton FOR UPDATE;
  IF NOT FOUND OR g.state_hash_sha256 IS DISTINCT FROM engineo_planner_view_counter_hash('global',
    g.config_bytes, g.config_count, g.receipt_bytes, g.receipt_count, g.rate_bytes, g.rate_count, g.audit_admissions, g.scope_bytes, g.scope_count, g.operation_window_high_water) THEN
    RAISE EXCEPTION 'view global storage accounting invalid' USING ERRCODE = 'P0003';
  END IF;
  today := engineo_planner_view_current_utc_day();
  IF today IS NULL OR NOT isfinite(today) OR today NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-29' THEN
    RAISE EXCEPTION 'view operation clock invalid' USING ERRCODE = 'P0003';
  END IF;
  IF today < g.operation_window_high_water THEN
    RAISE EXCEPTION 'view operation clock regressed' USING ERRCODE = 'P0003';
  ELSIF today > g.operation_window_high_water THEN
    prior := current_setting('engineo.planner_view_counter_transition', true);
    PERFORM set_config('engineo.planner_view_counter_transition', jsonb_build_object('kind', 'clock', 'utcDay', today::text)::text, true);
    UPDATE planner_view_storage_budget SET operation_window_high_water = today WHERE singleton RETURNING * INTO g;
    PERFORM set_config('engineo.planner_view_counter_transition', coalesce(prior, ''), true);
  END IF;
  -- Privileged maintenance uses a global-only clock/accounting lock before its
  -- bounded candidate probes; it initializes no phantom project scope.
  IF org IS NULL THEN RETURN; END IF;
  SELECT * INTO p FROM planner_view_project_storage WHERE organization_id = org AND project_id = project FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM project_planner_views WHERE organization_id = org AND project_id = project) OR
      EXISTS (SELECT 1 FROM planner_view_operations WHERE organization_id = org AND project_id = project) OR
      EXISTS (SELECT 1 FROM planner_view_rate_limits WHERE organization_id = org AND project_id = project) OR
      EXISTS (SELECT 1 FROM audit_events WHERE organization_id = org AND resource_id = project AND action = 'view.apply') THEN
      RAISE EXCEPTION 'view project counter missing for retained data' USING ERRCODE = 'P0003';
    END IF;
    -- Budget scopes themselves are permanent protected state and must also be
    -- bounded/charged; read-only traffic cannot create immortal free rows.
    IF g.scope_count >= 32768 OR g.config_bytes + g.receipt_bytes + g.rate_bytes + g.scope_bytes + 256 > 134217728 THEN
      RAISE EXCEPTION 'view scope capacity' USING ERRCODE = 'P0002';
    END IF;
    prior := current_setting('engineo.planner_view_counter_transition', true);
    PERFORM set_config('engineo.planner_view_counter_transition', jsonb_build_object('kind', 'scope',
      'organizationId', org::text, 'projectId', project::text)::text, true);
    UPDATE planner_view_storage_budget SET scope_bytes = scope_bytes + 256, scope_count = scope_count + 1 WHERE singleton;
    INSERT INTO planner_view_project_storage (organization_id, project_id, state_hash_sha256)
      VALUES (org, project, engineo_planner_view_counter_hash(org::text || '/' || project::text, 0, 0, 0, 0, 0, 0, 0));
    PERFORM set_config('engineo.planner_view_counter_transition', coalesce(prior, ''), true);
    SELECT * INTO STRICT p FROM planner_view_project_storage WHERE organization_id = org AND project_id = project FOR UPDATE;
  END IF;
  IF p.state_hash_sha256 IS DISTINCT FROM engineo_planner_view_counter_hash(org::text || '/' || project::text,
    p.config_bytes, p.config_count, p.receipt_bytes, p.receipt_count, p.rate_bytes, p.rate_count, p.audit_admissions) OR
    p.config_bytes > g.config_bytes OR p.config_count > g.config_count OR
    p.receipt_bytes > g.receipt_bytes OR p.receipt_count > g.receipt_count OR
    p.rate_bytes > g.rate_bytes OR p.rate_count > g.rate_count OR p.audit_admissions > g.audit_admissions THEN
    RAISE EXCEPTION 'view project storage accounting invalid' USING ERRCODE = 'P0003';
  END IF;
END;
$$;

CREATE FUNCTION engineo_planner_view_adjust_budget(org uuid, project uuid,
  cb bigint, cc bigint, rb bigint, rc bigint, lb bigint, lc bigint, aa bigint
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE call_context text; prior text;
BEGIN
  GET DIAGNOSTICS call_context = PG_CONTEXT;
  IF pg_trigger_depth() <> 1 OR
    (position('engineo_planner_view_record_budget()' IN call_context) = 0 AND
     position('engineo_planner_view_operation_guard()' IN call_context) = 0 AND
     position('engineo_planner_view_rate_guard()' IN call_context) = 0 AND
     position('engineo_planner_view_audit_admission()' IN call_context) = 0) OR
    aa NOT IN (0, 1) OR abs(cb) > 8192 OR abs(cc) > 1 OR abs(rb) > 2048 OR abs(rc) > 1 OR
    abs(lb) > 256 OR abs(lc) > 1 THEN
    RAISE EXCEPTION 'view accounting writer invalid' USING ERRCODE = 'P0003';
  END IF;
  PERFORM engineo_planner_view_lock_storage(org, project);
  IF EXISTS (SELECT 1 FROM planner_view_storage_budget WHERE singleton AND
      (config_bytes + cb < 0 OR config_count + cc < 0 OR receipt_bytes + rb < 0 OR receipt_count + rc < 0 OR
       rate_bytes + lb < 0 OR rate_count + lc < 0)) OR
    EXISTS (SELECT 1 FROM planner_view_project_storage WHERE organization_id = org AND project_id = project AND
      (config_bytes + cb < 0 OR config_count + cc < 0 OR receipt_bytes + rb < 0 OR receipt_count + rc < 0 OR
       rate_bytes + lb < 0 OR rate_count + lc < 0)) THEN
    RAISE EXCEPTION 'view accounting underflow' USING ERRCODE = 'P0003';
  END IF;
  IF EXISTS (SELECT 1 FROM planner_view_storage_budget WHERE singleton AND
      (config_bytes + cb > 67108864 OR config_count + cc > 100000 OR receipt_count + rc > 100000 OR
       rate_count + lc > 32768 OR audit_admissions + aa > 100000 OR
       config_bytes + cb + receipt_bytes + rb + rate_bytes + lb + scope_bytes > 134217728)) OR
    EXISTS (SELECT 1 FROM planner_view_project_storage WHERE organization_id = org AND project_id = project AND
      (config_bytes + cb > 1048576 OR config_count + cc > 128 OR receipt_count + rc > 100000 OR
       rate_count + lc > 1024 OR audit_admissions + aa > 100000 OR
       config_bytes + cb + receipt_bytes + rb + rate_bytes + lb + 256 > 4194304)) THEN
    RAISE EXCEPTION 'view capacity' USING ERRCODE = 'P0002';
  END IF;
  prior := current_setting('engineo.planner_view_counter_transition', true);
  PERFORM set_config('engineo.planner_view_counter_transition', jsonb_build_object(
    'organizationId', org::text, 'projectId', project::text, 'delta', jsonb_build_array(cb, cc, rb, rc, lb, lc, aa))::text, true);
  UPDATE planner_view_storage_budget SET config_bytes = config_bytes + cb, config_count = config_count + cc,
    receipt_bytes = receipt_bytes + rb, receipt_count = receipt_count + rc,
    rate_bytes = rate_bytes + lb, rate_count = rate_count + lc, audit_admissions = audit_admissions + aa WHERE singleton;
  UPDATE planner_view_project_storage SET config_bytes = config_bytes + cb, config_count = config_count + cc,
    receipt_bytes = receipt_bytes + rb, receipt_count = receipt_count + rc,
    rate_bytes = rate_bytes + lb, rate_count = rate_count + lc, audit_admissions = audit_admissions + aa
    WHERE organization_id = org AND project_id = project;
  PERFORM set_config('engineo.planner_view_counter_transition', coalesce(prior, ''), true);
END;
$$;

CREATE FUNCTION engineo_planner_view_record_budget() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE owned_count integer; delta_bytes bigint; org uuid; project uuid;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'view records cannot be truncated' USING ERRCODE = 'P0003'; END IF;
  org := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  project := CASE WHEN TG_OP = 'DELETE' THEN OLD.project_id ELSE NEW.project_id END;
  PERFORM engineo_planner_view_lock_storage(org, project);
  IF TG_OP = 'INSERT' THEN
    IF NEW.view_revision <> 1 THEN RAISE EXCEPTION 'view create revision invalid' USING ERRCODE = '23514'; END IF;
    -- The owner index makes this a bounded <=21-row probe, not an unbounded count.
    SELECT count(*) INTO owned_count FROM (SELECT 1 FROM project_planner_views
      WHERE organization_id = org AND project_id = project AND owner_user_id = NEW.owner_user_id LIMIT 21) owned;
    IF owned_count >= 20 THEN RAISE EXCEPTION 'view actor capacity' USING ERRCODE = 'P0002'; END IF;
    PERFORM engineo_planner_view_adjust_budget(org, project, octet_length(NEW.config_json)::bigint, 1, 0, 0, 0, 0, 0);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR
      NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR
      NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.protocol_version <> OLD.protocol_version OR
      NEW.projection_version <> OLD.projection_version OR NEW.normalization_version <> OLD.normalization_version OR
      NEW.config_json IS NOT DISTINCT FROM OLD.config_json OR NEW.view_revision <> OLD.view_revision + 1 OR
      NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'view identity or revision transition invalid' USING ERRCODE = '23514';
    END IF;
    delta_bytes := octet_length(NEW.config_json)::bigint - OLD.byte_count;
    PERFORM engineo_planner_view_adjust_budget(org, project, delta_bytes, 0, 0, 0, 0, 0, 0);
    RETURN NEW;
  ELSE
    PERFORM engineo_planner_view_adjust_budget(org, project, -OLD.byte_count, -1, 0, 0, 0, 0, 0);
    RETURN OLD;
  END IF;
END;
$$;
CREATE TRIGGER planner_view_record_budget BEFORE INSERT OR UPDATE OR DELETE ON project_planner_views
  FOR EACH ROW EXECUTE FUNCTION engineo_planner_view_record_budget();
CREATE TRIGGER planner_view_record_no_truncate BEFORE TRUNCATE ON project_planner_views
  FOR EACH STATEMENT EXECUTE FUNCTION engineo_planner_view_record_budget();

CREATE FUNCTION engineo_planner_view_audit_admission() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE required_keys text[] := ARRAY['schemaVersion', 'kind', 'action', 'viewId', 'oldViewRevision',
  'newViewRevision', 'baseConfigHash', 'newConfigHash', 'operationWindowId', 'operationId', 'sessionId', 'observedScheduleRevision'];
BEGIN
  IF NEW.action <> 'view.apply' OR NEW.actor_type <> 'user' OR NEW.actor_id IS NULL OR NEW.source <> 'api' OR
    NEW.resource_type <> 'project' OR NEW.resource_id IS NULL OR octet_length(NEW.payload::text) > 2048 OR
    NOT (NEW.payload ?& required_keys) OR (NEW.payload - required_keys) <> '{}'::jsonb OR
    (NEW.payload->>'schemaVersion' = '1' AND NEW.payload->>'kind' = 'engineo-planner-view-change' AND
      NEW.payload->>'action' IN ('create', 'update', 'delete', 'no_op') AND
      NEW.payload->>'viewId' IS NOT NULL AND NEW.payload->>'operationId' IS NOT NULL AND
      NEW.payload->>'operationWindowId' IS NOT NULL AND NEW.payload->>'sessionId' IS NOT NULL) IS NOT TRUE THEN
    RAISE EXCEPTION 'view audit boundary invalid' USING ERRCODE = '23514';
  END IF;
  PERFORM engineo_planner_view_adjust_budget(NEW.organization_id, NEW.resource_id, 0, 0, 0, 0, 0, 0, 1);
  RETURN NEW;
END;
$$;
CREATE TRIGGER planner_view_audit_admission BEFORE INSERT ON audit_events
  FOR EACH ROW WHEN (NEW.action = 'view.apply' OR NEW.payload->>'kind' = 'engineo-planner-view-change')
  EXECUTE FUNCTION engineo_planner_view_audit_admission();

CREATE FUNCTION engineo_planner_view_rate_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE call_context text; n timestamptz; ceiling integer; maintenance jsonb;
BEGIN
  GET DIAGNOSTICS call_context = PG_CONTEXT;
  IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'view rates cannot be truncated' USING ERRCODE = 'P0003'; END IF;
  IF TG_OP = 'DELETE' THEN
    maintenance := nullif(current_setting('engineo.planner_view_maintenance_delete', true), '')::jsonb;
    IF pg_trigger_depth() <> 1 OR position('engineo_planner_view_maintain(' IN call_context) = 0 OR
      OLD.expires_at > clock_timestamp() OR maintenance IS NULL OR
      maintenance->>'kind' IS DISTINCT FROM 'rate' OR
      maintenance->>'organizationId' IS DISTINCT FROM OLD.organization_id::text OR
      maintenance->>'projectId' IS DISTINCT FROM OLD.project_id::text OR
      maintenance->>'rateClass' IS DISTINCT FROM OLD.rate_class OR
      maintenance->>'subjectKey' IS DISTINCT FROM OLD.subject_key OR
      maintenance->>'bucketStart' IS DISTINCT FROM OLD.bucket_start::text THEN
      RAISE EXCEPTION 'view rate deletion requires expired maintenance' USING ERRCODE = '23514';
    END IF;
    PERFORM engineo_planner_view_adjust_budget(OLD.organization_id, OLD.project_id, 0, 0, 0, 0, -256, -1, 0);
    RETURN OLD;
  END IF;
  IF pg_trigger_depth() <> 1 OR position('engineo_planner_view_charge_rate(' IN call_context) = 0 THEN
    RAISE EXCEPTION 'view rates are admission-function managed' USING ERRCODE = 'P0003';
  END IF;
  n := clock_timestamp();
  ceiling := CASE WHEN NEW.rate_class = 'read' THEN CASE WHEN NEW.actor_id IS NULL THEN 600 ELSE 120 END
    ELSE CASE WHEN NEW.actor_id IS NULL THEN 300 ELSE 60 END END;
  IF NEW.bucket_start > n OR NEW.expires_at <= n OR NEW.attempts > ceiling THEN
    RAISE EXCEPTION 'view rate limit' USING ERRCODE = 'P0004';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.attempts <> 1 THEN RAISE EXCEPTION 'view initial rate invalid' USING ERRCODE = 'P0003'; END IF;
    PERFORM engineo_planner_view_adjust_budget(NEW.organization_id, NEW.project_id, 0, 0, 0, 0, 256, 1, 0);
  ELSIF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR
    NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.rate_class IS DISTINCT FROM OLD.rate_class OR
    NEW.bucket_start IS DISTINCT FROM OLD.bucket_start OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
    NEW.attempts <> OLD.attempts + 1 THEN
    RAISE EXCEPTION 'view rate transition invalid' USING ERRCODE = 'P0003';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER planner_view_rate_managed BEFORE INSERT OR UPDATE OR DELETE ON planner_view_rate_limits
  FOR EACH ROW EXECUTE FUNCTION engineo_planner_view_rate_guard();
CREATE TRIGGER planner_view_rate_no_truncate BEFORE TRUNCATE ON planner_view_rate_limits
  FOR EACH STATEMENT EXECUTE FUNCTION engineo_planner_view_rate_guard();

CREATE FUNCTION engineo_planner_view_charge_rate(org uuid, project uuid, actor uuid, class text)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE bucket timestamptz; expiry timestamptz; subject uuid; index integer;
BEGIN
  IF actor IS NULL OR class NOT IN ('read', 'write') THEN
    RAISE EXCEPTION 'view rate scope invalid' USING ERRCODE = 'P0003';
  END IF;
  PERFORM engineo_planner_view_lock_storage(org, project);
  bucket := date_trunc(CASE WHEN class = 'read' THEN 'minute' ELSE 'hour' END, clock_timestamp(), 'UTC');
  expiry := bucket + CASE WHEN class = 'read' THEN interval '1 minute' ELSE interval '1 hour' END;
  -- Project then actor, both under global/project accounting admission locks.
  FOR index IN 1..2 LOOP
    subject := CASE WHEN index = 1 THEN NULL ELSE actor END;
    UPDATE planner_view_rate_limits SET attempts = attempts + 1
      WHERE organization_id = org AND project_id = project AND actor_id IS NOT DISTINCT FROM subject
        AND rate_class = class AND bucket_start = bucket;
    IF NOT FOUND THEN
      INSERT INTO planner_view_rate_limits(organization_id, project_id, actor_id, rate_class, bucket_start, expires_at, attempts)
        VALUES (org, project, subject, class, bucket, expiry, 1);
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION engineo_planner_view_operation_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE call_context text; maintenance jsonb; receipt jsonb; audit audit_events%ROWTYPE;
  session auth_sessions%ROWTYPE; view_record project_planner_views%ROWTYPE;
  expected_action text; now_at timestamptz; required_keys text[] := ARRAY[
    'schemaVersion', 'kind', 'protocolVersion', 'projectionVersion', 'normalizationVersion',
    'organizationId', 'projectId', 'actorId', 'sessionId', 'operationWindowId', 'operationId',
    'viewId', 'action', 'outcome', 'previousViewRevision', 'committedViewRevision',
    'baseConfigHash', 'desiredConfigHash', 'expectedScheduleRevision', 'reviewedDigest', 'auditId', 'recordedAt'];
BEGIN
  IF TG_OP IN ('UPDATE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'view operation receipts are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    GET DIAGNOSTICS call_context = PG_CONTEXT;
    maintenance := nullif(current_setting('engineo.planner_view_maintenance_delete', true), '')::jsonb;
    IF pg_trigger_depth() <> 1 OR position('engineo_planner_view_maintain(' IN call_context) = 0 OR
      OLD.keep_until > clock_timestamp() OR maintenance IS NULL OR
      maintenance->>'kind' IS DISTINCT FROM 'operation' OR
      maintenance->>'organizationId' IS DISTINCT FROM OLD.organization_id::text OR
      maintenance->>'projectId' IS DISTINCT FROM OLD.project_id::text OR
      maintenance->>'actorId' IS DISTINCT FROM OLD.actor_id::text OR
      maintenance->>'operationWindowId' IS DISTINCT FROM OLD.operation_window_id::text OR
      maintenance->>'operationId' IS DISTINCT FROM OLD.operation_id::text THEN
      RAISE EXCEPTION 'view receipts remain immutable until privileged horizon maintenance' USING ERRCODE = '23514';
    END IF;
    PERFORM engineo_planner_view_adjust_budget(OLD.organization_id, OLD.project_id, 0, 0, -OLD.byte_count, -1, 0, 0, 0);
    RETURN OLD;
  END IF;
  now_at := clock_timestamp();
  IF NEW.operation_window_id IS DISTINCT FROM (now_at AT TIME ZONE 'UTC')::date OR
    NEW.recorded_at > now_at OR NEW.keep_until IS DISTINCT FROM ((NEW.operation_window_id + 2)::timestamp AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'view operation window is closed or invalid' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO STRICT session FROM auth_sessions WHERE user_id = NEW.actor_id AND id = NEW.creator_session_id;
  IF session.revoked_at IS NOT NULL OR session.expires_at <= now_at OR date_trunc('milliseconds', session.created_at) > NEW.recorded_at THEN
    RAISE EXCEPTION 'view operation session boundary invalid' USING ERRCODE = '23514';
  END IF;
  receipt := NEW.receipt_json::jsonb;
  IF NOT (receipt ?& required_keys) OR (receipt - required_keys) <> '{}'::jsonb OR
    receipt->>'schemaVersion' IS DISTINCT FROM '1' OR
    receipt->>'kind' IS DISTINCT FROM 'engineo-planner-view-receipt' OR
    receipt->>'protocolVersion' IS DISTINCT FROM '1' OR receipt->>'projectionVersion' IS DISTINCT FROM '1' OR
    receipt->>'normalizationVersion' IS DISTINCT FROM '1' OR
    receipt->>'organizationId' IS DISTINCT FROM NEW.organization_id::text OR
    receipt->>'projectId' IS DISTINCT FROM NEW.project_id::text OR
    receipt->>'actorId' IS DISTINCT FROM NEW.actor_id::text OR
    receipt->>'sessionId' IS DISTINCT FROM NEW.creator_session_id::text OR
    receipt->>'operationWindowId' IS DISTINCT FROM NEW.operation_window_id::text OR
    receipt->>'operationId' IS DISTINCT FROM NEW.operation_id::text OR
    receipt->>'viewId' IS DISTINCT FROM NEW.view_id::text OR
    receipt->>'action' IS DISTINCT FROM NEW.operation OR receipt->>'outcome' IS DISTINCT FROM NEW.outcome OR
    receipt->>'previousViewRevision' IS DISTINCT FROM NEW.previous_view_revision::text OR
    receipt->>'committedViewRevision' IS DISTINCT FROM NEW.committed_view_revision::text OR
    receipt->>'baseConfigHash' IS DISTINCT FROM NEW.base_config_hash_sha256 OR
    receipt->>'desiredConfigHash' IS DISTINCT FROM NEW.committed_config_hash_sha256 OR
    receipt->>'expectedScheduleRevision' IS DISTINCT FROM NEW.observed_schedule_revision::text OR
    receipt->>'reviewedDigest' IS DISTINCT FROM NEW.reviewed_digest OR
    receipt->>'auditId' IS DISTINCT FROM NEW.audit_event_id::text OR
    receipt->>'recordedAt' IS NULL OR (receipt->>'recordedAt')::timestamptz IS DISTINCT FROM NEW.recorded_at THEN
    RAISE EXCEPTION 'view receipt boundary invalid' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO STRICT audit FROM audit_events WHERE organization_id = NEW.organization_id
    AND resource_id = NEW.project_id AND id = NEW.audit_event_id;
  expected_action := CASE WHEN NEW.outcome = 'no_op' THEN 'no_op' ELSE NEW.operation END;
  IF audit.actor_id IS DISTINCT FROM NEW.actor_id OR audit.actor_type <> 'user' OR audit.action <> 'view.apply' OR
    audit.source <> 'api' OR audit.resource_type <> 'project' OR
    audit.payload->>'schemaVersion' IS DISTINCT FROM '1' OR
    audit.payload->>'kind' IS DISTINCT FROM 'engineo-planner-view-change' OR
    audit.payload->>'action' IS DISTINCT FROM expected_action OR
    audit.payload->>'viewId' IS DISTINCT FROM NEW.view_id::text OR
    audit.payload->>'oldViewRevision' IS DISTINCT FROM NEW.previous_view_revision::text OR
    audit.payload->>'newViewRevision' IS DISTINCT FROM NEW.committed_view_revision::text OR
    audit.payload->>'baseConfigHash' IS DISTINCT FROM NEW.base_config_hash_sha256 OR
    audit.payload->>'newConfigHash' IS DISTINCT FROM NEW.committed_config_hash_sha256 OR
    audit.payload->>'sessionId' IS DISTINCT FROM NEW.creator_session_id::text OR
    audit.payload->>'operationWindowId' IS DISTINCT FROM NEW.operation_window_id::text OR
    audit.payload->>'operationId' IS DISTINCT FROM NEW.operation_id::text OR
    audit.payload->>'observedScheduleRevision' IS DISTINCT FROM NEW.observed_schedule_revision::text THEN
    RAISE EXCEPTION 'view operation audit boundary invalid' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO view_record FROM project_planner_views WHERE organization_id = NEW.organization_id
    AND project_id = NEW.project_id AND id = NEW.view_id;
  IF NEW.operation = 'delete' THEN
    IF FOUND THEN RAISE EXCEPTION 'view delete material state invalid' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NOT FOUND OR view_record.owner_user_id IS DISTINCT FROM NEW.actor_id OR
      view_record.view_revision IS DISTINCT FROM NEW.committed_view_revision OR
      view_record.config_hash_sha256 IS DISTINCT FROM NEW.committed_config_hash_sha256 THEN
      RAISE EXCEPTION 'view operation material state invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  PERFORM engineo_planner_view_adjust_budget(NEW.organization_id, NEW.project_id, 0, 0,
    octet_length(NEW.receipt_json)::bigint, 1, 0, 0, 0);
  RETURN NEW;
END;
$$;
CREATE TRIGGER planner_view_operation_managed BEFORE INSERT OR UPDATE OR DELETE ON planner_view_operations
  FOR EACH ROW EXECUTE FUNCTION engineo_planner_view_operation_guard();
CREATE TRIGGER planner_view_operation_no_truncate BEFORE TRUNCATE ON planner_view_operations
  FOR EACH STATEMENT EXECUTE FUNCTION engineo_planner_view_operation_guard();

-- Explicit privileged maintenance is the sole deletion path. The cursor probes
-- at most 2*64 indexed closed-horizon candidates, admits at most 64 deletions,
-- locks accounting global->project before row locks, and skips busy rows. The
-- transaction-local row identity is checked in addition to the trusted function
-- call stack and wall-clock horizon; users cannot manufacture permission by GUC.
CREATE FUNCTION engineo_planner_view_maintain(batch_limit integer DEFAULT 64)
RETURNS TABLE (removed_operations integer, removed_rate_rows integer) LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE candidate record; claimed record; prior text; now_at timestamptz;
  global_state planner_view_storage_budget%ROWTYPE;
BEGIN
  IF batch_limit IS NULL OR batch_limit NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'view maintenance batch must be 1..64' USING ERRCODE = '22023';
  END IF;
  PERFORM engineo_planner_view_lock_storage(NULL, NULL);
  SELECT * INTO global_state FROM planner_view_storage_budget WHERE singleton FOR UPDATE;
  IF NOT FOUND OR global_state.state_hash_sha256 IS DISTINCT FROM engineo_planner_view_counter_hash('global',
    global_state.config_bytes, global_state.config_count, global_state.receipt_bytes, global_state.receipt_count,
    global_state.rate_bytes, global_state.rate_count, global_state.audit_admissions, global_state.scope_bytes, global_state.scope_count, global_state.operation_window_high_water) THEN
    RAISE EXCEPTION 'view global storage accounting invalid' USING ERRCODE = 'P0003';
  END IF;
  removed_operations := 0; removed_rate_rows := 0; now_at := clock_timestamp();
  prior := current_setting('engineo.planner_view_maintenance_delete', true);
  FOR candidate IN
    SELECT * FROM (
      (SELECT 'operation'::text AS row_kind, keep_until AS horizon, organization_id, project_id,
        actor_id, operation_window_id, operation_id, NULL::text AS rate_class, NULL::text AS subject_key,
        NULL::timestamptz AS bucket_start FROM planner_view_operations WHERE keep_until <= now_at
        ORDER BY keep_until, organization_id, project_id, actor_id, operation_window_id, operation_id LIMIT batch_limit)
      UNION ALL
      (SELECT 'rate'::text, expires_at, organization_id, project_id, actor_id,
        NULL::date, NULL::uuid, rate_class, subject_key, bucket_start FROM planner_view_rate_limits
        WHERE expires_at <= now_at ORDER BY expires_at, organization_id, project_id, rate_class, subject_key, bucket_start LIMIT batch_limit)
    ) bounded_candidates ORDER BY horizon, row_kind, organization_id, project_id LIMIT batch_limit
  LOOP
    PERFORM engineo_planner_view_lock_storage(candidate.organization_id, candidate.project_id);
    IF candidate.row_kind = 'operation' THEN
      SELECT * INTO claimed FROM planner_view_operations WHERE organization_id = candidate.organization_id
        AND project_id = candidate.project_id AND actor_id = candidate.actor_id
        AND operation_window_id = candidate.operation_window_id AND operation_id = candidate.operation_id
        AND keep_until <= now_at FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN CONTINUE; END IF;
      PERFORM set_config('engineo.planner_view_maintenance_delete', jsonb_build_object('kind', 'operation',
        'organizationId', claimed.organization_id::text, 'projectId', claimed.project_id::text,
        'actorId', claimed.actor_id::text, 'operationWindowId', claimed.operation_window_id::text,
        'operationId', claimed.operation_id::text)::text, true);
      DELETE FROM planner_view_operations WHERE organization_id = claimed.organization_id AND project_id = claimed.project_id
        AND actor_id = claimed.actor_id AND operation_window_id = claimed.operation_window_id AND operation_id = claimed.operation_id;
      removed_operations := removed_operations + 1;
    ELSE
      SELECT * INTO claimed FROM planner_view_rate_limits WHERE organization_id = candidate.organization_id
        AND project_id = candidate.project_id AND rate_class = candidate.rate_class
        AND subject_key = candidate.subject_key AND bucket_start = candidate.bucket_start
        AND expires_at <= now_at FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN CONTINUE; END IF;
      PERFORM set_config('engineo.planner_view_maintenance_delete', jsonb_build_object('kind', 'rate',
        'organizationId', claimed.organization_id::text, 'projectId', claimed.project_id::text,
        'rateClass', claimed.rate_class, 'subjectKey', claimed.subject_key,
        'bucketStart', claimed.bucket_start::text)::text, true);
      DELETE FROM planner_view_rate_limits WHERE organization_id = claimed.organization_id AND project_id = claimed.project_id
        AND rate_class = claimed.rate_class AND subject_key = claimed.subject_key AND bucket_start = claimed.bucket_start;
      removed_rate_rows := removed_rate_rows + 1;
    END IF;
    PERFORM set_config('engineo.planner_view_maintenance_delete', coalesce(prior, ''), true);
  END LOOP;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION engineo_planner_view_maintain(integer) FROM PUBLIC;
