import {
  parsePlannerViewOperationsJsonV1,
  PlannerViewConfigurationError,
  PlannerViewOperationsError,
  plannerViewOperationWindowV1,
  type PlannerViewOperationValidationV1,
  validatePlannerViewApplyRequestV1,
  validatePlannerViewPlanRequestV1,
  validatePlannerViewProjectionRequestV1,
  validatePlannerViewValidateRequestV1,
} from "@engineo/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../db/client.js";
import { tenantContext } from "../db/tenant-context.js";
import { PlannerViewError, safeViewDiagnostics } from "../repositories/planner-view-errors.js";
import { PlannerViewRepository } from "../repositories/planner-view-repository.js";
import type { ScheduleRunner } from "../scheduler/runner.js";
import { requireCsrf, requireSession } from "../security/request-auth.js";
import type { SessionPrincipal } from "../security/session.js";
import * as schemas from "./schemas.js";

interface ProjectParams {
  organizationId: string;
  projectId: string;
}
interface ViewParams extends ProjectParams {
  viewId: string;
}
interface OperationParams extends ProjectParams {
  operationWindowId: string;
  operationId: string;
}

function validated<T>(result: PlannerViewOperationValidationV1<T>): T {
  if (!result.valid)
    throw new PlannerViewError("view_invalid", 422, safeViewDiagnostics(result.diagnostics));
  return result.value;
}

