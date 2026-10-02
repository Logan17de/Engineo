import { ENGINE_CONTRACT_VERSION } from "@engineo/contracts";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Database } from "./db/client.js";
import { registerAuthRoutes } from "./security/auth-routes.js";
import { validateSecurityConfiguration } from "./security/config.js";
import { registerSecurityHeaders } from "./security/headers.js";
import { LoginRateLimiter, loginRateLimitStore } from "./security/rate-limit.js";

export interface BuildAppOptions {
  database?: Database;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  if (options.database) validateSecurityConfiguration();
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });

  registerSecurityHeaders(app);
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ errorType: error.name, requestId: request.id }, "API operation failed");
      if (status === 503) reply.header("Retry-After", "1");
      void reply.code(status === 503 ? 503 : 500).send({
        error: status === 503 ? "temporarily_unavailable" : "internal_error",
      });
      return;
    }
    void reply.code(status).send({
      error: status === 429 ? "too_many_attempts" : "invalid_request",
    });
  });

  app.get("/health", async () => ({
    service: "engineo-api",
    status: "ok",
    engineContractVersion: ENGINE_CONTRACT_VERSION,
  }));

  if (options.database) {
    const db = options.database;
    app.register(async (scope) => {
      const limiter = new LoginRateLimiter(db);
      await scope.register(rateLimit, {
        global: false,
        hook: "onRequest",
        store: loginRateLimitStore(limiter),
        skipOnError: false,
        errorResponseBuilder: (_request, context) => ({
          statusCode: context.statusCode,
          error: "too_many_attempts",
        }),
      });
      registerAuthRoutes(scope, db, limiter);
    });
  }

  return app;
}
