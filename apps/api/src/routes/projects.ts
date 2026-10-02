import {
  type ActivityKindV1,
  type CalendarV1,
  type EngineProjectInputV1,
  isIanaTimeZone,
  isRfc3339Instant,
  type RelationshipTypeV1,
  validateScheduleInputV1,
} from "@engineo/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../db/client.js";
import { tenantContext } from "../db/tenant-context.js";
import {
  type CreateActivityInput,
  type CreateCalendarInput,
  type CreateRelationshipInput,
  type CreateWbsInput,
  PlannerInputError,
  PlannerNotFoundError,
  PlannerRepository,
  RevisionConflictError,
} from "../repositories/planner-repository.js";
import { ProjectRepository } from "../repositories/project-repository.js";
import { ScheduleEngineError, type ScheduleRunner } from "../scheduler/runner.js";
import { appendAuditEvent } from "../security/audit.js";
import { authorizeOrganization, authorizeProject, type Permission } from "../security/rbac.js";
import { requireAllowedOrigin, requireCsrf, requireSession } from "../security/request-auth.js";
import type { SessionPrincipal } from "../security/session.js";

import * as schemas from "./schemas.js";

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
  return isIanaTimeZone(value);
}

function validInstant(value: string): boolean {
  return isRfc3339Instant(value);
}

function sendMutationError(reply: FastifyReply, error: unknown): void {
  if (error instanceof RevisionConflictError) {
    void reply.code(409).send({
      error: "revision_conflict",
      message: error.message,
    });
    return;
  }

  if (error instanceof PlannerInputError) {
    void reply.code(422).send({ error: "invalid_schedule", issues: error.issues });
    return;
  }
  if (error instanceof PlannerNotFoundError) {
    void reply.code(404).send({ error: "resource_not_found" });
    return;
  }
  const code = (error as { code?: string }).code;
  if (code === "23503" || code === "23514") {
    void reply.code(422).send({ error: "invalid_reference_or_value" });
    return;
  }
  if (code === "23505") {
    void reply.code(409).send({ error: "duplicate_value" });
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
    { schema: { params: schemas.organizationParams } },
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
    { schema: { params: schemas.organizationParams, body: schemas.createProjectBody } },
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

      try {
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

        await reply.code(201).send(created);
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );

  app.get<{ Params: ProjectParams }>(
    "/organizations/:organizationId/projects/:projectId",
    { schema: { params: schemas.projectParams } },
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
    { schema: { params: schemas.projectParams } },
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

      const snapshot = await projects.plannerSnapshot(
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

  app.post<{ Params: ProjectParams; Body: RevisionBody }>(
    "/organizations/:organizationId/projects/:projectId/schedule/run",
    { schema: { params: schemas.projectParams, body: schemas.revisionBody } },
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

      const snapshot = await projects.plannerSnapshot(
        tenantContext(request.params.organizationId, principal.userId, request.id),
        request.params.projectId,
      );
      if (!snapshot) {
        await reply.code(404).send({ error: "project_not_found" });
        return;
      }

      if (snapshot.revision !== request.body.expectedRevision) {
        sendMutationError(reply, new RevisionConflictError());
        return;
      }
      const validation = validateScheduleInputV1(snapshot.input);
      if (!validation.valid) {
        await reply.code(422).send({
          error: "invalid_schedule",
          issues: validation.issues,
        });
        return;
      }

      const controller = new AbortController();
      const abort = () => controller.abort();
      const disconnected = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      request.raw.once("aborted", abort);
      reply.raw.once("close", disconnected);
      if (request.raw.aborted || reply.raw.destroyed) controller.abort();
      try {
        const result = await scheduleRunner.calculate(snapshot.input, controller.signal);
        await appendAuditEvent(db, {
          organizationId: request.params.organizationId,
          actorType: "user",
          actorId: principal.userId,
          action: "schedule.run",
          resourceType: "project",
          resourceId: request.params.projectId,
          source: "api",
          correlationId: request.id,
          payload: { revision: snapshot.revision },
        });

        await reply.send({ revision: snapshot.revision, result });
      } catch (error) {
        if (error instanceof ScheduleEngineError) {
          if (error.statusCode === 503) reply.header("Retry-After", "1");
          await reply.code(error.statusCode).send({ error: error.code, message: error.message });
        } else throw error;
      } finally {
        request.raw.off("aborted", abort);
        reply.raw.off("close", disconnected);
      }
    },
  );

  app.put<{ Params: ProjectParams; Body: RevisionBody & { input: EngineProjectInputV1 } }>(
    "/organizations/:organizationId/projects/:projectId/schedule",
    { schema: { params: schemas.projectParams, body: schemas.replaceScheduleBody } },
    async (request, reply) => {
      const principal = await mutationPrincipal(
        db,
        request,
        reply,
        request.params.organizationId,
        request.params.projectId,
      );
      if (!principal) return;
      try {
        const revision = await planner.replaceSchedule(
          tenantContext(request.params.organizationId, principal.userId, request.id),
          request.params.projectId,
          request.body.expectedRevision,
          request.body.input,
        );
        await reply.send({ revision });
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );

  app.post<{ Params: ProjectParams; Body: WbsBody }>(
    "/organizations/:organizationId/projects/:projectId/wbs",
    { schema: { params: schemas.projectParams, body: schemas.wbsBody } },
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
    { schema: { params: schemas.projectParams, body: schemas.calendarBody } },
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
    { schema: { params: schemas.projectParams, body: schemas.activityBody } },
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
    { schema: { params: schemas.projectParams, body: schemas.relationshipBody } },
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
    {
      schema: {
        params: schemas.object({ ...schemas.projectParams.properties, activityId: schemas.uuid }),
        body: schemas.revisionBody,
      },
    },
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
    {
      schema: {
        params: schemas.object({
          ...schemas.projectParams.properties,
          relationshipId: schemas.uuid,
        }),
        body: schemas.revisionBody,
      },
    },
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
