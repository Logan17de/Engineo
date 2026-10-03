import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "../db/client.js";
import { appendAuditEvent } from "../security/audit.js";
import { requireAllowedOrigin, requireCsrf, requireSession } from "../security/request-auth.js";
import { object } from "./schemas.js";

export function registerOrganizationRoutes(app: FastifyInstance, db: Database): void {
  app.get("/organizations", async (request, reply) => {
    const principal = await requireSession(db, request, reply);
    if (!principal) return;
    const rows = await db`
      SELECT o.id, o.name, o.slug, m.role FROM organizations o
      JOIN organization_memberships m ON m.organization_id = o.id
      WHERE m.user_id = ${principal.userId} ORDER BY o.name, o.id
    `;
    await reply.send({ organizations: rows });
  });
  app.post<{ Body: { name: string; slug: string } }>(
    "/organizations",
    {
      schema: {
        body: object({
          name: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" },
          slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$" },
        }),
      },
    },
    async (request, reply) => {
      if (!requireAllowedOrigin(request, reply)) return;
      const principal = await requireSession(db, request, reply);
      if (!principal || !(await requireCsrf(db, request, reply, principal))) return;
      const id = randomUUID();
      try {
        await db.begin(async (sql) => {
          await sql`INSERT INTO organizations (id, name, slug) VALUES (${id}, ${request.body.name.trim()}, ${request.body.slug})`;
          await sql`INSERT INTO organization_memberships (organization_id, user_id, role) VALUES (${id}, ${principal.userId}, 'owner')`;
          await appendAuditEvent(sql, {
            organizationId: id,
            actorType: "user",
            actorId: principal.userId,
            action: "organization.create",
            resourceType: "organization",
            resourceId: id,
            source: "api",
            correlationId: request.id,
            payload: { name: request.body.name.trim(), slug: request.body.slug },
          });
        });
        await reply
          .code(201)
          .send({ id, name: request.body.name.trim(), slug: request.body.slug, role: "owner" });
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          await reply.code(409).send({ error: "slug_unavailable" });
          return;
        }
        throw error;
      }
    },
  );
}
