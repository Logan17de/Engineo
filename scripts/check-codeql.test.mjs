import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

const componentGuid = "11111111-0000-1111-8888-000000000001";
const otherComponentGuid = "11111111-0000-1111-8888-000000000002";
const ruleGuid = "22222222-0000-1111-8888-000000000001";
const otherRuleGuid = "22222222-0000-1111-8888-000000000002";
const tlsRuleId = "js/disabling-certificate-validation";

function extensionReport(result = {}, score = "7.5") {
  // Reproduce PR #65's CodeQL shape: the driver is empty, the PR-diff
  // extension occupies index 0, and javascript-queries.rules[34] is the rule.
  const rules = Array.from({ length: 35 }, (_, index) => ({
    id: `js/unrelated-${index}`,
    properties: { "security-severity": "0" },
  }));
  rules[34] = {
    id: tlsRuleId,
    defaultConfiguration: { level: "error" },
    properties: { "security-severity": score },
  };
  return {
    runs: [
      {
        tool: {
          driver: { name: "CodeQL", rules: [] },
          extensions: [
            { name: "codeql-action/pr-diff-range" },
            { name: "codeql/javascript-queries", rules },
            { name: "codeql/javascript-all" },
            { name: "codeql/threat-models" },
          ],
        },
        results: [
          {
            ruleId: tlsRuleId,
            rule: { id: tlsRuleId, index: 34, toolComponent: { index: 1 } },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "packages/cli/src/cli.test.ts" },
                  region: { startLine: 577 },
                },
              },
            ],
            ...result,
          },
        ],
      },
    ],
  };
}

function changedExtension(change) {
  const value = extensionReport();
  change(value.runs[0], value.runs[0].results[0]);
  return value;
}

test("actual extension-shaped TLS finding resolves to 7.5/error and its original location", () => {
  assert.deepEqual(securityFindings(extensionReport()), [
    {
      rule: tlsRuleId,
      score: 7.5,
      level: "error",
      file: "packages/cli/src/cli.test.ts",
      line: 577,
    },
  ]);
});

test("suppressed and unchanged high extension findings still fail", () => {
  assert.equal(
    securityFindings(
      extensionReport({ suppressions: [{ status: "accepted" }], baselineState: "unchanged" }),
    ).length,
    1,
  );
});

test("extension severity thresholds and result/default error levels are preserved", () => {
  assert.equal(securityFindings(extensionReport({ level: "warning" }, "7")).length, 1);
  assert.equal(securityFindings(extensionReport({ level: "warning" }, "9.8")).length, 1);
  assert.equal(securityFindings(extensionReport({ level: "warning" }, "6.9")).length, 0);
  assert.equal(securityFindings(extensionReport({}, "0")).length, 1);
  assert.equal(securityFindings(extensionReport({ level: "error" }, "0")).length, 1);
});

test("legacy unique driver ID-only and driver indices remain supported", () => {
  for (const result of [
    {},
    { ruleIndex: 0 },
    { rule: { index: 0 } },
    { ruleIndex: 0, rule: { id: "security-rule", index: 0 } },
    { rule: { id: "security-rule", toolComponent: {} } },
    { ruleIndex: -1 },
    { rule: { index: -1, toolComponent: { index: -1 } } },
  ]) {
    assert.equal(securityFindings(report("7.5", result)).length, 1);
  }
});

test("index-only references report the resolved descriptor ID", () => {
  const value = extensionReport({ ruleId: undefined });
  delete value.runs[0].results[0].ruleId;
  delete value.runs[0].results[0].rule.id;
  assert.equal(securityFindings(value)[0].rule, tlsRuleId);
});

test("result IDs can name exactly one extra hierarchical component", () => {
  const id = `${tlsRuleId}/specific-case`;
  assert.equal(
    securityFindings(
      extensionReport({ ruleId: id, rule: { id, index: 34, toolComponent: { index: 1 } } }),
    )[0].rule,
    id,
  );
});

test("extension index is not offset by the driver and extension order may change", () => {
  const value = changedExtension((run, result) => {
    run.tool.extensions.shift();
    result.rule.toolComponent.index = 0;
  });
  assert.equal(securityFindings(value)[0].score, 7.5);
});

