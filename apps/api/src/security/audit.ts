import { randomUUID } from "node:crypto";
import type { Database } from "../db/client.js";

export interface AuditEventInput {
  organizationId: string;
  actorType: "user" | "service" | "system";
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  source: string;
  correlationId: string | null;
  payload?: Record<string, unknown>;
}

export async function appendAuditEvent(db: Database, event: AuditEventInput): Promise<void> {
  await db`
    INSERT INTO audit_events (
      id, organization_id, actor_type, actor_id, action,
      resource_type, resource_id, source, correlation_id, payload
    )
    VALUES (
      ${randomUUID()},
      ${event.organizationId},
      ${event.actorType},
      ${event.actorId},
      ${event.action},
      ${event.resourceType},
      ${event.resourceId},
      ${event.source},
      ${event.correlationId},
      ${db.json(event.payload ?? {})}
    )
  `;
}
