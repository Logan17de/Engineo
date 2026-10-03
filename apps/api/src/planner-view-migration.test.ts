import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  serializePlannerViewHashPreimageV1,
  validatePlannerViewConfigurationV1,
} from "@engineo/contracts";

const migrations = new URL("../migrations/", import.meta.url);
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

test("private-view forward migration preserves all six applied migration bytes", async () => {
  const expected = {
    "0001_core.sql": "314c8c49cece9fe5734a30691cfb3d1f25349a7990f08b1c6df9b87280ac7882",
    "0002_auth.sql": "f80ca2f19885fbfebc8f9582b4eed3cae9c08ffe96d0098cf2dd5df3fd17f215",
    "0003_login_rate_limits.sql":
      "7da390e778d11090913a17ca58ef7ca1e8765ce3fc28a61bd1d946b6ee5a08c2",
    "0004_schedule_calculations.sql":
      "0f4357bff6059ed99e53f2650fa7e4b9ec046123e5e24fd468be2a770ddd9822",
    "0005_project_configuration.sql":
      "136d70772e5d3b63a96e9375fb5f01ccae64453a8848777c0a6f3a6fb3ff9200",
    "0006_configuration_outcome_material_state.sql":
      "3585d02e090b32975a9470876250eb968db587df65389081fd24392781defe57",
  };
  for (const [name, checksum] of Object.entries(expected)) {
    assert.equal(hash(await readFile(new URL(name, migrations), "utf8")), checksum, name);
  }
});

test("database view hash wrapper matches the shared canonical preimage exactly", async () => {
  const source = await readFile(new URL("0007_planner_views.sql", migrations), "utf8");
  const expression = /convert_to\(\s*'([^']*)' \|\| config_json \|\| '([^']*)', 'UTF8'\)/.exec(
    source,
  );
  assert.ok(expression, "Database CHECK must hash the versioned wrapper, not config bytes alone");
  for (const name of ["Preference", "Élan by WBS", "Σchedule 🗓️"]) {
    const value = validatePlannerViewConfigurationV1({
      schemaVersion: 1,
      kind: "engineo-planner-view",
      name,
      visibility: "private",
      presentation: {
        search: " literal <script> and https://example.test ",
        kind: "all",
        wbsId: null,
        critical: "all",
        sort: { field: "native", direction: "asc" },
        groupBy: "none",
      },
    });
    assert.equal(value.valid, true);
    if (!value.valid) throw new Error("Invalid migration fixture");
    assert.equal(
      `${expression[1]}${value.canonicalConfiguration}${expression[2]}`,
      serializePlannerViewHashPreimageV1(value.normalizedConfiguration),
    );
  }
});

test("private-view day checkpoint is fixed-size and seeds its hash from one SQL clock sample", async () => {
  const source = await readFile(new URL("0007_planner_views.sql", migrations), "utf8");
  assert.match(source, /operation_window_high_water date NOT NULL/);
  assert.match(source, /operation_window_high_water - DATE '0001-01-01'/);
  assert.match(
    source,
    /WITH stamp AS MATERIALIZED \(SELECT \(transaction_timestamp\(\) AT TIME ZONE 'UTC'\)::date AS utc_day\)/,
  );
  assert.match(
    source,
    /SELECT utc_day, engineo_planner_view_counter_hash\([^;]+utc_day\) FROM stamp/,
  );
  assert.match(source, /today IS NULL OR NOT isfinite\(today\) OR today NOT BETWEEN/);
  assert.match(source, /today < g\.operation_window_high_water/);
  assert.match(
    source,
    /hw IS DISTINCT FROM engineo_planner_view_current_utc_day\(\) OR hw <= old_hw/,
  );
  assert.match(source, /scope_changed OR clock_changed THEN/);
  assert.match(source, /PERFORM engineo_planner_view_lock_storage\(NULL, NULL\)/);
  assert.doesNotMatch(source, /CREATE TABLE[^;]*(?:window_history|clock_history)/);
});
