import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { validateScheduleInputV1, type ActivityKindV1, type CalendarV1, type RelationshipTypeV1 } from "@engineo/contracts";
import type { Database } from "../db/client.js";
import { tenantContext } from "../db/tenant-context.js";
import {
  PlannerRepository,
  RevisionConflictError,
  type CreateActivityInput,
  type CreateCalendarInput,
  type CreateRelationshipInput,
  type CreateWbsInput,
} from "../repositories/planner-repository.js";
import { ProjectRepository } from "../repositories/project-repository.js";
import type { ScheduleRunner } from "../scheduler/runner.js";
import { appendAuditEvent } from "../security/audit.js";
import { authorizeOrganization, authorizeProject, type Permission } from "../security/rbac.js";
import { requireAllowedOrigin, requireCsrf, requireSession } from "../security/request-auth.js";
import type { SessionPrincipal } from "../security/session.js";

interface OrganizationParams {
  organizationId: string;
}

interface ProjectParams extends OrganizationParams {
  projectId: string;
}

interface ActivityParams extends ProjectParams {
  activityId: string;
}

interface RelationshipParams extends ProjectParams {
  relationshipId: string;
}

interface CreateProjectBody {
  name: string;
  code?: string | null;
  description?: string | null;
  plannedStart: string;
  timeZone: string;
}

interface RevisionBody {
  expectedRevision: number;
}

interface WbsBody extends RevisionBody {
  parentId?: string | null;
  code: string;
  name: string;
  sortOrder?: number;
}

interface CalendarBody extends RevisionBody {
  name: string;
  timeZone: string;
  week: CalendarV1["week"];
  exceptions?: CalendarV1["exceptions"];
}

interface ActivityBody extends RevisionBody {
  wbsId: string;
  calendarId: string;
  name: string;
  kind: ActivityKindV1;
  durationMinutes: number;
  constraints?: CreateActivityInput["constraints"];
  sortOrder?: number;
}

interface RelationshipBody extends RevisionBody {
  predecessorId: string;
  successorId: string;
  type: RelationshipTypeV1;
  lagMinutes?: number;
}

async function projectPrincipal(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  projectId: string,
  permission: Permission,
): Promise<SessionPrincipal | null> {
  const principal = await requireSession(db, request, reply);
  if (!principal) {
    return null;
  }

  const decision = await authorizeProject(
    db,
    principal.userId,
    organizationId,
    projectId,
    permission,
  );
  if (!decision.allowed) {
    await reply.code(403).send({ error: "forbidden" });
    return null;
  }

  return principal;
}

