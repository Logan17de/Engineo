import { createHash } from "node:crypto";
import {
  ACTIVITY_CSV_MAX_BYTES,
  ACTIVITY_CSV_MAX_ROWS,
  type ActivityCsvChangeV1,
  type ActivityCsvPreviewV1,
  type ActivityInputV1,
  type EngineProjectInputV1,
  MAX_WORK_MINUTES,
  serializeScheduleInputV1,
  validateScheduleInputV1,
} from "@engineo/contracts";

const columns = [
  "projectId",
  "activityId",
  "name",
  "kind",
  "durationMinutes",
  "wbsId",
  "calendarId",
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const protectedText = /^(?:'|\s*[=+\-@]|[\t\r\n])/u;
export const csvHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export class ActivityCsvError extends Error {}

// An apostrophe escapes formula-like text and original leading apostrophes.
// Quoting alone does not prevent spreadsheet formula evaluation.
function encode(value: string): string {
  const safe = protectedText.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
function decode(value: string): string {
  return value.startsWith("'") && protectedText.test(value.slice(1)) ? value.slice(1) : value;
}
export function exportActivityCsv(input: EngineProjectInputV1): string {
  const rows = input.activities.map((activity) =>
    [
      input.project.id,
      activity.id,
      activity.name,
      activity.kind,
      String(activity.durationMinutes),
      activity.wbsId,
      activity.calendarId,
    ]
      .map(encode)
      .join(","),
  );
  return `\uFEFF${columns.join(",")}\r\n${rows.length ? `${rows.join("\r\n")}\r\n` : ""}`;
}

function parse(csv: string): string[][] {
  if (Buffer.byteLength(csv, "utf8") > ACTIVITY_CSV_MAX_BYTES)
    throw new ActivityCsvError("CSV exceeds the 512 KiB limit.");
  const source = csv.startsWith("\uFEFF") ? csv.slice(1) : csv;
  if (source.length === 0 || !source.isWellFormed())
    throw new ActivityCsvError(
      "CSV is empty or contains unsupported control/invalid UTF-8 characters.",
    );
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  const endField = () => {
    row.push(field);
    if (row.length > columns.length) throw new ActivityCsvError("CSV has too many columns.");
    field = "";
    closed = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    if (rows.length > ACTIVITY_CSV_MAX_ROWS + 1)
      throw new ActivityCsvError("CSV exceeds 10,000 activity rows.");
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const code = source.charCodeAt(i);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127 || code === 0xfffd)
      throw new ActivityCsvError("CSV contains unsupported control/invalid UTF-8 characters.");
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += char;
    } else if (char === ",") endField();
    else if (char === "\r" || char === "\n") {
      endRow();
      if (char === "\r" && source[i + 1] === "\n") i++;
    } else if (char === '"' && !field && !closed) quoted = true;
    else {
      if (closed || char === '"')
        throw new ActivityCsvError(`Malformed CSV near record ${rows.length + 1}.`);
      field += char;
    }
    if (field.length > 2048) throw new ActivityCsvError("CSV field exceeds 2,048 characters.");
  }
  if (quoted) throw new ActivityCsvError("CSV has an unterminated quoted field.");
  if (field || closed || row.length) endRow();
  return rows;
}

export function previewActivityCsv(
  csv: string,
  input: EngineProjectInputV1,
  expectedRevision: number,
  organizationId: string,
): { input: EngineProjectInputV1; preview: ActivityCsvPreviewV1 } {
  const rows = parse(csv),
    header = rows.shift();
  if (
    !header ||
    header.length !== columns.length ||
    new Set(header).size !== columns.length ||
    columns.some((column) => !header.includes(column))
  )
    throw new ActivityCsvError(
      `Use exactly these CSV columns: ${columns.join(", ")}. Unknown columns are rejected.`,
    );
  const existing = new Map(
    input.activities.map((activity) => [activity.id.toLowerCase(), activity]),
  );
  const updates = new Map<string, ActivityInputV1>();
  const changes: ActivityCsvChangeV1[] = [];
  for (const [index, row] of rows.entries()) {
    const fail = (message: string): never => {
      throw new ActivityCsvError(`CSV record ${index + 2}: ${message}`);
    };
    if (row.length !== header.length) fail("column count does not match the header.");
    const cells = Object.fromEntries(header.map((column, i) => [column, decode(row[i] ?? "")]));
    const id = (column: string) => {
      const value = cells[column] ?? "";
      if (!uuid.test(value)) fail(`${column} must be a UUID from this project's export.`);
      return value.toLowerCase();
    };
    if (id("projectId") !== input.project.id.toLowerCase())
      fail("projectId does not match the selected project.");
    const activityId = id("activityId"),
      previous = existing.get(activityId);
    if (!previous)
      throw new ActivityCsvError(
        `CSV record ${index + 2}: activityId is not in the selected project. This format edits existing activities only.`,
      );
    if (updates.has(activityId)) fail("duplicate activityId.");
    const name = cells.name ?? "",
      kind = cells.kind ?? "",
      duration = cells.durationMinutes ?? "";
    if (!name.trim() || name.length > 500)
      fail("name must contain 1–500 characters and cannot be blank.");
    if (!["TASK", "START_MILESTONE", "FINISH_MILESTONE"].includes(kind))
      fail("unsupported activity kind.");
    if (!/^(0|[1-9]\d*)$/.test(duration) || Number(duration) > MAX_WORK_MINUTES)
      fail("durationMinutes must be a whole number between 0 and 4,294,967,295.");
    // Previous is established above; retain all fields outside the CSV scope.
    const activity: ActivityInputV1 = {
      ...previous,
      name,
      kind: kind as ActivityInputV1["kind"],
      durationMinutes: Number(duration),
      wbsId: id("wbsId"),
      calendarId: id("calendarId"),
    };
    updates.set(activityId, activity);
    if (JSON.stringify(activity) !== JSON.stringify(previous))
      changes.push({ activityId, before: previous, after: activity });
  }
  const candidate = {
    ...input,
    activities: input.activities.map(
      (activity) => updates.get(activity.id.toLowerCase()) ?? activity,
    ),
  };
  const validation = validateScheduleInputV1(candidate);
  if (!validation.valid)
    throw new ActivityCsvError(
      validation.issues
        .slice(0, 3)
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join(" "),
    );
  const sourceHash = csvHash(csv);
  const previewHash = csvHash(
    JSON.stringify({
      organizationId,
      projectId: input.project.id,
      expectedRevision,
      sourceHash,
      resultHash: csvHash(serializeScheduleInputV1(candidate)),
    }),
  );
  return {
    input: candidate,
    preview: {
      expectedRevision,
      previewHash,
      sourceHash,
      rowCount: rows.length,
      changedCount: changes.length,
      unchangedCount: rows.length - changes.length,
      omittedCount: input.activities.length - rows.length,
      changes,
    },
  };
}
