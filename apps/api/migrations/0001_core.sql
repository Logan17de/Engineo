CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  slug text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$')
);
CREATE UNIQUE INDEX organizations_slug_unique ON organizations (lower(slug));

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE organization_memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id),
  CONSTRAINT organization_memberships_role
    CHECK (role IN ('owner', 'admin', 'planner', 'viewer'))
);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text,
  description text,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, code)
);

CREATE TABLE calendars (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL,
  time_zone text NOT NULL,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT calendars_definition_object CHECK (jsonb_typeof(definition) = 'object')
);

CREATE TABLE wbs_nodes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  parent_id uuid,
  code text NOT NULL,
  name text NOT NULL,
  sort_order bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, code),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, project_id, parent_id)
    REFERENCES wbs_nodes(organization_id, project_id, id) ON DELETE CASCADE,
  CONSTRAINT wbs_nodes_sort_order_nonnegative CHECK (sort_order >= 0)
);

CREATE TABLE activities (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  wbs_id uuid NOT NULL,
  calendar_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  duration_minutes bigint NOT NULL,
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, project_id, wbs_id)
    REFERENCES wbs_nodes(organization_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, project_id, calendar_id)
    REFERENCES calendars(organization_id, project_id, id) ON DELETE RESTRICT,
  CONSTRAINT activities_kind
    CHECK (kind IN ('TASK', 'START_MILESTONE', 'FINISH_MILESTONE')),
  CONSTRAINT activities_duration_nonnegative CHECK (duration_minutes >= 0),
  CONSTRAINT activities_milestone_duration CHECK (
    kind = 'TASK' OR duration_minutes = 0
  ),
  CONSTRAINT activities_constraints_array CHECK (jsonb_typeof(constraints) = 'array'),
  CONSTRAINT activities_sort_order_nonnegative CHECK (sort_order >= 0)
);

CREATE TABLE relationships (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  predecessor_id uuid NOT NULL,
  successor_id uuid NOT NULL,
  relationship_type text NOT NULL,
  lag_minutes bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, project_id, id),
  UNIQUE (
    organization_id,
    project_id,
    predecessor_id,
    successor_id,
    relationship_type,
    lag_minutes
  ),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, project_id, predecessor_id)
    REFERENCES activities(organization_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, project_id, successor_id)
    REFERENCES activities(organization_id, project_id, id) ON DELETE CASCADE,
  CONSTRAINT relationships_type CHECK (relationship_type IN ('FS', 'SS', 'FF', 'SF')),
  CONSTRAINT relationships_no_self CHECK (predecessor_id <> successor_id)
);

CREATE TABLE project_schedule_settings (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  planned_start timestamptz NOT NULL,
  data_date timestamptz NOT NULL,
  required_finish timestamptz,
  default_calendar_id uuid NOT NULL,
  critical_float_threshold_minutes bigint NOT NULL DEFAULT 0,
  lag_calendar_policy text NOT NULL DEFAULT 'SUCCESSOR',
  project_finish_policy text NOT NULL DEFAULT 'CALCULATED',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, project_id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, project_id, default_calendar_id)
    REFERENCES calendars(organization_id, project_id, id) ON DELETE RESTRICT,
  CONSTRAINT schedule_threshold_nonnegative CHECK (critical_float_threshold_minutes >= 0),
  CONSTRAINT schedule_lag_policy
    CHECK (lag_calendar_policy IN ('PREDECESSOR', 'SUCCESSOR', 'PROJECT')),
  CONSTRAINT schedule_finish_policy
    CHECK (project_finish_policy IN ('CALCULATED', 'REQUIRED_FINISH')),
  CONSTRAINT schedule_required_finish_present CHECK (
    project_finish_policy <> 'REQUIRED_FINISH' OR required_finish IS NOT NULL
  )
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_type text NOT NULL,
  actor_id uuid,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  source text NOT NULL,
  correlation_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_actor_type CHECK (actor_type IN ('user', 'service', 'system')),
  CONSTRAINT audit_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX projects_organization_idx ON projects (organization_id, updated_at DESC);
CREATE INDEX wbs_nodes_project_idx ON wbs_nodes (organization_id, project_id, sort_order);
CREATE INDEX activities_project_idx ON activities (organization_id, project_id, sort_order);
CREATE INDEX relationships_project_idx ON relationships (organization_id, project_id);
CREATE INDEX calendars_project_idx ON calendars (organization_id, project_id);
CREATE INDEX audit_events_tenant_time_idx
  ON audit_events (organization_id, occurred_at DESC);

CREATE FUNCTION engineo_reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only';
END;
$$;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION engineo_reject_audit_mutation();
