import { ENGINE_CONTRACT_VERSION } from "@engineo/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "./db/client.js";
import { registerAuthRoutes } from "./security/auth-routes.js";
import { registerSecurityHeaders } from "./security/headers.js";

export interface BuildAppOptions {
  database?: Database;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
  });

  registerSecurityHeaders(app);

  app.get("/health", async () => ({
    service: "engineo-api",
    status: "ok",
    engineContractVersion: ENGINE_CONTRACT_VERSION,
  }));

  if (options.database) {
    registerAuthRoutes(app, options.database);
  }

  return app;
}
