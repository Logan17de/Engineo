import {
  type ProjectConfigurationApplyRequestV1,
  type ProjectConfigurationCancelRequestV1,
  ProjectConfigurationError,
  type ProjectConfigurationPlanRequestV1,
  parseConfigurationJsonV1,
} from "@engineo/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../db/client.js";
import { tenantContext } from "../db/tenant-context.js";
import {
  ConfigurationError,
  ConfigurationRepository,
} from "../repositories/configuration-repository.js";
import { requireAllowedOrigin, requireCsrf, requireSession } from "../security/request-auth.js";
import type { SessionPrincipal } from "../security/session.js";
import * as schemas from "./schemas.js";

interface ProjectParams {
  organizationId: string;
  projectId: string;
}
interface PlanParams extends ProjectParams {
  planId: string;
}

export function registerConfigurationRoutes(app: FastifyInstance, db: Database): void {
  // Encapsulate strict parsing in this new protocol. Existing auth/Planner
  // parsers and compatibility behavior are deliberately unchanged.
  app.register(async (scope) => {
    const inheritedErrorHandler = scope.errorHandler;
    scope.setErrorHandler((error, request, reply) => {
      if (error instanceof ProjectConfigurationError) {
        void reply.code(422).send({
          error: "configuration_invalid",
          diagnostics: error.diagnostics,
          calculationChecked: false,
        });
      } else if (error instanceof ConfigurationError) {
        void reply.code(error.statusCode).send({
          error: error.code,
          ...(error.diagnostics
            ? { diagnostics: error.diagnostics, calculationChecked: false }
            : {}),
        });
      } else if ((error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        void reply.code(413).send({
          error: "configuration_invalid",
          calculationChecked: false,
          diagnostics: {
            issues: [
              {
                code: "TRANSPORT_TOO_LARGE",
                path: "",
                message: "Request exceeds the 1 MiB transport limit.",
              },
            ],
            totalCount: 1,
            truncated: false,
          },
        });
      } else if ((error as { validation?: unknown[] }).validation) {
        const violations = (
          error as { validation: Array<{ instancePath?: string; keyword?: string }> }
        ).validation;
        void reply.code(422).send({
          error: "configuration_invalid",
          calculationChecked: false,
          diagnostics: {
            issues: violations.slice(0, 100).map((violation) => ({
              code: "INVALID_VALUE",
              path: violation.instancePath ?? "",
              message: "Invalid request envelope.",
            })),
            totalCount: violations.length,
            truncated: violations.length > 100,
          },
        });
      } else inheritedErrorHandler.call(scope, error, request, reply);
    });
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => {
        try {
          done(
            null,
            parseConfigurationJsonV1(
              new TextDecoder("utf-8", { fatal: true }).decode(body as Buffer),
            ),
          );
        } catch (error) {
          if (error instanceof TypeError)
            done(
              new ProjectConfigurationError("INVALID_JSON", {
                issues: [{ code: "INVALID_JSON", path: "", message: "JSON must use valid UTF-8." }],
                totalCount: 1,
                truncated: false,
              }),
            );
          else done(error as Error);
        }
      },
    );
    const repository = new ConfigurationRepository(db);
    const base = "/organizations/:organizationId/projects/:projectId/configuration";
    const planParams = schemas.object({
      ...schemas.projectParams.properties,
      planId: schemas.uuid,
    });
    const digestSchema = { type: "string", pattern: "^[a-f0-9]{64}$" };
    const planBody = schemas.object({
      planId: schemas.uuid,
      expectedRevision: schemas.expectedRevision,
      configuration: {},
    });
    const applyBody = schemas.object({
      expectedRevision: schemas.expectedRevision,
      reviewedDigest: digestSchema,
    });
    const cancelBody = schemas.object({ reviewedDigest: digestSchema });

    async function principal(
      request: FastifyRequest,
      reply: FastifyReply,
      mutation: boolean,
    ): Promise<SessionPrincipal | null> {
      if (mutation && !requireAllowedOrigin(request, reply)) return null;
      const resolved = await requireSession(db, request, reply);
      if (!resolved) return null;
      if (request.headers["x-engineo-session"] === undefined) {
        await reply.code(409).send({ error: "session_intent_required" });
        return null;
      }
      if (mutation && !(await requireCsrf(db, request, reply, resolved))) return null;
      return resolved;
    }

    async function respond<P extends ProjectParams>(
      request: FastifyRequest<{ Params: P }>,
      reply: FastifyReply,
      mutation: boolean,
      run: (identity: SessionPrincipal, signal: AbortSignal) => Promise<unknown>,
    ): Promise<void> {
      const identity = await principal(request, reply, mutation);
      if (!identity) return;
      const controller = new AbortController();
      const abort = () => controller.abort();
      const disconnected = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      request.raw.once("aborted", abort);
      reply.raw.once("close", disconnected);
      if (request.raw.aborted || reply.raw.destroyed) controller.abort();
      try {
        const response = await run(identity, controller.signal);
        await reply.header("Cache-Control", "no-store").send(response);
      } finally {
        request.raw.off("aborted", abort);
        reply.raw.off("close", disconnected);
      }
    }

    const context = (
      request: FastifyRequest<{ Params: ProjectParams }>,
      identity: SessionPrincipal,
    ) => tenantContext(request.params.organizationId.toLowerCase(), identity.userId, request.id);

    scope.get<{ Params: ProjectParams }>(
      base,
      { schema: { params: schemas.projectParams } },
      async (request, reply) =>
        respond(request, reply, false, (identity, signal) =>
          repository.read(
            context(request, identity),
            request.params.projectId.toLowerCase(),
            identity,
            signal,
          ),
        ),
    );
    scope.post<{ Params: ProjectParams; Body: unknown }>(
      `${base}/validate`,
      { schema: { params: schemas.projectParams } },
      async (request, reply) =>
        respond(request, reply, true, (identity, signal) =>
          repository.validate(
            context(request, identity),
            request.params.projectId.toLowerCase(),
            identity,
            request.body,
            signal,
          ),
        ),
    );
    scope.post<{ Params: ProjectParams; Body: ProjectConfigurationPlanRequestV1 }>(
      `${base}/plans`,
      { schema: { params: schemas.projectParams, body: planBody } },
      async (request, reply) =>
        respond(request, reply, true, (identity, signal) =>
          repository.plan(
            context(request, identity),
            request.params.projectId.toLowerCase(),
            identity,
            request.body,
            signal,
          ),
        ),
    );
    scope.get<{ Params: PlanParams }>(
      `${base}/plans/:planId`,
      { schema: { params: planParams } },
      async (request, reply) =>
        respond(request, reply, false, (identity, signal) =>
          repository.getPlan(
            context(request, identity),
            request.params.projectId.toLowerCase(),
            identity,
            request.params.planId.toLowerCase(),
            signal,
          ),
        ),
    );
    scope.get<{ Params: PlanParams }>(
      `${base}/plans/:planId/receipt`,
      { schema: { params: planParams } },
      async (request, reply) =>
        respond(request, reply, false, (identity, signal) =>
          repository.receipt(
            context(request, identity),
            request.params.projectId.toLowerCase(),
            identity,
            request.params.planId.toLowerCase(),
            signal,
          ),
        ),
    );
    scope.post<{ Params: PlanParams; Body: ProjectConfigurationApplyRequestV1 }>(
      `${base}/plans/:planId/apply`,
      { schema: { params: planParams, body: applyBody } },
      async (request, reply) =>
        respond(request, reply, true, (identity, signal) =>
          repository.apply(
            context(request, identity),
            request.params.projectId.toLowerCase(),
            identity,
            request.params.planId.toLowerCase(),
            request.body,
            signal,
          ),
        ),
    );
    scope.post<{ Params: PlanParams; Body: ProjectConfigurationCancelRequestV1 }>(
      `${base}/plans/:planId/cancel`,
      { schema: { params: planParams, body: cancelBody } },
      async (request, reply) =>
        respond(request, reply, true, (identity, signal) =>
          repository.cancel(
            context(request, identity),
            request.params.projectId.toLowerCase(),
            identity,
            request.params.planId.toLowerCase(),
            request.body,
            signal,
          ),
        ),
    );
  });
}
