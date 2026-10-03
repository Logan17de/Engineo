import assert from "node:assert/strict";
import test from "node:test";
import type { EngineProjectInputV1 } from "@engineo/contracts";
import type { DatabaseExecutor } from "../db/client.js";
import { tenantContext } from "../db/tenant-context.js";
import {
  assertConfigurationNativeIds,
  ConfigurationNativeIdError,
  reconcileConfigurationSchedule,
} from "./configuration-reconcile.js";

const organizationId = "10000000-0000-4000-8000-000000000001";
const projectId = "20000000-0000-4000-8000-000000000001";
const calendarId = "30000000-0000-4000-8000-000000000001";
const wbsId = "40000000-0000-4000-8000-000000000001";
const secondWbsId = "40000000-0000-4000-8000-000000000002";
const activityId = "50000000-0000-4000-8000-000000000001";
const context = tenantContext(organizationId);

function candidate(): EngineProjectInputV1 {
  return {
    schemaVersion: 1,
    project: {
      id: projectId,
      name: "Schedule",
      plannedStart: "2026-10-05T08:00:00.000Z",
      dataDate: "2026-10-05T08:00:00.000Z",
      requiredFinish: null,
      defaultCalendarId: calendarId,
    },
    scheduleOptions: {
      criticalFloatThresholdMinutes: 0,
      lagCalendarPolicy: "SUCCESSOR",
      projectFinishPolicy: "CALCULATED",
    },
    calendars: [
      {
        id: calendarId,
        name: "Calendar",
        timeZone: "UTC",
        week: {
          MONDAY: [],
          TUESDAY: [],
          WEDNESDAY: [],
          THURSDAY: [],
          FRIDAY: [],
          SATURDAY: [],
          SUNDAY: [],
        },
        exceptions: [],
      },
    ],
    wbs: [{ id: wbsId, parentId: null, code: "ROOT", name: "Root", sortOrder: 0 }],
    activities: [
      {
        id: activityId,
        name: "Activity",
        kind: "TASK",
        wbsId,
        calendarId,
        durationMinutes: 480,
        constraints: [{ type: "START_ON_OR_AFTER", instant: "2026-10-05T09:00:00+01:00" }],
      },
    ],
    relationships: [],
  };
}

interface Query {
  text: string;
  values: unknown[];
}

function executor(run: (query: Query) => unknown[] | Promise<unknown[]>): {
  sql: DatabaseExecutor;
  queries: Query[];
} {
  const queries: Query[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join("?").replace(/\s+/g, " ").trim(), values };
    queries.push(query);
    return await run(query);
  }) as unknown as DatabaseExecutor;
  return { sql, queries };
}

test("native ID availability exposes only a generic error across all native tables", async () => {
  const { sql, queries } = executor(() => [{ unavailable: true }]);
  await assert.rejects(
    assertConfigurationNativeIds(sql, context, projectId, candidate()),
    (error: unknown) => {
      assert.ok(error instanceof ConfigurationNativeIdError);
      assert.equal(error.message, "One or more schedule IDs are unavailable for this project.");
      assert.equal(error.message.includes(organizationId), false);
      assert.equal(error.message.includes(calendarId), false);
      return true;
    },
  );
  assert.equal(queries.length, 1);
  const query = queries[0];
  assert.ok(query);
  for (const table of ["calendars", "wbs_nodes", "activities"]) {
    assert.ok(query.text.includes(`FROM ${table}`));
  }
  assert.equal(query.text.includes("SELECT id"), false);
  assert.equal(query.values.filter((value) => value === organizationId).length, 5);
  assert.equal(query.values.filter((value) => value === projectId).length, 5);
});

test("native append capacity uses numeric arithmetic and counts only truly new scoped IDs", async () => {
  const input = candidate();
  input.activities = [];
  const { sql, queries } = executor(() => [{ unavailable: false }]);
  await assertConfigurationNativeIds(sql, context, projectId, input);
  const query = queries[0];
  assert.ok(query);
  assert.ok(query.text.includes("COALESCE(MAX(sort_order), -1)::numeric"));
  assert.ok(query.text.includes("SELECT COUNT(*)::numeric"));
  assert.ok(query.text.includes("> 9223372036854775807::numeric"));
  assert.ok(
    query.text.includes("WHERE NOT EXISTS ( SELECT 1 FROM activities AS a WHERE a.id = wanted.id"),
  );
  assert.equal(query.values.filter((value) => value === "[]").length, 2);
  assert.equal(query.text.includes("::bigint"), false);

  const rejected = executor(() => [{ unavailable: true }]);
  await assert.rejects(
    assertConfigurationNativeIds(rejected.sql, context, projectId, candidate()),
    ConfigurationNativeIdError,
  );
});

