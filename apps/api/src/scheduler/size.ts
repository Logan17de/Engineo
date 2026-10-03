// Keep the engine transport and durable snapshot limits aligned with the
// schedule_runs byte constraints. Canonical input can exceed compact JSON size.
export const SCHEDULE_JSON_MAX_BYTES = 32 * 1024 * 1024;
