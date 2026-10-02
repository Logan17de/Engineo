import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EngineProjectInputV1 } from "@engineo/contracts";
import { ProcessScheduleRunner, ScheduleEngineError } from "./runner.js";

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