test("component lookup honors index, optional name, and GUID together", () => {
  const value = changedExtension((run, result) => {
    run.tool.extensions[1].guid = componentGuid;
    Object.assign(result.rule.toolComponent, {
      name: "codeql/javascript-queries",
      guid: componentGuid,
    });
  });
  assert.equal(securityFindings(value).length, 1);
  delete value.runs[0].results[0].rule.toolComponent.index;
  assert.equal(securityFindings(value).length, 1);
  value.runs[0].results[0].rule.toolComponent.index = -1;
  assert.equal(securityFindings(value).length, 1);
});

test("driver can be identified by matching name or GUID", () => {
  const value = report("7.5", { rule: { index: 0, toolComponent: { name: "CodeQL" } } });
  value.runs[0].tool.driver.name = "CodeQL";
  value.runs[0].tool.driver.guid = componentGuid;
  assert.equal(securityFindings(value).length, 1);
  value.runs[0].results[0].rule.toolComponent.guid = componentGuid;
  assert.equal(securityFindings(value).length, 1);
});

test("rule lookup honors GUID and index consistency", () => {
  const value = changedExtension((run, result) => {
    run.tool.extensions[1].rules[34].guid = ruleGuid;
    result.rule.guid = ruleGuid;
  });
  assert.equal(securityFindings(value).length, 1);
  delete value.runs[0].results[0].rule.index;
  assert.equal(securityFindings(value).length, 1);
  value.runs[0].results[0].rule.index = -1;
  assert.equal(securityFindings(value).length, 1);
});

test("component and rule GUID comparisons are case-insensitive", () => {
  const guid = "abcdefab-cdef-1abc-8abc-abcdefabcdef";
  const value = changedExtension((run, result) => {
    run.tool.extensions[1].guid = guid;
    run.tool.extensions[1].rules[34].guid = guid;
    result.rule.guid = guid.toUpperCase();
    result.rule.toolComponent = { guid: guid.toUpperCase() };
  });
  assert.equal(securityFindings(value).length, 1);
});

test("same rule IDs in other components never override the declared component", () => {
  const value = changedExtension((run) => {
    run.tool.driver.rules = [{ id: tlsRuleId, properties: { "security-severity": "0" } }];
    run.tool.extensions[0].rules = [{ id: tlsRuleId, properties: { "security-severity": "0" } }];
  });
  assert.equal(securityFindings(value)[0].score, 7.5);
});

test("duplicate IDs are legal when an index unambiguously identifies the descriptor", () => {
  const value = report("7.5");
  value.runs[0].tool.driver.rules.push({
    id: "security-rule",
    properties: { "security-severity": "0" },
  });
  assert.throws(() => securityFindings(value), /Ambiguous SARIF rule/);
  value.runs[0].results[0].ruleIndex = 0;
  assert.equal(securityFindings(value).length, 1);
  value.runs[0].results[0].ruleIndex = 1;
  assert.equal(securityFindings(value).length, 0);
});

test("extension ID duplication cannot hide the indexed high rule", () => {
  const value = changedExtension((run) => {
    run.tool.extensions[1].rules[0].id = tlsRuleId;
  });
  assert.equal(securityFindings(value)[0].score, 7.5);
});

