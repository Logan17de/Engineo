import type { ActivityInputV1 } from "./schedule.js";

export const ACTIVITY_CSV_MAX_BYTES = 512 * 1024;
export const ACTIVITY_CSV_MAX_ROWS = 10_000;
export const ACTIVITY_CSV_FORMAT = "engineo-activities-v1";

export interface ActivityCsvChangeV1 {
  activityId: string;
  before: ActivityInputV1;
  after: ActivityInputV1;
}

export interface ActivityCsvPreviewV1 {
  expectedRevision: number;
  previewHash: string;
  sourceHash: string;
  rowCount: number;
  changedCount: number;
  unchangedCount: number;
  omittedCount: number;
  changes: ActivityCsvChangeV1[];
}
