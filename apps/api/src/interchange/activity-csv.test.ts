import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { type EngineProjectInputV1, WEEKDAYS } from "@engineo/contracts";
import { exportActivityCsv, previewActivityCsv } from "./activity-csv.js";

function fixture(): EngineProjectInputV1 {
  const project = randomUUID(),
    calendar = randomUUID(),
    wbs = randomUUID();
  return {
    schemaVersion: 1,
    project: {
      id: project,
      name: "CSV fixture",
      plannedStart: "2026-10-05T08:00:00Z",
      dataDate: "2026-10-05T08:00:00Z",
      requiredFinish: null,
      defaultCalendarId: calendar,
    },
    scheduleOptions: {
      criticalFloatThresholdMinutes: 0,
      lagCalendarPolicy: "SUCCESSOR",
      projectFinishPolicy: "CALCULATED",
    },
    calendars: [
      {
        id: calendar,
        name: "Daily",
        timeZone: "UTC",
        exceptions: [],
        week: Object.fromEntries(
          WEEKDAYS.map((day) => [day, [{ start: "08:00", end: "17:00" }]]),
        ) as EngineProjectInputV1["calendars"][number]["week"],
      },
    ],
    wbs: [{ id: wbs, parentId: null, name: "Root", code: "1", sortOrder: 0 }],
    activities: [
      'Quoted, "建設"\r\nline',
      '=HYPERLINK("bad")',
      "   @SUM(A1)",
      "'original",
      "'",
      "\ttext",
      "-10",
      "+SUM(1)",
      "plain",
    ].map((name) => ({
      id: randomUUID(),
      name,
      kind: "TASK",
      durationMinutes: 480,
      calendarId: calendar,
      wbsId: wbs,
      constraints: [{ type: "START_ON_OR_AFTER", instant: "2026-10-05T08:00:00Z" }],
    })),
    relationships: [],
  };
}

test("CSV preserves Unicode, multiline quotes, formulas and apostrophes through exact round trip", () => {
  const input = fixture(),
    csv = exportActivityCsv(input);
  assert.ok(csv.startsWith("\uFEFFprojectId,"));
  assert.ok(csv.includes("\"'=HYPERLINK("));
  assert.ok(csv.includes('"\'   @SUM(A1)"'));
  assert.ok(csv.includes("\"''original\""));
  const preview = previewActivityCsv(csv, input, 7, "org");
  assert.deepEqual(preview.input, input);
  assert.equal(preview.preview.changedCount, 0);
  assert.equal(preview.preview.unchangedCount, input.activities.length);
  assert.deepEqual(previewActivityCsv(csv.replace(/^\uFEFF/u, ""), input, 7, "org").input, input);
});

test("CSV subset updates supported fields and preserves order, omitted rows and constraints", () => {
  const input = fixture(),
    changed = structuredClone(input);
  const activity = changed.activities.at(-1);
  assert.ok(activity);
  activity.name = "Renamed";
  activity.durationMinutes = 960;
  changed.activities = [activity];
  const { input: result, preview } = previewActivityCsv(
    exportActivityCsv(changed),
    input,
    7,
    "org",
  );
  assert.equal(preview.changedCount, 1);
  assert.equal(preview.omittedCount, 8);
  const expected = structuredClone(input);
  expected.activities[8] = activity;
  assert.deepEqual(result, expected);
  assert.equal(preview.changes[0]?.before.name, "plain");
  assert.equal(preview.changes[0]?.after.durationMinutes, 960);
  const hash = preview.previewHash;
  assert.notEqual(
    previewActivityCsv(exportActivityCsv(changed), input, 8, "org").preview.previewHash,
    hash,
  );
  assert.notEqual(
    previewActivityCsv(exportActivityCsv(changed), input, 7, "other").preview.previewHash,
    hash,
  );
});

test("CSV accepts reordered columns and CRLF/LF but refuses lossy or ambiguous input", () => {
  const input = fixture();
  const activity = input.activities[8];
  assert.ok(activity);
  input.activities = [activity];
  const csv = exportActivityCsv(input);
  const reordered = csv
    .trimEnd()
    .replace(/^\uFEFF/u, "")
    .split("\r\n")
    .map((row) => row.split(",").reverse().join(","))
    .join("\n");
  assert.deepEqual(previewActivityCsv(reordered, input, 1, "org").input, input);
  const bad = [
    csv.replace("calendarId", "extra"),
    csv.replace("name,kind", "name,name"),
    `${csv}\r\n`,
    `${csv}${csv.split("\r\n")[1]}\r\n`,
    csv.replace('"plain"', '"broken'),
    csv.replace('"plain"', '"plain"junk'),
    csv.replace('"plain"', 'bad"quote'),
    csv.replace('"plain"', '"\u0000"'),
    csv.replace('"plain"', '"\uFFFD"'),
    csv.replace('"480"', '"1e3"'),
    csv.replace('"480"', '"-1"'),
    csv.replace('"480"', '"4294967296"'),
    csv.replace('"TASK"', '"START_MILESTONE"'),
    csv.replace(input.project.id, randomUUID()),
    csv.replace(activity.id, randomUUID()),
    csv.replace(activity.wbsId, randomUUID()),
    csv.replace('"plain"', `"${"x".repeat(501)}"`),
    csv.replace('"plain"', `"${"x".repeat(2049)}"`),
    "x".repeat(512 * 1024 + 1),
    "",
    "\uFEFF",
  ];
  for (const value of bad) assert.throws(() => previewActivityCsv(value, input, 1, "org"));
});

test("CSV bounds count UTF-8 bytes, records and columns independently", () => {
  const input = fixture();
  assert.throws(() => previewActivityCsv("界".repeat(180_000), input, 1, "org"), /512 KiB/);
  assert.throws(() => previewActivityCsv("x\n".repeat(10_002), input, 1, "org"), /10,000/);
  assert.throws(() => previewActivityCsv("a,b,c,d,e,f,g,h", input, 1, "org"), /columns/);
});

test("CSV preview supports 1,000 edited activities within the upload budget", () => {
  const input = fixture(),
    template = input.activities[8];
  assert.ok(template);
  input.activities = Array.from({ length: 1000 }, (_, i) => ({
    ...template,
    id: randomUUID(),
    name: `Activity ${i + 1}`,
  }));
  const changed = structuredClone(input);
  for (const activity of changed.activities) activity.durationMinutes = 960;
  const csv = exportActivityCsv(changed);
  assert.ok(Buffer.byteLength(csv) < 512 * 1024);
  const { preview } = previewActivityCsv(csv, input, 1, "org");
  assert.equal(preview.changedCount, 1000);
});