for (const [name, change, error] of [
  [
    "result/reference IDs conflict",
    (_run, result) => {
      result.rule.id = "js/other";
    },
    /Conflicting/,
  ],
  [
    "result/reference indices conflict",
    (_run, result) => {
      result.ruleIndex = 0;
    },
    /Conflicting/,
  ],
  [
    "unset result index conflicts with set reference index",
    (_run, result) => {
      result.ruleIndex = -1;
    },
    /Conflicting/,
  ],
  [
    "rule index and ID identify different descriptors",
    (_run, result) => {
      result.rule.index = 0;
    },
    /Conflicting/,
  ],
  [
    "rule ID is only a textual prefix",
    (_run, result) => {
      result.ruleId = `${tlsRuleId}x`;
      result.rule.id = result.ruleId;
    },
    /Conflicting/,
  ],
  [
    "rule ID adds multiple hierarchical components",
    (_run, result) => {
      result.ruleId = `${tlsRuleId}/one/two`;
      result.rule.id = result.ruleId;
    },
    /Conflicting/,
  ],
  [
    "component index is out of range",
    (_run, result) => {
      result.rule.toolComponent.index = 4;
    },
    /Unknown/,
  ],
  [
    "component points at a metadata-free extension",
    (_run, result) => {
      result.rule.toolComponent.index = 0;
    },
    /missing rule metadata/,
  ],
  [
    "component name conflicts with indexed component",
    (_run, result) => {
      result.rule.toolComponent.name = "CodeQL";
    },
    /Conflicting/,
  ],
  [
    "component name alone must not locate an extension",
    (_run, result) => {
      result.rule.toolComponent = { name: "codeql/javascript-queries" };
    },
    /Conflicting/,
  ],
  [
    "missing component must not search all extensions",
    (_run, result) => {
      delete result.rule.toolComponent;
    },
    /Unknown/,
  ],
  [
    "rule index is out of range",
    (_run, result) => {
      result.rule.index = 35;
    },
    /Unknown/,
  ],
  [
    "extension has neither rule index nor GUID",
    (_run, result) => {
      delete result.rule.index;
    },
    /missing a resolvable/,
  ],
  [
    "component GUID is unknown",
    (_run, result) => {
      result.rule.toolComponent.guid = componentGuid;
    },
    /Unknown/,
  ],
  [
    "component GUID conflicts with its index",
    (run, result) => {
      run.tool.driver.guid = componentGuid;
      result.rule.toolComponent.guid = componentGuid;
    },
    /Conflicting/,
  ],
  [
    "component GUID is ambiguous",
    (run, result) => {
      run.tool.extensions[0].guid = componentGuid;
      run.tool.extensions[1].guid = componentGuid;
      result.rule.toolComponent.guid = componentGuid;
    },
    /Ambiguous/,
  ],
  [
    "rule GUID is unknown",
    (_run, result) => {
      result.rule.guid = ruleGuid;
    },
    /Unknown/,
  ],
  [
    "rule GUID conflicts with its index",
    (run, result) => {
      run.tool.extensions[1].rules[0].guid = ruleGuid;
      result.rule.guid = ruleGuid;
    },
    /Conflicting/,
  ],
  [
    "rule GUID is ambiguous",
    (run, result) => {
      run.tool.extensions[1].rules[0].guid = ruleGuid;
      run.tool.extensions[1].rules[34].guid = ruleGuid;
      result.rule.guid = ruleGuid;
    },
    /Ambiguous/,
  ],
  [
    "rule metadata ID is missing",
    (run) => {
      delete run.tool.extensions[1].rules[34].id;
    },
    /missing an ID/,
  ],
  [
    "rule metadata is absent",
    (run) => {
      delete run.tool.extensions[1].rules;
    },
    /missing rule metadata/,
  ],
  [
    "rule metadata is malformed",
    (run) => {
      run.tool.extensions[1].rules[34] = null;
    },
    /Malformed/,
  ],
  [
    "rule properties are malformed",
    (run) => {
      run.tool.extensions[1].rules[34].properties = null;
    },
    /Malformed/,
  ],
  [
    "default configuration is malformed",
    (run) => {
      run.tool.extensions[1].rules[34].defaultConfiguration = null;
    },
    /Malformed/,
  ],
  [
    "rule reference is malformed",
    (_run, result) => {
      result.rule = null;
    },
    /Malformed/,
  ],
  [
    "component reference is malformed",
    (_run, result) => {
      result.rule.toolComponent = [];
    },
    /Malformed/,
  ],
  [
    "rule reference has an unknown field",
    (_run, result) => {
      result.rule.component = { index: 1 };
    },
    /Malformed/,
  ],
  [
    "component reference has an unknown field",
    (_run, result) => {
      result.rule.toolComponent.ruleIndex = 1;
    },
    /Malformed/,
  ],
]) {
  test(`fail closed: ${name}`, () => {
    assert.throws(() => securityFindings(changedExtension(change)), error);
  });
}

