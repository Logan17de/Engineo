import type { PlannerViewDiagnosticsV1 } from "@engineo/contracts";

export class PlannerViewError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    public readonly diagnostics?: PlannerViewDiagnosticsV1,
  ) {
    super(code);
  }
}

export function assertViewNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PlannerViewError("view_interrupted", 409);
}

/** Configuration values, unknown keys and source exception text never leave this boundary. */
export function safeViewDiagnostics(value: PlannerViewDiagnosticsV1): PlannerViewDiagnosticsV1 {
  return {
    issues: value.issues.slice(0, 20).map(({ code }) => ({
      code,
      path: "",
      message: "Invalid private view request.",
    })),
    totalCount: value.totalCount,
    truncated: value.totalCount > 20,
  };
}