test("reconcile stages WBS codes collision-free and preserves unrelated metadata", async () => {
  const input = candidate();
  input.wbs.push({
    id: secondWbsId,
    parentId: wbsId,
    code: `__engineo_configuration_wbs:1:${wbsId}`,
    name: "Child",
    sortOrder: 2,
  });
  const { sql, queries } = executor((query) => {
    if (query.text.startsWith("SELECT (EXISTS")) return [{ unavailable: false }];
    if (query.text.includes("MAX(sort_order)")) return [{ maximum: "9007199254740993" }];
    if (query.text.startsWith("SELECT id, parent_id, code, name")) {
      return [
        { id: wbsId, parent_id: null, code: "ROOT", name: "Root", sort_order: "0" },
        {
          id: secondWbsId,
          parent_id: null,
          code: `__engineo_configuration_wbs:0:${wbsId}`,
          name: "Child before",
          sort_order: "1",
        },
      ];
    }
    return [];
  });
  await reconcileConfigurationSchedule(sql, context, projectId, input);

  const stage = queries.find((query) => query.text.includes("SET code = staged.code"));
  assert.ok(stage);
  assert.equal(stage.text.includes("updated_at"), false);
  assert.ok(stage.text.includes("parent_id = NULL"));
  assert.deepEqual(JSON.parse(String(stage.values[0])), [
    { id: wbsId, code: `__engineo_configuration_wbs:2:${wbsId}` },
    { id: secondWbsId, code: `__engineo_configuration_wbs:2:${secondWbsId}` },
  ]);
  const wbsUpdate = queries.find((query) =>
    query.text.startsWith("UPDATE wbs_nodes AS w SET code = wanted"),
  );
  assert.ok(wbsUpdate);
  const written = JSON.parse(String(wbsUpdate.values[0])) as Array<{ changed: boolean }>;
  assert.equal(written[0]?.changed, false);
  assert.equal(written[1]?.changed, true);
  assert.ok(wbsUpdate.text.includes("CASE WHEN wanted.changed THEN now() ELSE w.updated_at END"));

  const updateActivity = queries.find((query) => query.text.startsWith("UPDATE activities"));
  const insertActivity = queries.find((query) => query.text.startsWith("INSERT INTO activities"));
  assert.ok(updateActivity && insertActivity);
  assert.equal(updateActivity.text.includes("sort_order"), false);
  assert.equal(updateActivity.text.includes("created_at"), false);
  assert.ok(insertActivity.values.includes("9007199254740993"));
  assert.ok(insertActivity.text.includes("row_number() OVER (ORDER BY wanted.id)"));
  const persistedInput = JSON.parse(
    String(
      updateActivity.values.find((value) => typeof value === "string" && value.startsWith("[{")),
    ),
  ) as EngineProjectInputV1["activities"];
  assert.equal(persistedInput[0]?.constraints[0]?.instant, "2026-10-05T09:00:00+01:00");

  const text = queries.map((query) => query.text).join("\n");
  assert.equal(text.includes("DELETE FROM project_schedule_settings"), false);
  assert.equal(text.includes("revision ="), false);
  assert.equal(text.includes("audit_events"), false);
  assert.equal(text.includes("schedule_calculations"), false);
  assert.equal(text.includes("UPDATE relationships"), false);
  assert.equal(text.includes("ON CONFLICT"), false);
  assert.equal(text.includes("created_at"), false);
  for (const query of queries.filter((item) => /^(UPDATE|INSERT|DELETE)/.test(item.text))) {
    assert.ok(query.values.includes(organizationId));
    assert.ok(query.values.includes(projectId));
  }

  const index = (part: string) => queries.findIndex((query) => query.text.includes(part));
  assert.ok(index("SET code = staged.code") < index("INSERT INTO wbs_nodes"));
  assert.ok(index("INSERT INTO wbs_nodes") < index("SET parent_id = wanted"));
  assert.ok(index("UPDATE activities") < index("DELETE FROM wbs_nodes"));
  assert.ok(index("DELETE FROM relationships") < index("DELETE FROM activities"));
  assert.ok(index("DELETE FROM activities") < index("DELETE FROM wbs_nodes"));
  assert.ok(index("UPDATE project_schedule_settings") < index("DELETE FROM calendars"));
});

test("a racing native PK collision is generic and other database errors remain failures", async () => {
  for (const constraint of ["calendars_pkey", "wbs_nodes_pkey", "activities_pkey", "other"]) {
    const detail = { code: "23505", constraint_name: constraint, detail: "Foreign secret row" };
    const { sql } = executor((query) => {
      if (query.text.startsWith("SELECT (EXISTS")) return [{ unavailable: false }];
      if (query.text.includes("MAX(sort_order)")) return [{ maximum: "-1" }];
      if (query.text.startsWith("INSERT INTO calendars")) throw detail;
      return [];
    });
    await assert.rejects(
      reconcileConfigurationSchedule(sql, context, projectId, candidate()),
      (error) => {
        if (constraint === "other") assert.equal(error, detail);
        else {
          assert.ok(error instanceof ConfigurationNativeIdError);
          assert.equal(error.message.includes("Foreign secret row"), false);
          assert.equal("cause" in error, false);
        }
        return true;
      },
    );
  }
});