for (const [name, change] of [
  [
    "rules missing",
    (run) => {
      delete run.tool.driver.rules;
    },
  ],
  [
    "driver missing",
    (run) => {
      delete run.tool.driver;
    },
  ],
  [
    "extensions not an array",
    (run) => {
      run.tool.extensions = {};
    },
  ],
  [
    "component null",
    (run) => {
      run.tool.extensions[0] = null;
    },
  ],
  [
    "component rules not an array",
    (run) => {
      run.tool.extensions[1].rules = {};
    },
  ],
  [
    "results missing",
    (run) => {
      delete run.results;
    },
  ],
  [
    "result null",
    (run) => {
      run.results[0] = null;
    },
  ],
  [
    "result has no rule references",
    (run) => {
      run.results[0] = {};
    },
  ],
]) {
  test(`fail closed report: ${name}`, () => {
    assert.throws(() => securityFindings(changedExtension(change)));
  });
}

test("malformed index values cannot coerce into a convenient component or rule", () => {
  for (const invalid of [-2, 0.5, "1", null, true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    for (const change of [
      (_run, result) => {
        result.rule.toolComponent.index = invalid;
      },
      (_run, result) => {
        result.rule.index = invalid;
      },
      (_run, result) => {
        result.ruleIndex = invalid;
      },
    ]) {
      assert.throws(() => securityFindings(changedExtension(change)), /Malformed/);
    }
  }
});

test("malformed ID, name, and GUID values fail closed", () => {
  for (const invalid of ["", " ", null, true, 1, [], {}]) {
    for (const change of [
      (_run, result) => {
        result.ruleId = invalid;
      },
      (_run, result) => {
        result.rule.id = invalid;
      },
      (_run, result) => {
        result.rule.toolComponent.name = invalid;
      },
      (_run, result) => {
        result.rule.guid = invalid;
      },
      (_run, result) => {
        result.rule.toolComponent.guid = invalid;
      },
    ]) {
      assert.throws(() => securityFindings(changedExtension(change)), /Malformed/);
    }
  }
  for (const invalid of ["not-a-guid", "00000000-0000-0000-0000-000000000000"]) {
    assert.throws(
      () =>
        securityFindings(
          changedExtension((_run, result) => {
            result.rule.guid = invalid;
          }),
        ),
      /Malformed/,
    );
  }
});

test("malformed security severities never become zero or NaN", () => {
  for (const invalid of [
    "",
    " ",
    "NaN",
    "Infinity",
    "7.5bad",
    "0x0",
    "1e0",
    "-1",
    "10.1",
    null,
    true,
    false,
    {},
    [],
    [0],
    NaN,
    Infinity,
    -1,
    10.1,
  ]) {
    assert.throws(
      () => securityFindings(extensionReport({ level: "warning" }, invalid)),
      /Malformed.*security-severity/,
    );
  }
});

test("valid numeric security severities retain high/critical boundaries", () => {
  for (const score of [7, "7", "7.0", 7.5, "7.5", 10, "10.0"]) {
    assert.equal(securityFindings(extensionReport({ level: "warning" }, score)).length, 1);
  }
  for (const score of [0, "0", "0.0", ".5", 6.9, "6.9"]) {
    assert.equal(securityFindings(extensionReport({ level: "warning" }, score)).length, 0);
  }
});

test("missing security score still rejects an error-level rule", () => {
  const value = changedExtension((run) => {
    delete run.tool.extensions[1].rules[34].properties;
  });
  assert.equal(securityFindings(value)[0].score, 0);
  assert.equal(securityFindings(value)[0].level, "error");
  value.runs[0].results[0].level = "warning";
  assert.equal(securityFindings(value).length, 0);
});

test("malformed result or default levels fail even if another severity field would pass", () => {
  for (const invalid of ["", " ", "fatal", "ERROR", null, 0, false, [], {}]) {
    assert.throws(() => securityFindings(extensionReport({ level: invalid }, "0")), /Malformed/);
    assert.throws(
      () =>
        securityFindings(
          changedExtension((run, result) => {
            run.tool.extensions[1].rules[34].defaultConfiguration.level = invalid;
            result.level = "warning";
          }),
        ),
      /Malformed/,
    );
  }
});

test("multiple runs are all checked and valid empty reports remain clear", () => {
  const value = report("0");
  value.runs.push(extensionReport().runs[0]);
  assert.equal(securityFindings(value).length, 1);
  for (const run of value.runs) run.results = [];
  assert.deepEqual(securityFindings(value), []);
  for (const invalid of [null, [], {}, { runs: null }, { runs: [null] }]) {
    assert.throws(() => securityFindings(invalid));
  }
});

test("distinct descriptor GUIDs do not become ambiguous", () => {
  const value = changedExtension((run, result) => {
    run.tool.driver.guid = otherComponentGuid;
    run.tool.extensions[1].guid = componentGuid;
    run.tool.extensions[1].rules[0].guid = otherRuleGuid;
    run.tool.extensions[1].rules[34].guid = ruleGuid;
    result.rule.guid = ruleGuid;
    result.rule.toolComponent.guid = componentGuid;
  });
  assert.equal(securityFindings(value).length, 1);
});

function gateDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "engineo-sarif-check-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runGate(directory) {
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./check-codeql.mjs", import.meta.url)), directory],
    { encoding: "utf8" },
  );
}

