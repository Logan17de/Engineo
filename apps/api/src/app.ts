import Fastify, { type FastifyInstance } from "fastify";
import { ENGINE_CONTRACT_VERSION } from "@engineo/contracts";

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
  });

  app.get("/health", async () => ({
    service: "engineo-api",
    status: "ok",
    engineContractVersion: ENGINE_CONTRACT_VERSION,
  }));

  return app;
}