async function mutationPrincipal(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  projectId: string,
): Promise<SessionPrincipal | null> {
  if (!requireAllowedOrigin(request, reply)) {
    return null;
  }

  const principal = await projectPrincipal(
    db,
    request,
    reply,
    organizationId,
    projectId,
    "project.write",
  );
  if (!principal) {
    return null;
  }

  if (!(await requireCsrf(db, request, reply, principal))) {
    return null;
  }

  return principal;
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function validInstant(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

function sendMutationError(reply: FastifyReply, error: unknown): void {
  if (error instanceof RevisionConflictError) {
    void reply.code(409).send({
      error: "revision_conflict",
      message: error.message,
    });
    return;
  }

  throw error;
}

export function registerProjectRoutes(
  app: FastifyInstance,
  db: Database,
  scheduleRunner: ScheduleRunner,
): void {
  const projects = new ProjectRepository(db);
  const planner = new PlannerRepository(db);

  app.get<{ Params: OrganizationParams }>(
    "/organizations/:organizationId/projects",
    async (request, reply) => {
      const principal = await requireSession(db, request, reply);
      if (!principal) {
        return;
      }

      const rows = await planner.listAccessibleProjects(
        principal.userId,
        request.params.organizationId,
      );
      await reply.send({ projects: rows });
    },
  );

  app.post<{ Params: OrganizationParams; Body: CreateProjectBody }>(
    "/organizations/:organizationId/projects",
    async (request, reply) => {
      if (!requireAllowedOrigin(request, reply)) {
        return;
      }

      const principal = await requireSession(db, request, reply);
      if (!principal || !(await requireCsrf(db, request, reply, principal))) {
        return;
      }

      const decision = await authorizeOrganization(
        db,
        principal.userId,
        request.params.organizationId,
        "project.create",
      );
      if (!decision.allowed) {
        await reply.code(403).send({ error: "forbidden" });
        return;
      }

      if (
        request.body.name.trim().length === 0 ||
        !validInstant(request.body.plannedStart) ||
        !validTimeZone(request.body.timeZone)
      ) {
        await reply.code(400).send({ error: "invalid_project_input" });
        return;
      }

      const created = await planner.createProject(
        tenantContext(request.params.organizationId, principal.userId, request.id),
        {
          name: request.body.name.trim(),
          code: request.body.code?.trim() || null,
          description: request.body.description?.trim() || null,
          plannedStart: request.body.plannedStart,
          timeZone: request.body.timeZone,
        },
      );

      await appendAuditEvent(db, {
        organizationId: request.params.organizationId,
        actorType: "user",
        actorId: principal.userId,
        action: "project.create",
        resourceType: "project",
        resourceId: created.projectId,
        source: "api",
        correlationId: request.id,
        payload: { revision: created.revision },
      });

      await reply.code(201).send(created);
    },
  );

  app.get<{ Params: ProjectParams }>(
    "/organizations/:organizationId/projects/:projectId",
    async (request, reply) => {
      const principal = await projectPrincipal(
        db,
        request,
        reply,
        request.params.organizationId,
        request.params.projectId,
        "project.read",
      );
      if (!principal) {
        return;
      }

      const project = await projects.findById(
        tenantContext(request.params.organizationId, principal.userId, request.id),
        request.params.projectId,
      );
      if (!project) {
        await reply.code(404).send({ error: "project_not_found" });
        return;
      }

      await reply.send({ project });
    },
  );

  app.get<{ Params: ProjectParams }>(
    "/organizations/:organizationId/projects/:projectId/schedule",
    async (request, reply) => {
      const principal = await projectPrincipal(
        db,
        request,
        reply,
        request.params.organizationId,
        request.params.projectId,
        "project.read",
      );
      if (!principal) {
        return;
      }

      const snapshot = await projects.scheduleSnapshot(
        tenantContext(request.params.organizationId, principal.userId, request.id),
        request.params.projectId,
      );
      if (!snapshot) {
        await reply.code(404).send({ error: "project_not_found" });
        return;
      }

      await reply.send(snapshot);
    },
  );

  app.post<{ Params: ProjectParams }>(
    "/organizations/:organizationId/projects/:projectId/schedule/run",
    async (request, reply) => {
      if (!requireAllowedOrigin(request, reply)) {
        return;
      }

      const principal = await projectPrincipal(
        db,
        request,
        reply,
        request.params.organizationId,
        request.params.projectId,
        "schedule.run",
      );
      if (!principal || !(await requireCsrf(db, request, reply, principal))) {
        return;
      }

      const snapshot = await projects.scheduleSnapshot(
        tenantContext(request.params.organizationId, principal.userId, request.id),
        request.params.projectId,
      );
      if (!snapshot) {
        await reply.code(404).send({ error: "project_not_found" });
        return;
      }

      const validation = validateScheduleInputV1(snapshot);
      if (!validation.valid) {
        await reply.code(422).send({
          error: "invalid_schedule",
          issues: validation.issues,
        });
        return;
      }

      const result = await scheduleRunner.calculate(snapshot);
      await appendAuditEvent(db, {
        organizationId: request.params.organizationId,
        actorType: "user",
        actorId: principal.userId,
        action: "schedule.run",
        resourceType: "project",
        resourceId: request.params.projectId,
        source: "api",
        correlationId: request.id,
        payload: {},
      });

      await reply.send({ result });
    },
  );

  app.post<{ Params: ProjectParams; Body: WbsBody }>(
    "/organizations/:organizationId/projects/:projectId/wbs",
    async (request, reply) => {
      const principal = await mutationPrincipal(
        db,
        request,
        reply,
        request.params.organizationId,
        request.params.projectId,
      );
      if (!principal) {
        return;
      }

      const input: CreateWbsInput = {
        parentId: request.body.parentId ?? null,
        code: request.body.code.trim(),
        name: request.body.name.trim(),
        sortOrder: request.body.sortOrder ?? 0,
      };

      try {
        const created = await planner.createWbs(
          tenantContext(request.params.organizationId, principal.userId, request.id),
          request.params.projectId,
          request.body.expectedRevision,
          input,
        );
        await reply.code(201).send(created);
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );

  app.post<{ Params: ProjectParams; Body: CalendarBody }>(
    "/organizations/:organizationId/projects/:projectId/calendars",
    async (request, reply) => {
      const principal = await mutationPrincipal(
        db,
        request,
        reply,
        request.params.organizationId,
        request.params.projectId,
      );
      if (!principal) {
        return;
      }

      if (!validTimeZone(request.body.timeZone)) {
        await reply.code(400).send({ error: "invalid_time_zone" });
        return;
      }

      const input: CreateCalendarInput = {
        name: request.body.name.trim(),
        timeZone: request.body.timeZone,
        week: request.body.week,
        exceptions: request.body.exceptions ?? [],
      };

      try {
        const created = await planner.createCalendar(
          tenantContext(request.params.organizationId, principal.userId, request.id),
          request.params.projectId,
          request.body.expectedRevision,
          input,
        );
        await reply.code(201).send(created);
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );

  app.post<{ Params: ProjectParams; Body: ActivityBody }>(
    "/organizations/:organizationId/projects/:projectId/activities",
    async (request, reply) => {
      const principal = await mutationPrincipal(
        db,
        request,
        reply,
        request.params.organizationId,
        request.params.projectId,
      );
      if (!principal) {
        return;
      }

      const input: CreateActivityInput = {
        wbsId: request.body.wbsId,
        calendarId: request.body.calendarId,
        name: request.body.name.trim(),
        kind: request.body.kind,
        durationMinutes: request.body.durationMinutes,
        constraints: request.body.constraints ?? [],
        sortOrder: request.body.sortOrder ?? 0,
      };

      try {
        const created = await planner.createActivity(
          tenantContext(request.params.organizationId, principal.userId, request.id),
          request.params.projectId,
          request.body.expectedRevision,
          input,
        );
        await reply.code(201).send(created);
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );

  app.post<{ Params: ProjectParams; Body: RelationshipBody }>(
    "/organizations/:organizationId/projects/:projectId/relationships",
    async (request, reply) => {
      const principal = await mutationPrincipal(
        db,
        request,
        reply,
        request.params.organizationId,
        request.params.projectId,
      );
      if (!principal) {
        return;
      }

      const input: CreateRelationshipInput = {
        predecessorId: request.body.predecessorId,
        successorId: request.body.successorId,
        type: request.body.type,
        lagMinutes: request.body.lagMinutes ?? 0,
      };

      try {
        const created = await planner.createRelationship(
          tenantContext(request.params.organizationId, principal.userId, request.id),
          request.params.projectId,
          request.body.expectedRevision,
          input,
        );
        await reply.code(201).send(created);
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );

  app.delete<{ Params: ActivityParams; Body: RevisionBody }>(
    "/organizations/:organizationId/projects/:projectId/activities/:activityId",
    async (request, reply) => {
      const principal = await mutationPrincipal(
        db,
        request,
        reply,
        request.params.organizationId,
        request.params.projectId,
      );
      if (!principal) {
        return;
      }

      try {
        const revision = await planner.deleteActivity(
          tenantContext(request.params.organizationId, principal.userId, request.id),
          request.params.projectId,
          request.params.activityId,
          request.body.expectedRevision,
        );
        await reply.send({ revision });
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );

  app.delete<{ Params: RelationshipParams; Body: RevisionBody }>(
    "/organizations/:organizationId/projects/:projectId/relationships/:relationshipId",
    async (request, reply) => {
      const principal = await mutationPrincipal(
        db,
        request,
        reply,
        request.params.organizationId,
        request.params.projectId,
      );
      if (!principal) {
        return;
      }

      try {
        const revision = await planner.deleteRelationship(
          tenantContext(request.params.organizationId, principal.userId, request.id),
          request.params.projectId,
          request.params.relationshipId,
          request.body.expectedRevision,
        );
        await reply.send({ revision });
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );
}