test("CLI rejects a resolved suppressed/unchanged high extension finding with a diagnostic", (t) => {
  const directory = gateDirectory(t);
  writeFileSync(
    join(directory, "javascript.sarif"),
    JSON.stringify(
      extensionReport({ suppressions: [{ status: "accepted" }], baselineState: "unchanged" }),
    ),
  );
  const result = runGate(directory);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const diagnostic = JSON.parse(result.stdout);
  assert.equal(diagnostic.reports, 1);
  assert.equal(diagnostic.highOrErrorFindings.length, 1);
  assert.equal(diagnostic.highOrErrorFindings[0].score, 7.5);
  assert.equal(diagnostic.highOrErrorFindings[0].level, "error");
});

test("CLI recursively checks every SARIF report and passes known empty results", (t) => {
  const directory = gateDirectory(t);
  const value = extensionReport();
  value.runs[0].results = [];
  mkdirSync(join(directory, "nested"));
  writeFileSync(join(directory, "javascript.sarif"), JSON.stringify(value));
  writeFileSync(join(directory, "nested", "rust.sarif"), JSON.stringify(value));
  const result = runGate(directory);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { reports: 2, highOrErrorFindings: [] });
});

test("CLI missing, malformed, and unknown reports all fail closed", (t) => {
  const directory = gateDirectory(t);
  assert.equal(runGate(directory).status, 1);
  for (const text of [
    "{invalid",
    JSON.stringify({ runs: [] }),
    JSON.stringify(report("0", { ruleId: "not-known" })),
  ]) {
    writeFileSync(join(directory, "javascript.sarif"), text);
    const result = runGate(directory);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.notEqual(result.stderr, "");
  }
});

test("legacy driver ID-only fallback rejects exact/prefix ambiguity instead of taking low severity", () => {
  const value = report("7.5", { ruleId: "security-rule/specific-case" });
  value.runs[0].tool.driver.rules.push({
    id: "security-rule/specific-case",
    properties: { "security-severity": "0" },
  });
  assert.throws(() => securityFindings(value), /Ambiguous SARIF rule/);
  value.runs[0].results[0].ruleIndex = 0;
  assert.equal(securityFindings(value)[0].score, 7.5);
  value.runs[0].results[0].ruleIndex = 1;
  assert.equal(securityFindings(value).length, 0);
  value.runs[0].tool.driver.rules.pop();
  delete value.runs[0].results[0].ruleIndex;
  assert.throws(() => securityFindings(value), /Unknown SARIF legacy driver rule/);
});

function overrideReport(level = "error", result = {}, score = "0") {
  const value = extensionReport(result, score);
  value.runs[0].tool.extensions[1].rules[34].defaultConfiguration.level = "warning";
  value.runs[0].invocations = [
    {
      executionSuccessful: true,
      ruleConfigurationOverrides: [
        {
          descriptor: { id: tlsRuleId, index: 34, toolComponent: { index: 1 } },
          configuration: { level },
        },
      ],
    },
  ];
  return value;
}

