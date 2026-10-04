import type { PlannerProjectionV1 } from "@engineo/contracts";
import { useEffect, useMemo, useState } from "react";
import { ApiError, currentSessionId, sessionCookieChanged } from "./api";
import { savedViewProjectionRequest } from "./SavedViewsPanel";
import {
  type GuiViewSource,
  projectGuiInputOnly,
  projectGuiSavedView,
  viewNeedsCalculation,
} from "./saved-view-projection";

export function useSavedViewProjection(
  source: GuiViewSource | null,
  native: boolean,
  onSessionFailure: (error: ApiError) => void,
) {
  const [state, setState] = useState<{
    projection: PlannerProjectionV1 | null;
    source: GuiViewSource | null;
    error: string;
  }>({ projection: null, source: null, error: "" });
  const calculated = source !== null && viewNeedsCalculation(source.configuration);
  const local = useMemo(
    () => (source && !native && !calculated ? projectGuiInputOnly(source) : undefined),
    [source, native, calculated],
  );
  useEffect(() => {
    if (!source || native || !calculated || source.dirty) {
      setState({ projection: null, source: null, error: "" });
      return;
    }
    const controller = new AbortController();
    void projectGuiSavedView(source, savedViewProjectionRequest, controller.signal)
      .then((projection) => {
        if (!controller.signal.aborted) {
          if (currentSessionId() !== source.scope.sessionId || sessionCookieChanged()) {
            onSessionFailure(
              new ApiError(
                409,
                "session_changed",
                "Your sign-in changed. Sign in again before opening private views.",
              ),
            );
            return;
          }
          setState({ projection, source, error: "" });
        }
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403 || error.code === "session_changed")
        )
          onSessionFailure(error);
        setState({
          projection: { available: false, error: "view_invalid", reason: "source_invalid" },
          source,
          error:
            error instanceof ApiError
              ? error.message
              : "The presentation could not be verified. Adjust its settings or use Native.",
        });
      });
    return () => controller.abort();
  }, [source, native, calculated, onSessionFailure]);
  // No old filter, row order, group header or calculation is combined with a newer source.
  if (native) return { projection: undefined, pending: false, error: "" };
  if (!calculated) return { projection: local ?? null, pending: false, error: "" };
  if (source?.dirty)
    return {
      projection: {
        available: false,
        error: "view_result_required",
        reason: "input_unsaved",
      } as PlannerProjectionV1,
      pending: false,
      error: "",
    };
  return {
    projection: state.source === source ? state.projection : null,
    pending: state.source !== source,
    error: state.source === source ? state.error : "",
  };
}