export function registerPlannerViewRoutes(
  app: FastifyInstance,
  db: Database,
  runner: ScheduleRunner,
): void {
  app.register(
    async (scope) => {
      const inherited = scope.errorHandler;
      scope.addHook("onRequest", async (_request, reply) => {
        reply.header("Cache-Control", "no-store");
      });
      scope.setErrorHandler((error, request, reply) => {
        if (error instanceof PlannerViewError) {
          void reply.code(error.statusCode).send({
            error: error.code,
            ...(error.diagnostics ? { diagnostics: safeViewDiagnostics(error.diagnostics) } : {}),
          });
        } else if (
          error instanceof PlannerViewConfigurationError ||
          error instanceof PlannerViewOperationsError
        ) {
          void reply
            .code(422)
            .send({ error: "view_invalid", diagnostics: safeViewDiagnostics(error.diagnostics) });
        } else if ((error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
          void reply.code(413).send({
            error: "view_invalid",
            diagnostics: {
              issues: [
                {
                  code: "TRANSPORT_TOO_LARGE",
                  path: "",
                  message: "Private view body exceeds 64 KiB.",
                },
              ],
              totalCount: 1,
              truncated: false,
            },
          });
        } else if ((error as { validation?: unknown[] }).validation) {
          void reply.code(422).send({ error: "view_invalid" });
        } else inherited.call(scope, error, request, reply);
      });
      // Encapsulated original-byte parser. Legacy auth/Planner/configuration body
      // parsing and their limits are unchanged. No source bytes enter logging.
      scope.removeContentTypeParser("application/json");
      scope.addContentTypeParser(
        "application/json",
        { parseAs: "buffer", bodyLimit: 65536 },
        (_request, body, done) => {
          try {
            done(null, parsePlannerViewOperationsJsonV1(body as Buffer));
          } catch (error) {
            done(error as Error);
          }
        },
      );
      const repository = new PlannerViewRepository(db, runner, true);
      const verifiedRequests = new WeakMap<object, SessionPrincipal>();
      scope.addHook("onRequest", async (request, reply) => {
        if (request.method === "POST" && request.headers.origin !== process.env.APP_ORIGIN) {
          await reply.code(403).send({ error: "origin_not_allowed" });
          return;
        }
        const principal = await requireSession(db, request, reply);
        if (!principal) return;
        if (request.headers["x-engineo-session"] === undefined) {
          await reply.code(409).send({ error: "session_intent_required" });
          return;
        }
        if (request.method === "POST" && !(await requireCsrf(db, request, reply, principal)))
          return;
        const params = request.params as ProjectParams;
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (
          !params ||
          typeof params.organizationId !== "string" ||
          typeof params.projectId !== "string" ||
          !uuid.test(params.organizationId) ||
          !uuid.test(params.projectId)
        ) {
          await reply.code(422).send({ error: "view_invalid" });
          return;
        }
        await repository.admitRequest(
          tenantContext(params.organizationId.toLowerCase(), principal.userId, request.id),
          params.projectId.toLowerCase(),
          principal,
        );
        verifiedRequests.set(request, principal);
      });
      const base = "/organizations/:organizationId/projects/:projectId/views";
      const viewParams = schemas.object({
        ...schemas.projectParams.properties,
        viewId: schemas.uuid,
      });
      const operationParams = schemas.object({
        ...schemas.projectParams.properties,
        operationWindowId: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        operationId: schemas.uuid,
      });

      async function respond<P extends ProjectParams>(
        request: FastifyRequest<{ Params: P }>,
        reply: FastifyReply,
        _post: boolean,
        run: (principal: SessionPrincipal, signal: AbortSignal) => Promise<unknown>,
      ): Promise<void> {
        const principal = verifiedRequests.get(request);
        if (!principal) {
          await reply.code(401).send({ error: "unauthenticated" });
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
          await reply.send(await run(principal, controller.signal));
        } finally {
          request.raw.off("aborted", abort);
          reply.raw.off("close", disconnected);
        }
      }
      const context = (
        request: FastifyRequest<{ Params: ProjectParams }>,
        principal: SessionPrincipal,
      ) => tenantContext(request.params.organizationId.toLowerCase(), principal.userId, request.id);
      const project = (request: FastifyRequest<{ Params: ProjectParams }>) =>
        request.params.projectId.toLowerCase();

      scope.get<{ Params: ProjectParams; Querystring: { limit?: string; cursor?: string } }>(
        base,
        {
          schema: {
            params: schemas.projectParams,
            querystring: schemas.object(
              {
                limit: { type: "string", pattern: "^(?:[1-9]|[1-4][0-9]|50)$" },
                cursor: { type: "string", maxLength: 2048 },
              },
              [],
            ),
          },
        },
        async (request, reply) =>
          respond(request, reply, false, (principal, signal) => {
            const cursor = request.query.cursor ?? null;
            if (
              cursor !== null &&
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cursor)
            )
              throw new PlannerViewError("view_invalid", 422);
            return repository.list(
              context(request, principal),
              project(request),
              principal,
              cursor,
              Number(request.query.limit ?? 50),
              signal,
            );
          }),
      );
      scope.get<{ Params: ProjectParams }>(
        `${base}/capabilities`,
        { schema: { params: schemas.projectParams } },
        async (request, reply) =>
          respond(request, reply, false, (principal, signal) =>
            repository.capabilities(
              context(request, principal),
              project(request),
              principal,
              signal,
            ),
          ),
      );
      scope.get<{ Params: OperationParams }>(
        `${base}/operations/:operationWindowId/:operationId`,
        { schema: { params: operationParams } },
        async (request, reply) =>
          respond(request, reply, false, (principal, signal) => {
            plannerViewOperationWindowV1(`${request.params.operationWindowId}T00:00:00.000Z`);
            return repository.receipt(
              context(request, principal),
              project(request),
              principal,
              request.params.operationWindowId,
              request.params.operationId.toLowerCase(),
              signal,
            );
          }),
      );
      scope.get<{ Params: ViewParams }>(
        `${base}/:viewId`,
        { schema: { params: viewParams } },
        async (request, reply) =>
          respond(request, reply, false, (principal, signal) =>
            repository.read(
              context(request, principal),
              project(request),
              principal,
              request.params.viewId.toLowerCase(),
              signal,
            ),
          ),
      );
      scope.get<{ Params: ViewParams }>(
        `${base}/:viewId/projection`,
        { schema: { params: viewParams } },
        async (request, reply) =>
          respond(request, reply, false, (principal, signal) =>
            repository.projection(
              context(request, principal),
              project(request),
              principal,
              null,
              null,
              signal,
              request.params.viewId.toLowerCase(),
            ),
          ),
      );
      scope.post<{ Params: ProjectParams; Body: unknown }>(
        `${base}/validate`,
        { bodyLimit: 65536, schema: { params: schemas.projectParams } },
        async (request, reply) =>
          respond(request, reply, true, (principal, signal) =>
            repository.validate(
              context(request, principal),
              project(request),
              principal,
              validated(validatePlannerViewValidateRequestV1(request.body)).configuration,
              signal,
            ),
          ),
      );
      scope.post<{ Params: ProjectParams; Body: unknown }>(
        `${base}/projection`,
        { bodyLimit: 65536, schema: { params: schemas.projectParams } },
        async (request, reply) =>
          respond(request, reply, true, (principal, signal) => {
            const value = validated(validatePlannerViewProjectionRequestV1(request.body));
            return repository.projection(
              context(request, principal),
              project(request),
              principal,
              value.configuration,
              value.expectedScheduleRevision,
              signal,
            );
          }),
      );
      scope.post<{ Params: ProjectParams; Body: unknown }>(
        `${base}/plan`,
        { bodyLimit: 65536, schema: { params: schemas.projectParams } },
        async (request, reply) =>
          respond(request, reply, true, (principal, signal) =>
            repository.plan(
              context(request, principal),
              project(request),
              principal,
              validated(validatePlannerViewPlanRequestV1(request.body)),
              signal,
            ),
          ),
      );
      scope.post<{ Params: ProjectParams; Body: unknown }>(
        `${base}/apply`,
        { bodyLimit: 65536, schema: { params: schemas.projectParams } },
        async (request, reply) =>
          respond(request, reply, true, (principal, signal) =>
            repository.apply(
              context(request, principal),
              project(request),
              principal,
              validated(validatePlannerViewApplyRequestV1(request.body)),
              signal,
            ),
          ),
      );
    },
    { logLevel: "silent" },
  );
}