function changedOverride(change) {
  const value = overrideReport();
  change(
    value.runs[0],
    value.runs[0].results[0],
    value.runs[0].invocations[0].ruleConfigurationOverrides[0],
  );
  return value;
}

test("invocation override error rejects a warning rule when result.level is absent", () => {
  const value = overrideReport();
  assert.equal(securityFindings(value)[0].level, "error");
  value.runs[0].results[0].provenance = { invocationIndex: 0 };
  assert.equal(securityFindings(value)[0].level, "error");
});

test("single-invocation default attribution applies with absent or empty provenance", () => {
  for (const provenance of [undefined, {}, { conversionSources: [] }]) {
    const value = overrideReport();
    if (provenance !== undefined) value.runs[0].results[0].provenance = provenance;
    assert.equal(securityFindings(value)[0].level, "error");
  }
});

test("explicit result levels retain SARIF precedence over an attributed override", () => {
  assert.equal(securityFindings(overrideReport("error", { level: "warning" })).length, 0);
  assert.equal(securityFindings(overrideReport("warning", { level: "error" }))[0].level, "error");
});

test("warning/none overrides cannot downgrade high, suppressed or unchanged security scores", () => {
  for (const level of ["warning", "none"]) {
    const findings = securityFindings(
      overrideReport(
        level,
        { suppressions: [{ status: "accepted" }], baselineState: "unchanged" },
        "7.5",
      ),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].score, 7.5);
  }
  assert.equal(
    securityFindings(
      overrideReport("error", {
        suppressions: [{ status: "accepted" }],
        baselineState: "unchanged",
      }),
    ).length,
    1,
  );
});

test("override configuration without a level preserves the descriptor default", () => {
  const value = changedOverride((run, _result, override) => {
    run.tool.extensions[1].rules[34].defaultConfiguration.level = "error";
    delete override.configuration.level;
  });
  assert.equal(securityFindings(value)[0].level, "error");
});

test("attributed warning override can change a low-score rule's default level", () => {
  const value = overrideReport("warning");
  value.runs[0].tool.extensions[1].rules[34].defaultConfiguration.level = "error";
  assert.equal(securityFindings(value).length, 0);
});

test("multiple invocations use only the explicitly attributed invocation", () => {
  const value = overrideReport();
  const otherInvocation = structuredClone(value.runs[0].invocations[0]);
  otherInvocation.ruleConfigurationOverrides[0].configuration.level = "warning";
  value.runs[0].invocations.push(otherInvocation);
  value.runs[0].results[0].provenance = { invocationIndex: 0 };
  assert.equal(securityFindings(value)[0].level, "error");
  value.runs[0].results[0].provenance.invocationIndex = 1;
  assert.equal(securityFindings(value).length, 0);
});

test("override matching uses the resolved descriptor, not text ID alone or flattened components", () => {
  const value = changedOverride((run) => {
    run.tool.driver.rules.push({ id: tlsRuleId, properties: { "security-severity": "0" } });
    run.invocations[0].ruleConfigurationOverrides.unshift({
      descriptor: { id: tlsRuleId, index: 0 },
      configuration: { level: "none" },
    });
    run.tool.extensions[1].rules[0].id = tlsRuleId;
    run.invocations[0].ruleConfigurationOverrides.unshift({
      descriptor: { id: tlsRuleId, index: 0, toolComponent: { index: 1 } },
      configuration: { level: "none" },
    });
  });
  assert.equal(securityFindings(value)[0].level, "error");
});

test("override descriptors resolve matching component/rule GUIDs", () => {
  const value = changedOverride((run, _result, override) => {
    run.tool.extensions[1].guid = componentGuid;
    run.tool.extensions[1].rules[34].guid = ruleGuid;
    override.descriptor = { id: tlsRuleId, guid: ruleGuid, toolComponent: { guid: componentGuid } };
  });
  assert.equal(securityFindings(value)[0].level, "error");
});

