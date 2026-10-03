import assert from "node:assert/strict";
import test from "node:test";
import { rustExtractionCoverage } from "./check-rust-extraction.mjs";

const sources = Array.from({ length: 19 }, (_, index) => `crates/source-${index}.rs`);

function report(clean = 19, failed = 0) {
  return {
    runs: [
      {
        invocations: [
          {
            executionSuccessful: true,
            toolExecutionNotifications: sources.map((uri) => ({
              descriptor: { id: "rust/diagnostics/successfully-extracted-files" },
              locations: [
                { physicalLocation: { artifactLocation: { uri, uriBaseId: "%SRCROOT%" } } },
              ],
            })),
          },
        ],
        properties: {
          metricResults: [
            { ruleId: "rust/summary/number-of-successfully-extracted-files", value: clean },
            { ruleId: "rust/summary/number-of-files-extracted-with-errors", value: failed },
          ],
        },
      },
    ],
  };
}

test("query success cannot pass partial Rust extraction or a missing source file", () => {
  assert.deepEqual(rustExtractionCoverage(report(), sources), [
    { cleanFiles: 19, failedFiles: 0, expectedFiles: 19 },
  ]);
  assert.throws(() => rustExtractionCoverage(report(17, 2), sources), /17 clean, 2 with errors/);
  assert.throws(() => rustExtractionCoverage(report(18), sources), /18 clean/);
  assert.throws(() => rustExtractionCoverage(report(20), sources), /20 clean/);
  const multiple = report();
  multiple.runs.push(report(17, 2).runs[0]);
  assert.throws(() => rustExtractionCoverage(multiple, sources), /incomplete/);
});

test("missing, duplicate, malformed or conflicting metrics fail closed", () => {
  assert.throws(() => rustExtractionCoverage({ runs: [] }, sources));
  assert.throws(() => rustExtractionCoverage({ runs: [{}] }, sources), /missing/);
  assert.throws(() => rustExtractionCoverage(report(), []), /inventory/);
  for (const value of [-1, "0", null, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
    assert.throws(() => rustExtractionCoverage(report(19, value), sources), /Invalid/);
  }
  const duplicate = report();
  duplicate.runs[0].properties.metricResults.push(duplicate.runs[0].properties.metricResults[0]);
  assert.throws(() => rustExtractionCoverage(duplicate, sources), /one extraction metric/);
  const conflict = report();
  conflict.runs[0].properties.metricResults[0].rule = { id: "other-rule" };
  assert.throws(() => rustExtractionCoverage(conflict, sources), /Invalid/);
});

test("failed invocation and extraction diagnostics fail even with clean metrics", () => {
  const missing = report();
  missing.runs[0].invocations = [];
  assert.throws(() => rustExtractionCoverage(missing, sources), /invocation evidence/);
  const missingStatus = report();
  delete missingStatus.runs[0].invocations[0].executionSuccessful;
  assert.throws(() => rustExtractionCoverage(missingStatus, sources), /failed/);
  for (const status of [false, undefined, null, 0, "true", {}]) {
    const failed = report();
    failed.runs[0].invocations[0].executionSuccessful = status;
    assert.throws(() => rustExtractionCoverage(failed, sources), /failed/);
  }
  for (const diagnostic of [
    { level: "error", message: { text: "Macro expansion failed" } },
    { descriptor: { id: "rust/diagnostics/extraction-warnings" } },
  ]) {
    const notified = report();
    notified.runs[0].invocations[0].toolExecutionNotifications.push(diagnostic);
    assert.throws(() => rustExtractionCoverage(notified, sources), /diagnostic/);
  }
});

test("clean counts cannot conceal a missing or substituted repository source", () => {
  const missing = report();
  missing.runs[0].invocations[0].toolExecutionNotifications.pop();
  assert.throws(() => rustExtractionCoverage(missing, sources), /inventory does not match/);
  const substituted = report();
  substituted.runs[0].invocations[0].toolExecutionNotifications[0].locations[0].physicalLocation.artifactLocation.uri =
    "crates/not-in-the-repository.rs";
  assert.throws(() => rustExtractionCoverage(substituted, sources), /inventory does not match/);
});
