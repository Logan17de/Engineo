import {
  type EngineProjectInputV1,
  type EngineScheduleResultV1,
  type PlannerProjectionV1,
  type PlannerViewConfigurationV1,
  type ScheduleCalculationMetadataV1,
  projectPlannerPresentationV1,
  serializeScheduleInputV1,
} from "@engineo/contracts";
import type { SavedViewScope } from "./saved-view-controller";
import { checkSavedViewProjection, checkedViewConfiguration } from "./saved-view-protocol";
import { matchesStoredCalculation } from "./saved-calculation";

export const viewNeedsCalculation = (config: PlannerViewConfigurationV1): boolean =>
  config.presentation.critical !== "all" ||
  config.presentation.sort.field === "earlyStart" ||
  config.presentation.sort.field === "totalFloatMinutes";
export interface GuiViewSource {
  scope: SavedViewScope;
  input: EngineProjectInputV1;
  dirty: boolean;
  result: EngineScheduleResultV1 | null;
  calculation: ScheduleCalculationMetadataV1 | null;
  configuration: PlannerViewConfigurationV1;
  savedConfigHash: string | null;
}
export type ProjectionRequest = (
  path: string,
  body: unknown,
  signal: AbortSignal,
) => Promise<unknown>;
const unavailable = (
  reason: "source_invalid" | "input_unsaved" | "calculation_missing" | "calculation_stale",
): PlannerProjectionV1 => ({
  available: false,
  error: reason === "source_invalid" ? "view_invalid" : "view_result_required",
  reason,
});

/** Input-only drafts are local. Calculated ordering consumes only a coherent saved API projection. */
export async function projectGuiSavedView(
  source: GuiViewSource,
  request: ProjectionRequest,
  signal: AbortSignal,
): Promise<PlannerProjectionV1> {
  const checked = await checkedViewConfiguration(source.configuration);
  let inputHash: string;
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(serializeScheduleInputV1(source.input)),
    );
    inputHash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    return unavailable("source_invalid");
  }
  signal.throwIfAborted();
  const snapshot = {
    organizationId: source.scope.organizationId,
    projectId: source.scope.projectId,
    scheduleRevision: source.scope.scheduleRevision,
    inputHashSha256: inputHash,
    inputState: source.dirty ? ("unsaved" as const) : ("saved" as const),
    currentEngineVersion: null,
    input: source.input,
  };
  if (!viewNeedsCalculation(checked.configuration)) {
    return projectPlannerPresentationV1(snapshot, null, {
      projectionVersion: 1,
      normalizationVersion: 1,
      configHashSha256: source.savedConfigHash,
      presentation: checked.configuration.presentation,
    });
  }
  if (source.dirty) return unavailable("input_unsaved");
  if (!source.calculation || !source.result) return unavailable("calculation_missing");
  if (
    !(await matchesStoredCalculation(
      {
        revision: source.scope.scheduleRevision,
        result: source.result,
        calculation: source.calculation,
      },
      { revision: source.scope.scheduleRevision, input: source.input },
    ))
  )
    return unavailable("calculation_stale");
  signal.throwIfAborted();
  const path = `/organizations/${source.scope.organizationId}/projects/${source.scope.projectId}/views/projection`;
  const projected = await checkSavedViewProjection(
    await request(
      path,
      {
        configuration: checked.configuration,
        expectedScheduleRevision: source.scope.scheduleRevision,
      },
      signal,
    ),
    {
      organizationId: source.scope.organizationId,
      projectId: source.scope.projectId,
      scheduleRevision: source.scope.scheduleRevision,
      inputHashSha256: inputHash,
      configHashSha256: checked.configHashSha256,
    },
    checked.configuration,
  );
  signal.throwIfAborted();
  const binding = projected.binding.calculation;
  const metadata = source.calculation;
  if (
    !binding ||
    binding.calculationId !== metadata.calculationId ||
    binding.resultHashSha256 !== metadata.resultHashSha256 ||
    binding.engineContractVersion !== metadata.engineContractVersion ||
    binding.engineVersion !== metadata.engineVersion
  )
    return unavailable("calculation_stale");
  // The authenticated projection declares the current compatible engine; the cached result
  // must independently match its hashes, complete rows and exact shared projection.
  const local = projectPlannerPresentationV1(
    { ...snapshot, currentEngineVersion: binding.engineVersion },
    {
      verification: "caller-verified-current-engine",
      organizationId: source.scope.organizationId,
      projectId: source.scope.projectId,
      metadata,
      result: source.result,
    },
    {
      projectionVersion: 1,
      normalizationVersion: 1,
      configHashSha256: checked.configHashSha256,
      presentation: checked.configuration.presentation,
    },
  );
  if (!local.available || JSON.stringify(local) !== JSON.stringify(projected))
    return unavailable("calculation_stale");
  return projected;
}