for (const [name, change, error] of [
  [
    "multiple invocations lack attribution",
    (run) => {
      run.invocations.push({ executionSuccessful: true });
    },
    /Ambiguous SARIF invocation/,
  ],
  [
    "explicit unknown attribution overrides the single-invocation default",
    (_run, result) => {
      result.provenance = { invocationIndex: -1 };
    },
    /Ambiguous SARIF invocation/,
  ],
  [
    "invalid invocation index",
    (_run, result) => {
      result.provenance = { invocationIndex: 1 };
    },
    /Unknown SARIF invocation/,
  ],
  [
    "missing invocation array",
    (run, result) => {
      delete run.invocations;
      result.provenance = { invocationIndex: 0 };
    },
    /missing invocations/,
  ],
  [
    "malformed invocation array",
    (run) => {
      run.invocations = {};
    },
    /Malformed/,
  ],
  [
    "malformed invocation",
    (run) => {
      run.invocations[0] = null;
    },
    /Malformed/,
  ],
  [
    "malformed overrides array",
    (run) => {
      run.invocations[0].ruleConfigurationOverrides = {};
    },
    /Malformed/,
  ],
  [
    "malformed override",
    (run) => {
      run.invocations[0].ruleConfigurationOverrides[0] = null;
    },
    /Malformed/,
  ],
  [
    "missing override descriptor",
    (_run, _result, override) => {
      delete override.descriptor;
    },
    /missing descriptor/,
  ],
  [
    "missing override configuration",
    (_run, _result, override) => {
      delete override.configuration;
    },
    /missing descriptor or configuration/,
  ],
  [
    "malformed override descriptor",
    (_run, _result, override) => {
      override.descriptor = [];
    },
    /Malformed/,
  ],
  [
    "malformed override configuration",
    (_run, _result, override) => {
      override.configuration = null;
    },
    /Malformed/,
  ],
  [
    "unknown descriptor rule index",
    (_run, _result, override) => {
      override.descriptor.index = 35;
    },
    /Unknown SARIF rule/,
  ],
  [
    "conflicting descriptor ID and index",
    (_run, _result, override) => {
      override.descriptor.index = 0;
    },
    /Conflicting/,
  ],
  [
    "conflicting descriptor component name",
    (_run, _result, override) => {
      override.descriptor.toolComponent.name = "CodeQL";
    },
    /Conflicting/,
  ],
  [
    "unknown descriptor component index",
    (_run, _result, override) => {
      override.descriptor.toolComponent.index = 4;
    },
    /Unknown SARIF tool component/,
  ],
  [
    "conflicting descriptor rule GUID and index",
    (run, _result, override) => {
      run.tool.extensions[1].rules[0].guid = ruleGuid;
      override.descriptor.guid = ruleGuid;
    },
    /Conflicting/,
  ],
  [
    "unknown descriptor rule GUID",
    (_run, _result, override) => {
      override.descriptor.guid = ruleGuid;
    },
    /Unknown/,
  ],
  [
    "duplicate override attribution",
    (run, _result, override) => {
      run.invocations[0].ruleConfigurationOverrides.push(structuredClone(override));
    },
    /Ambiguous SARIF configuration/,
  ],
  [
    "conflicting override attribution",
    (run, _result, override) => {
      const other = structuredClone(override);
      other.configuration.level = "warning";
      run.invocations[0].ruleConfigurationOverrides.push(other);
    },
    /Ambiguous SARIF configuration/,
  ],
  [
    "malformed provenance",
    (_run, result) => {
      result.provenance = null;
    },
    /Malformed/,
  ],
]) {
  test(`fail closed override: ${name}`, () => {
    assert.throws(() => securityFindings(changedOverride(change)), error);
  });
}

test("malformed override level or invocation index cannot coerce to a convenient severity", () => {
  for (const invalid of [null, "", "fatal", false, 0, [], {}]) {
    assert.throws(() => securityFindings(overrideReport(invalid)), /Malformed/);
  }
  for (const invalid of [-2, "0", null, 0.5, true, [], {}]) {
    assert.throws(
      () => securityFindings(overrideReport("error", { provenance: { invocationIndex: invalid } })),
      /Malformed/,
    );
  }
});

