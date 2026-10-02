import { spawn } from "node:child_process";
import type { EngineProjectInputV1 } from "@engineo/contracts";

export interface ScheduleRunner {
  calculate(input: EngineProjectInputV1): Promise<unknown>;
}

export interface ProcessScheduleRunnerOptions {
  binaryPath?: string;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
}

export class ProcessScheduleRunner implements ScheduleRunner {
  private readonly binaryPath: string;
  private readonly timeoutMs: number;
  private readonly maxInputBytes: number;
  private readonly maxOutputBytes: number;

  constructor(options: ProcessScheduleRunnerOptions = {}) {
    this.binaryPath = options.binaryPath ?? process.env.ENGINEO_SCHEDULER_BIN ?? "engineo-schedule";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxInputBytes = options.maxInputBytes ?? 32 * 1024 * 1024;
    this.maxOutputBytes = options.maxOutputBytes ?? 32 * 1024 * 1024;
  }

  async calculate(input: EngineProjectInputV1): Promise<unknown> {
    const payload = JSON.stringify(input);
    if (Buffer.byteLength(payload, "utf8") > this.maxInputBytes) {
      throw new Error("Schedule input exceeds configured engine boundary limit.");
    }

    return await new Promise((resolve, reject) => {
      const child = spawn(this.binaryPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
        },
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const rejectOnce = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(error);
      };

      const timer = setTimeout(() => {
        rejectOnce(new Error("Schedule engine timed out."));
      }, this.timeoutMs);
      timer.unref();

      child.on("error", (error) => {
        rejectOnce(new Error(`Failed to start schedule engine: ${error.message}`));
      });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > this.maxOutputBytes) {
          rejectOnce(new Error("Schedule engine output exceeded configured limit."));
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (Buffer.byteLength(stderr, "utf8") > this.maxOutputBytes) {
          rejectOnce(new Error("Schedule engine error output exceeded configured limit."));
        }
      });

      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);

        if (code !== 0) {
          reject(new Error(`Schedule engine failed: ${stderr.trim() || `exit ${code}`}`));
          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("Schedule engine returned invalid JSON."));
        }
      });

      child.stdin.on("error", (error) => {
        rejectOnce(new Error(`Failed to write schedule input: ${error.message}`));
      });
      child.stdin.end(payload);
    });
  }
}
