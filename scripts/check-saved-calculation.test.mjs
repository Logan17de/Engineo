import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { serializeScheduleInputV1, serializeScheduleResultV1 } from "@engineo/contracts";
import { matchesStoredCalculation } from "../apps/web/app/planner/saved-calculation.ts";

const input = JSON.parse(
  await readFile(new URL("../fixtures/contracts/v1/minimal-project.json", import.meta.url), "utf8"),
);
const hash = (text) => createHash("sha256").update(text).digest("hex");
function saved() {
  const instant = "2026-10-05T08:00:00Z";
  const result = {
    schemaVersion: 1,
    projectFinish: instant,
    lateProjectFinish: instant,
    controllingFinishActivity: null,
    controllingPath: [],
    activities: {},
    constraintViolations: [],
  };
  return {
    revision: 2,
    result,
    calculation: {
      schemaVersion: 1,
      calculationId: "60d8a71b-2039-4482-a51a-6e4f2d30b153",
      projectRevision: 2,
      inputHashSha256: hash(serializeScheduleInputV1(input)),
      resultHashSha256: hash(serializeScheduleResultV1(result)),
      engineContractVersion: 1,
      engineVersion: "engineo-scheduling/0.1.0",
      calculatedAt: instant,
    },
  };
}
const expected = { revision: 2, input };

test("saved calculation checks require current revision, metadata and matching hashes", async () => {
  assert.equal(await matchesStoredCalculation(saved(), expected), true);
  assert.equal(await matchesStoredCalculation({ ...saved(), revision: 3 }, expected), false);
  const wrong = saved();
  wrong.calculation.projectRevision = 3;
  assert.equal(await matchesStoredCalculation(wrong, expected), false);
});

test("same-revision inputs and tampered result bodies cannot reuse a saved calculation", async () => {
  const changedInput = structuredClone(input);
  changedInput.project.name = "Unsaved draft";
  assert.equal(
    await matchesStoredCalculation(saved(), { revision: 2, input: changedInput }),
    false,
  );
  const changedResult = saved();
  changedResult.result.projectFinish = "2026-10-06T08:00:00Z";
  assert.equal(await matchesStoredCalculation(changedResult, expected), false);
});

test("saved calculation hashing remains stable after JSON object key reordering", async () => {
  const reordered = saved();
  reordered.result = Object.fromEntries(Object.entries(reordered.result).reverse());
  assert.equal(await matchesStoredCalculation(reordered, expected), true);
});

test("browser engine identity bounds match the API's 128-character ASCII contract", async () => {
  const maximum = saved();
  maximum.calculation.engineVersion = "a".repeat(128);
  assert.equal(await matchesStoredCalculation(maximum, expected), true);
  maximum.calculation.engineVersion = "a".repeat(129);
  assert.equal(await matchesStoredCalculation(maximum, expected), false);
  maximum.calculation.engineVersion = "engine version with spaces";
  assert.equal(await matchesStoredCalculation(maximum, expected), false);
});

test("incomplete, malformed or incompatible calculation metadata fails closed", async () => {
  for (const value of [
    null,
    {},
    { ...saved(), calculation: null },
    { ...saved(), result: null },
    { ...saved(), calculation: { ...saved().calculation, engineContractVersion: 2 } },
    { ...saved(), calculation: { ...saved().calculation, calculatedAt: "invalid" } },
    { ...saved(), calculation: { ...saved().calculation, engineVersion: "" } },
    { ...saved(), calculation: { ...saved().calculation, inputHashSha256: "invalid" } },
    { ...saved(), calculation: { ...saved().calculation, resultHashSha256: "invalid" } },
  ]) {
    assert.equal(await matchesStoredCalculation(value, expected), false);
  }
});
