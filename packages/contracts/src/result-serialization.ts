import type { EngineScheduleResultV1 } from "./result.js";

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortedJson(entry)]),
    );
  return value;
}

/** Compact UTF-8 JSON with recursively sorted object keys; array order is retained. */
export function serializeScheduleResultV1(result: EngineScheduleResultV1): string {
  return JSON.stringify(sortedJson(result));
}
