import type { EngineProjectInputV1 } from "@engineo/contracts";

/** Only a same-user local recovery snapshot; validation refuses it before schedule save. */
export function withIncompleteDurations(
  input: EngineProjectInputV1,
  drafts: ReadonlyMap<string, string>,
): EngineProjectInputV1 {
  if (drafts.size === 0) return input;
  return {
    ...input,
    activities: input.activities.map((activity) =>
      drafts.has(activity.id)
        ? {
            ...activity,
            durationMinutes:
              drafts.get(activity.id) === "" ? Number.NaN : Number(drafts.get(activity.id)),
          }
        : activity,
    ),
  };
}
