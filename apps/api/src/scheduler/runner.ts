import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  type EngineProjectInputV1,
  type EngineScheduleResultV1,
  isRfc3339Instant,
} from "@engineo/contracts";
import { SCHEDULE_JSON_MAX_BYTES } from "./size.js";

export interface ScheduleRunner {
  calculate(input: EngineProjectInputV1, signal?: AbortSignal): Promise<EngineScheduleResultV1>;
}
export class ScheduleEngineError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: 409 | 422 | 503,
    message: string,
  ) {
    super(message);
  }
}
export interface ProcessScheduleRunnerOptions {
  binaryPath?: string;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxConcurrent?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function instant(value: unknown): value is string {
  return typeof value === "string" && isRfc3339Instant(value);
}
export function isValidScheduleResult(
  value: unknown,
  input: EngineProjectInputV1,
): value is EngineScheduleResultV1 {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !instant(value.projectFinish) ||
    !instant(value.lateProjectFinish) ||
    !record(value.activities) ||
    !Array.isArray(value.controllingPath) ||
    !Array.isArray(value.constraintViolations)
  )
    return false;
  const ids = new Set(input.activities.map((activity) => activity.id));
  if (
    Object.keys(value.activities).length !== ids.size ||
    (value.controllingFinishActivity !== null &&
      !ids.has(String(value.controllingFinishActivity))) ||
    value.controllingPath.some((id) => typeof id !== "string" || !ids.has(id))
  )
    return false;
  for (const id of ids) {
    const row = value.activities[id];
    if (
      !record(row) ||
      !instant(row.earlyStart) ||
      !instant(row.earlyFinish) ||
      !instant(row.lateStart) ||
      !instant(row.lateFinish) ||
      typeof row.critical !== "boolean" ||
      !Number.isSafeInteger(row.totalFloatMinutes) ||
      !Number.isSafeInteger(row.freeFloatMinutes) ||
      !Array.isArray(row.drivingCauses)
    )
      return false;
    for (const cause of row.drivingCauses) {
      if (
        !record(cause) ||
        typeof cause.kind !== "string" ||
        (cause.predecessorId !== undefined &&
          (typeof cause.predecessorId !== "string" || !ids.has(cause.predecessorId))) ||
        (cause.relationshipType !== undefined &&
          !["FS", "SS", "FF", "SF"].includes(String(cause.relationshipType))) ||
        (cause.constraintType !== undefined && typeof cause.constraintType !== "string") ||
        (cause.instant !== undefined && !instant(cause.instant)) ||
        (cause.lagMinutes !== undefined && !Number.isSafeInteger(cause.lagMinutes))
      )
        return false;
    }
  }
  return value.constraintViolations.every(
    (row) =>
      record(row) &&
      typeof row.activityId === "string" &&
      ids.has(row.activityId) &&
      typeof row.constraintType === "string" &&
      instant(row.constraintInstant) &&
      instant(row.actualInstant),
  );
}

export class ProcessScheduleRunner implements ScheduleRunner {
  private readonly binaryPath: string;
  private readonly timeoutMs: number;
  private readonly maxInputBytes: number;
  private readonly maxOutputBytes: number;
  private readonly maxConcurrent: number;
  private active = 0;
  private readonly projects = new Set<string>();

  constructor(options: ProcessScheduleRunnerOptions = {}) {
    this.binaryPath = options.binaryPath ?? process.env.ENGINEO_SCHEDULER_BIN ?? "engineo-schedule";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxInputBytes = options.maxInputBytes ?? SCHEDULE_JSON_MAX_BYTES;
    this.maxOutputBytes = options.maxOutputBytes ?? SCHEDULE_JSON_MAX_BYTES;
    this.maxConcurrent = options.maxConcurrent ?? 2;
    for (const value of [
      this.timeoutMs,
      this.maxInputBytes,
      this.maxOutputBytes,
      this.maxConcurrent,
    ]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Invalid engine boundary configuration");
    }
  }

  async calculate(
    input: EngineProjectInputV1,
    signal?: AbortSignal,
  ): Promise<EngineScheduleResultV1> {
    if (signal?.aborted)
      throw new ScheduleEngineError("schedule_cancelled", 409, "Calculation was cancelled.");
    const payload = JSON.stringify(input);
    if (Buffer.byteLength(payload, "utf8") > this.maxInputBytes) {
      throw new ScheduleEngineError(
        "schedule_too_large",
        422,
        "Schedule exceeds the configured calculation size.",
      );
    }
    if (this.projects.has(input.project.id)) {
      throw new ScheduleEngineError(
        "schedule_already_running",
        409,
        "A calculation is already running for this project.",
      );
    }
    if (this.active >= this.maxConcurrent) {
      throw new ScheduleEngineError(
        "schedule_busy",
        503,
        "Calculation capacity is busy. Retry shortly.",
      );
    }
    this.active++;
    this.projects.add(input.project.id);
    return await new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.binaryPath, [], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { PATH: process.env.PATH },
          windowsHide: true,
        });
      } catch {
        this.active--;
        this.projects.delete(input.project.id);
        reject(
          new ScheduleEngineError(
            "schedule_unavailable",
            503,
            "Calculation engine could not start.",
          ),
        );
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const fail = (error: ScheduleEngineError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        child.kill("SIGKILL");
        reject(error);
      };
      const abort = () =>
        fail(new ScheduleEngineError("schedule_cancelled", 409, "Calculation was cancelled."));
      const timer = setTimeout(
        () =>
          fail(
            new ScheduleEngineError(
              "schedule_timeout",
              503,
              "Calculation exceeded its deadline. Retry or reduce the schedule size.",
            ),
          ),
        this.timeoutMs,
      );
      timer.unref();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.on("error", () =>
        fail(
          new ScheduleEngineError(
            "schedule_unavailable",
            503,
            "Calculation engine is unavailable.",
          ),
        ),
      );
      child.stdin.on("error", () =>
        fail(
          new ScheduleEngineError("schedule_unavailable", 503, "Calculation engine input failed."),
        ),
      );
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.maxOutputBytes)
          fail(
            new ScheduleEngineError(
              "schedule_output_limit",
              503,
              "Calculation output exceeds the configured size.",
            ),
          );
        else stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > this.maxOutputBytes)
          fail(
            new ScheduleEngineError(
              "schedule_output_limit",
              503,
              "Calculation diagnostics exceed the configured size.",
            ),
          );
        else stderr.push(chunk);
      });
      child.on("close", (code) => {
        // Hold admission until process exit, including cancelled/timed-out jobs.
        this.active--;
        this.projects.delete(input.project.id);
        if (settled) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        settled = true;
        if (code !== 0) {
          try {
            const error: unknown = JSON.parse(Buffer.concat(stderr).toString("utf8"));
            if (
              record(error) &&
              error.error === "schedule_calculation_failed" &&
              typeof error.message === "string"
            ) {
              reject(
                new ScheduleEngineError("invalid_schedule", 422, error.message.slice(0, 2000)),
              );
              return;
            }
          } catch {
            /* Unexpected diagnostics are not returned to the caller. */
          }
          reject(
            new ScheduleEngineError("schedule_unavailable", 503, "Calculation engine failed."),
          );
          return;
        }
        try {
          const result: unknown = JSON.parse(Buffer.concat(stdout).toString("utf8"));
          if (!isValidScheduleResult(result, input)) throw new Error("Invalid result contract");
          resolve(result);
        } catch {
          reject(
            new ScheduleEngineError(
              "schedule_invalid_output",
              503,
              "Calculation engine returned an invalid result.",
            ),
          );
        }
      });
      child.stdin.end(payload);
    });
  }
}
