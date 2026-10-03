import { createHash } from "node:crypto";
import {
  type ProjectConfigurationPlanReadV1,
  type ProjectConfigurationPlanV1,
  type ProjectConfigurationReadV1,
  type ProjectConfigurationReceiptV1,
  serializeProjectConfigurationReviewV1,
  serializeScheduleInputV1,
  validateProjectConfigurationPlanReadV1,
  validateProjectConfigurationPlanV1,
  validateProjectConfigurationReadV1,
  validateProjectConfigurationReceiptV1,
} from "@engineo/contracts";
import type { Destination } from "./arguments.js";
import { CliError, integrity } from "./errors.js";
import { exactKeys, record, rejectCredentials } from "./json.js";
import type { SessionMaterial } from "./transport.js";

export function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
export interface SavedReviewV1 {
  schemaVersion: 1;
  kind: "engineo-cli-reviewed-plan";
  destination: Destination;
  plan: ProjectConfigurationPlanV1;
}
export function checkRead(value: unknown, projectId: string): ProjectConfigurationReadV1 {
  if (
    !validateProjectConfigurationReadV1(value) ||
    value.configuration.input.project.id !== projectId ||
    hash(serializeScheduleInputV1(value.configuration.input)) !== value.inputHashSha256
  )
    integrity();
  return value;
}
export function checkPlan(
  value: unknown,
  target: Destination,
  session: SessionMaterial,
  planId?: string,
): ProjectConfigurationPlanV1 {
  if (
    !validateProjectConfigurationPlanV1(value) ||
    value.organizationId !== target.organizationId ||
    value.projectId !== target.projectId ||
    value.actorId !== session.actorId ||
    value.sessionId !== session.sessionId ||
    (planId !== undefined && value.planId !== planId) ||
    hash(serializeProjectConfigurationReviewV1(value)) !== value.reviewedDigest ||
    hash(serializeScheduleInputV1(value.configuration.input)) !== value.desiredInputHashSha256
  )
    integrity();
  rejectCredentials(value, [session.sessionToken, session.csrfToken]);
  return value;
}
export function checkPlanRead(
  value: unknown,
  target: Destination,
  session: SessionMaterial,
  planId: string,
): ProjectConfigurationPlanReadV1 {
  if (!validateProjectConfigurationPlanReadV1(value) || value.planId !== planId) integrity();
  if (value.plan) checkPlan(value.plan, target, session, planId);
  if (value.receipt) checkReceipt(value.receipt, target, planId, value.plan ?? undefined);
  return value;
}
export function checkReceipt(
  value: unknown,
  target: Destination,
  planId: string,
  plan?: ProjectConfigurationPlanV1,
): ProjectConfigurationReceiptV1 {
  if (
    !validateProjectConfigurationReceiptV1(value) ||
    value.organizationId !== target.organizationId ||
    value.projectId !== target.projectId ||
    value.planId !== planId
  )
    integrity();
  if (
    plan &&
    (value.previousRevision !== plan.baseRevision ||
      value.baseInputHashSha256 !== plan.baseInputHashSha256 ||
      value.reviewedDigest !== plan.reviewedDigest ||
      (value.outcome !== "cancelled" &&
        (value.committedInputHashSha256 !== plan.desiredInputHashSha256 ||
          value.outcome !== (plan.noOp ? "no_op" : "applied") ||
          value.committedRevision !== plan.baseRevision + (plan.noOp ? 0 : 1))))
  )
    integrity();
  return value;
}
export function savedReview(plan: ProjectConfigurationPlanV1, target: Destination): SavedReviewV1 {
  return { schemaVersion: 1, kind: "engineo-cli-reviewed-plan", destination: target, plan };
}
export function checkSavedReview(
  value: unknown,
  target: Destination,
  session: SessionMaterial,
  expectedRevision: number,
): SavedReviewV1 {
  if (
    !record(value) ||
    !exactKeys(value, ["schemaVersion", "kind", "destination", "plan"]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "engineo-cli-reviewed-plan" ||
    !record(value.destination) ||
    !exactKeys(value.destination, ["apiOrigin", "appOrigin", "organizationId", "projectId"])
  )
    integrity();
  for (const key of ["apiOrigin", "appOrigin", "organizationId", "projectId"] as const) {
    if (value.destination[key] !== target[key])
      throw new CliError(
        "conflict",
        "review_destination_mismatch",
        "Saved review does not match the explicit destination and project.",
      );
  }
  if (
    record(value.plan) &&
    (value.plan.actorId !== session.actorId || value.plan.sessionId !== session.sessionId)
  )
    throw new CliError(
      "auth",
      "review_identity_mismatch",
      "Saved review belongs to a different actor or original session.",
    );
  const plan = checkPlan(value.plan, target, session);
  if (plan.baseRevision !== expectedRevision)
    throw new CliError(
      "conflict",
      "review_revision_mismatch",
      "Expected revision does not match the saved review.",
    );
  return savedReview(plan, target);
}