test("unattributed invocations without an applicable rule override retain default-level behavior", () => {
  const value = changedOverride((run, result, override) => {
    override.descriptor.id = "js/unrelated-0";
    override.descriptor.index = 0;
    run.invocations.push({ executionSuccessful: true });
    result.provenance = { invocationIndex: -1 };
  });
  assert.equal(securityFindings(value).length, 0);
  value.runs[0].tool.extensions[1].rules[34].defaultConfiguration.level = "error";
  assert.equal(securityFindings(value)[0].level, "error");
});

test("driver override descriptors require index/GUID and use the shared resolver", () => {
  const value = report("0", { ruleIndex: 0 });
  value.runs[0].invocations = [
    {
      executionSuccessful: true,
      ruleConfigurationOverrides: [
        { descriptor: { id: "security-rule", index: 0 }, configuration: { level: "error" } },
      ],
    },
  ];
  assert.equal(securityFindings(value)[0].level, "error");
  delete value.runs[0].invocations[0].ruleConfigurationOverrides[0].descriptor.index;
  assert.throws(() => securityFindings(value), /missing a resolvable index or GUID/);
});

test("explicit levels do not need unknown invocation attribution to determine severity", () => {
  for (const provenance of [undefined, { invocationIndex: -1 }]) {
    for (const level of ["warning", "error"]) {
      const value = overrideReport("error", { level });
      value.runs[0].invocations.push({ executionSuccessful: true });
      if (provenance !== undefined) value.runs[0].results[0].provenance = provenance;
      assert.equal(securityFindings(value).length, level === "error" ? 1 : 0);
      value.runs[0].tool.extensions[1].rules[34].properties["security-severity"] = "7.5";
      assert.equal(securityFindings(value)[0].score, 7.5);
    }
  }
});

test("explicit levels cannot bypass malformed or out-of-range invocation references", () => {
  for (const level of ["warning", "error"]) {
    assert.throws(
      () =>
        securityFindings(overrideReport("error", { level, provenance: { invocationIndex: 1 } })),
      /Unknown SARIF invocation/,
    );
    assert.throws(
      () =>
        securityFindings(overrideReport("error", { level, provenance: { invocationIndex: "0" } })),
      /Malformed/,
    );
  }
});

test("misspelled default or override severity fields fail closed", () => {
  const value = changedOverride((run, _result, override) => {
    override.configuration = { levle: "error" };
    run.tool.extensions[1].rules[34].defaultConfiguration = { level: "warning" };
  });
  assert.throws(() => securityFindings(value), /Malformed/);
  value.runs[0].invocations[0].ruleConfigurationOverrides[0].configuration = { level: "warning" };
  value.runs[0].tool.extensions[1].rules[34].defaultConfiguration = { levle: "error" };
  assert.throws(() => securityFindings(value), /Malformed/);
});

test("reporting configurations reject malformed enabled, rank, parameters and properties", () => {
  for (const configuration of [
    { enabled: "false" },
    { enabled: null },
    { rank: "0" },
    { rank: NaN },
    { rank: Infinity },
    { rank: -1.1 },
    { rank: 100.1 },
    { parameters: null },
    { parameters: [] },
    { properties: null },
    { properties: [] },
  ]) {
    for (const change of [
      (run) => {
        run.tool.extensions[1].rules[34].defaultConfiguration = configuration;
      },
      (_run, _result, override) => {
        override.configuration = configuration;
      },
    ]) {
      assert.throws(() => securityFindings(changedOverride(change)), /Malformed/);
    }
  }
});

test("valid reporting configuration metadata never disables a high security finding", () => {
  for (const rank of [-1, 0, 50.5, 100]) {
    const value = overrideReport(
      "warning",
      { suppressions: [{ status: "accepted" }], baselineState: "unchanged" },
      "7.5",
    );
    Object.assign(value.runs[0].invocations[0].ruleConfigurationOverrides[0].configuration, {
      enabled: false,
      rank,
      parameters: {},
      properties: {},
    });
    Object.assign(value.runs[0].tool.extensions[1].rules[34].defaultConfiguration, {
      enabled: false,
      rank,
      parameters: {},
      properties: {},
    });
    assert.equal(securityFindings(value)[0].score, 7.5);
  }
});
