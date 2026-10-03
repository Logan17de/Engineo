import assert from "node:assert/strict";
import test from "node:test";
import type { EngineScheduleResultV1 } from "./result.js";
import { serializeScheduleResultV1 } from "./result-serialization.js";

test("result serialization ignores object insertion order and preserves array ordering", () => {
  const result: EngineScheduleResultV1 = {
    schemaVersion: 1,
    projectFinish: "2026-10-05T17:00:00Z",
    lateProjectFinish: "2026-10-05T17:00:00Z",
    controllingFinishActivity: null,
    controllingPath: ["b", "a"],
    activities: {},
    constraintViolations: [],
  };
  const reordered = Object.fromEntries(
    Object.entries(result).reverse(),
  ) as unknown as EngineScheduleResultV1;
  assert.equal(serializeScheduleResultV1(reordered), serializeScheduleResultV1(result));
  assert.notEqual(
    serializeScheduleResultV1({ ...result, controllingPath: ["a", "b"] }),
    serializeScheduleResultV1(result),
  );
  assert.equal(serializeScheduleResultV1(result).endsWith("\n"), false);
});
