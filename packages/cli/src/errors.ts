export const EXIT = {
  success: 0,
  usage: 2,
  validation: 3,
  conflict: 4,
  auth: 5,
  capacity: 6,
  uncertain: 7,
  transport: 8,
  integrity: 9,
  unavailable: 10,
  interrupted: 130,
} as const;
export type ExitCategory = keyof typeof EXIT;

/** Messages are authored locally. Never expose fetch, filesystem or server exception text. */
export class CliError extends Error {
  constructor(
    public readonly category: ExitCategory,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "CliError";
  }
}
export function integrity(): never {
  throw new CliError(
    "integrity",
    "invalid_response",
    "Response or saved artifact failed integrity checks.",
  );
}

const REMOTE_CODES = new Set([
  "unauthenticated",
  "forbidden",
  "csrf_validation_failed",
  "origin_not_allowed",
  "session_intent_required",
  "session_changed",
  "revision_conflict",
  "configuration_base_changed",
  "configuration_idempotency_conflict",
  "configuration_review_changed",
  "configuration_expired",
  "configuration_cancelled",
  "configuration_not_terminal",
  "configuration_interrupted",
  "configuration_plan_not_found",
  "configuration_id_conflict",
  "configuration_artifact_unavailable",
  "configuration_capacity",
  "configuration_rate_limit",
  "configuration_integrity_error",
  "configuration_invalid",
  "schedule_cancelled",
  "schedule_timeout",
  "schedule_busy",
  "schedule_already_running",
  "schedule_calculation_failed",
  "schedule_output_limit",
  "schedule_invalid_output",
  "schedule_unavailable",
  "schedule_too_large",
  "invalid_schedule",
  "invalid_reference_or_value",
  "resource_not_found",
  "project_not_found",
  "temporarily_unavailable",
  "internal_error",
  "view_invalid",
  "view_not_found",
  "view_reference_stale",
  "view_result_required",
  "view_integrity_error",
  "view_projection_too_large",
  "view_base_changed",
  "view_review_changed",
  "view_review_expired",
  "view_operation_window_closed",
  "view_operation_expired",
  "view_idempotency_conflict",
  "view_capacity",
  "view_rate_limit",
  "view_revision_exhausted",
]);
export function remoteError(status: number, value: unknown): CliError {
  const raw = typeof value === "object" && value !== null && "error" in value ? value.error : null;
  const code = typeof raw === "string" && REMOTE_CODES.has(raw) ? raw : "remote_error";
  const category: ExitCategory =
    status === 401 ||
    status === 403 ||
    code === "session_changed" ||
    code === "session_intent_required"
      ? "auth"
      : status === 429 || code === "schedule_busy" || code === "schedule_already_running"
        ? "capacity"
        : code === "configuration_interrupted" || code === "schedule_cancelled"
          ? "interrupted"
          : code === "configuration_integrity_error" ||
              code === "schedule_invalid_output" ||
              code === "view_integrity_error"
            ? "integrity"
            : status === 409
              ? "conflict"
              : status === 413 || status === 422 || status === 400
                ? "validation"
                : "unavailable";
  return new CliError(category, code, "API rejected the request.", { httpStatus: status });
}
