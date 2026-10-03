import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EngineProjectInputV1 } from "@engineo/contracts";
import { ProcessScheduleRunner, ScheduleEngineError, validResult } from "./runner.js";

const input: EngineProjectInputV1 = {
  schemaVersion: 1,
  project: {
    id: "runner-test",
    name: "Runner",
    plannedStart: "2026-10-05T08:00:00Z",
    dataDate: "2026-10-05T08:00:00Z",
    requiredFinish: null,
    defaultCalendarId: "calendar",
  },
  scheduleOptions: {
    criticalFloatThresholdMinutes: 0,
    lagCalendarPolicy: "PROJECT",
    projectFinishPolicy: "CALCULATED",
  },
  calendars: [],
  wbs: [],
  activities: [],
  relationships: [],
};
const result = {
  schemaVersion: 1,
  projectFinish: input.project.plannedStart,
  lateProjectFinish: input.project.plannedStart,
  controllingFinishActivity: null,
  controllingPath: [],
  activities: {},
  constraintViolations: [],
};
const isError = (code: string) => (error: unknown) =>
  error instanceof ScheduleEngineError && error.code === code;

test("result scalar ID and relationship fields never coerce array-valued output", () => {
  const scoped = {
    ...input,
    activities: [
      {
        id: "activity",
        wbsId: "wbs",
        calendarId: "calendar",
        name: "Activity",
        kind: "TASK" as const,
        durationMinutes: 480,
        constraints: [],
      },
    ],
  };
  const row = {
    earlyStart: input.project.plannedStart,
    earlyFinish: input.project.plannedStart,
    lateStart: input.project.plannedStart,
    lateFinish: input.project.plannedStart,
    totalFloatMinutes: 0,
    freeFloatMinutes: 0,
    critical: true,
    drivingCauses: [],
  };
  const valid = { ...result, controllingFinishActivity: "activity", activities: { activity: row } };
  assert.equal(validResult(valid, scoped), true);
  assert.equal(validResult({ ...valid, controllingFinishActivity: ["activity"] }, scoped), false);
  assert.equal(
    validResult(
      {
        ...valid,
        activities: {
          activity: {
            ...row,
            drivingCauses: [
              { kind: "RELATIONSHIP", predecessorId: "activity", relationshipType: ["FS"] },
            ],
          },
        },
      },
      scoped,
    ),
    false,
  );
  let nested: unknown = "activity";
  for (let depth = 0; depth < 10_000; depth++) nested = [nested];
  assert.equal(validResult({ ...valid, controllingFinishActivity: nested }, scoped), false);
});

