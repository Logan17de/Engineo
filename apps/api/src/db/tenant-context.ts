export interface TenantContext {
  organizationId: string;
  actorId: string | null;
  correlationId: string | null;
}

export function tenantContext(
  organizationId: string,
  actorId: string | null = null,
  correlationId: string | null = null,
): TenantContext {
  if (!organizationId) {
    throw new Error("organizationId is required");
  }

  return {
    organizationId,
    actorId,
    correlationId,
  };
}
