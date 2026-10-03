import assert from "node:assert/strict";
import test from "node:test";
import { securityFindings } from "./check-codeql.mjs";

function report(score, result = {}) {
  return {
    runs: [
      {
        tool: {
          driver: { rules: [{ id: "security-rule", properties: { "security-severity": score } }] },
        },
        results: [{ ruleId: "security-rule", ...result }],
      },
    ],
  };
}

test("high and critical findings fail even when marked suppressed or unchanged", () => {
  assert.equal(
    securityFindings(
      report("7.5", { suppressions: [{ status: "accepted" }], baselineState: "unchanged" }),
    ).length,
    1,
  );
  assert.equal(securityFindings(report("9.8")).length, 1);
  assert.equal(securityFindings(report("6.9")).length, 0);
  assert.equal(securityFindings(report("0", { level: "error" })).length, 1);
});

test("missing report data and unknown rules cannot silently pass", () => {
  assert.throws(() => securityFindings({ runs: [] }));
  assert.throws(() => securityFindings({ runs: [{}] }));
  assert.throws(() => securityFindings(report("0", { ruleId: "not-known" })));
});