test("engine identity is bounded, retryable, cached and pinned on the calculating process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "engineo-identity-"));
  const binary = join(directory, "engine");
  const version = "engineo-scheduling/test-build";
  try {
    const write = (code: string) =>
      writeFile(binary, `#!/usr/bin/env node\n${code}\n`, { mode: 0o700 });
    const runner = new ProcessScheduleRunner({ binaryPath: binary, timeoutMs: 200 });
    await write("console.log('{}')");
    await assert.rejects(runner.getEngineVersion(), isError("schedule_unavailable"));
    await write(`if (process.argv[2] === '--engine-info') console.log(${JSON.stringify(JSON.stringify({ engineVersion: version, engineContractVersion: 1 }))});
      else if (process.argv[2] === '--engine-version' && process.argv[3] === ${JSON.stringify(version)}) console.log(${JSON.stringify(JSON.stringify(result))});
      else process.exit(1);`);
    assert.equal(await runner.getEngineVersion(), version);
    assert.deepEqual(await runner.calculate(input), result);
    assert.equal(await runner.getEngineVersion(), version);
    await write("console.log('x'.repeat(5000))");
    await assert.rejects(
      new ProcessScheduleRunner({ binaryPath: binary }).getEngineVersion(),
      isError("schedule_unavailable"),
    );
    await write("setTimeout(() => {}, 10000)");
    await assert.rejects(
      new ProcessScheduleRunner({ binaryPath: binary, timeoutMs: 50 }).getEngineVersion(),
      isError("schedule_unavailable"),
    );
    await assert.rejects(
      new ProcessScheduleRunner({ binaryPath: "" }).getEngineVersion(),
      isError("schedule_unavailable"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("process boundary rejects invalid, oversized and unexpected output without exposing diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "engineo-runner-"));
  const binary = join(directory, "engine");
  try {
    const write = (code: string) =>
      writeFile(binary, `#!/usr/bin/env node\nprocess.stdin.resume();\n${code}\n`, { mode: 0o700 });
    const runner = new ProcessScheduleRunner({ binaryPath: binary, maxOutputBytes: 512 });
    await write("console.log('{}')");
    await assert.rejects(runner.calculate(input), isError("schedule_invalid_output"));
    await write("console.log('x'.repeat(1024))");
    await assert.rejects(runner.calculate(input), isError("schedule_output_limit"));
    // Slots are released on process close, which follows output rejection.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await write("console.error('private internal diagnostics'); process.exit(1)");
    await assert.rejects(
      runner.calculate(input),
      (error) => isError("schedule_unavailable")(error) && !String(error).includes("private"),
    );
    await write(`console.log(${JSON.stringify(JSON.stringify(result))})`);
    assert.deepEqual(await runner.calculate(input), result);
    const bounded = new ProcessScheduleRunner({ binaryPath: binary, maxInputBytes: 10 });
    await assert.rejects(bounded.calculate(input), isError("schedule_too_large"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("extra nested result properties are rejected before canonical persistence serialization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "engineo-result-depth-"));
  const binary = join(directory, "engine");
  try {
    const unexpected =
      JSON.stringify(result).slice(0, -1) +
      ',"extra":' +
      '{"nested":'.repeat(10_000) +
      "0" +
      "}".repeat(10_000) +
      "}";
    await writeFile(
      binary,
      `#!/usr/bin/env node\nprocess.stdin.resume(); console.log(${JSON.stringify(unexpected)});\n`,
      { mode: 0o700 },
    );
    await assert.rejects(
      new ProcessScheduleRunner({ binaryPath: binary }).calculate(input),
      isError("schedule_invalid_output"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("timeout, cancellation and repeated calculations bound process admission and recover", async () => {
  const directory = await mkdtemp(join(tmpdir(), "engineo-runner-"));
  const binary = join(directory, "engine");
  try {
    await writeFile(
      binary,
      "#!/usr/bin/env node\nprocess.stdin.resume();\nsetTimeout(() => {}, 10000);\n",
      { mode: 0o700 },
    );
    const runner = new ProcessScheduleRunner({
      binaryPath: binary,
      maxConcurrent: 1,
      timeoutMs: 300,
    });
    const pending = runner.calculate(input);
    await assert.rejects(runner.calculate(input), isError("schedule_already_running"));
    await assert.rejects(
      runner.calculate({ ...input, project: { ...input.project, id: "second" } }),
      isError("schedule_busy"),
    );
    await assert.rejects(pending, isError("schedule_timeout"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const controller = new AbortController();
    const cancelled = runner.calculate(input, controller.signal);
    controller.abort();
    await assert.rejects(cancelled, isError("schedule_cancelled"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await writeFile(
      binary,
      `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(result))});\n`,
      { mode: 0o700 },
    );
    assert.deepEqual(await runner.calculate(input), result);
    await assert.rejects(
      runner.calculate(input, AbortSignal.abort()),
      isError("schedule_cancelled"),
    );
    const missing = new ProcessScheduleRunner({ binaryPath: join(directory, "missing") });
    await assert.rejects(missing.calculate(input), isError("schedule_unavailable"));
    const invalid = new ProcessScheduleRunner({ binaryPath: "" });
    await assert.rejects(invalid.calculate(input), isError("schedule_unavailable"));
    await assert.rejects(invalid.calculate(input), isError("schedule_unavailable"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
