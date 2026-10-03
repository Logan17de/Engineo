import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Malformed SARIF ${label}`);
  }
  return value;
}

function optionalString(value, key, label) {
  if (!Object.hasOwn(value, key)) return undefined;
  if (typeof value[key] !== "string" || value[key].trim().length === 0) {
    throw new Error(`Malformed SARIF ${label}`);
  }
  return value[key];
}

function optionalIndex(value, key, label) {
  if (!Object.hasOwn(value, key)) return undefined;
  if (!Number.isSafeInteger(value[key]) || value[key] < -1) {
    throw new Error(`Malformed SARIF ${label}`);
  }
  return value[key];
}

function optionalGuid(value, label) {
  const guid = optionalString(value, "guid", `${label} GUID`);
  if (guid === undefined) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(guid)) {
    throw new Error(`Malformed SARIF ${label} GUID`);
  }
  return guid.toLowerCase();
}

function reference(value, keys, label) {
  object(value, label);
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`Malformed SARIF ${label}`);
  }
  if (Object.hasOwn(value, "properties")) object(value.properties, `${label} properties`);
  return value;
}

function uniqueMatch(values, matches, label) {
  const selected = values.filter(matches);
  if (selected.length !== 1) {
    throw new Error(`${selected.length === 0 ? "Unknown" : "Ambiguous"} SARIF ${label}`);
  }
  return selected[0];
}

function toolComponents(run) {
  const tool = object(run.tool, "tool");
  object(tool.driver, "driver");
  if (!Array.isArray(tool.driver.rules)) {
    throw new Error("CodeQL SARIF is missing rules or results");
  }
  const extensions = Object.hasOwn(tool, "extensions") ? tool.extensions : [];
  if (!Array.isArray(extensions)) throw new Error("Malformed SARIF extensions");
  for (const component of [tool.driver, ...extensions]) {
    object(component, "tool component");
    optionalString(component, "name", "tool component name");
    optionalGuid(component, "tool component");
    if (Object.hasOwn(component, "rules")) {
      if (!Array.isArray(component.rules)) throw new Error("Malformed SARIF component rules");
      for (const rule of component.rules) {
        object(rule, "rule metadata");
        if (optionalString(rule, "id", "rule metadata ID") === undefined) {
          throw new Error("SARIF rule metadata is missing an ID");
        }
        optionalGuid(rule, "rule metadata");
      }
    }
  }
  return { driver: tool.driver, extensions };
}

function resolveComponent(components, value) {
  // SARIF 2.1.0 §3.54: index addresses extensions, never a driver-prefixed array.
  const ref = reference(value, ["index", "guid", "name", "properties"], "tool component reference");
  const index = optionalIndex(ref, "index", "tool component index");
  const guid = optionalGuid(ref, "tool component reference");
  const name = optionalString(ref, "name", "tool component reference name");
  let component = components.driver;
  if (index !== undefined && index !== -1) {
    component = components.extensions[index];
    if (!component) throw new Error(`Unknown SARIF tool component index: ${index}`);
  }
  if (guid !== undefined) {
    const byGuid = uniqueMatch(
      [components.driver, ...components.extensions],
      (candidate) => optionalGuid(candidate, "tool component") === guid,
      `tool component GUID: ${guid}`,
    );
    if (index !== undefined && index !== -1 && component !== byGuid) {
      throw new Error("Conflicting SARIF tool component index and GUID");
    }
    component = byGuid;
  }
  if (name !== undefined && component.name !== name) {
    throw new Error("Conflicting SARIF tool component name");
  }
  return component;
}

function matchesRuleId(id, metadataId) {
  // §3.52.4 permits exactly one extra hierarchical component in the result ID.
  return (
    id === metadataId ||
    (id.startsWith(`${metadataId}/`) && !id.slice(metadataId.length + 1).includes("/"))
  );
}

function resolveRule(components, result, { allowDriverId = true } = {}) {
  object(result, "result");
  const ref = reference(
    Object.hasOwn(result, "rule") ? result.rule : {},
    ["id", "index", "guid", "toolComponent", "properties"],
    "rule reference",
  );
  const resultId = optionalString(result, "ruleId", "result rule ID");
  const refId = optionalString(ref, "id", "rule reference ID");
  const resultIndex = optionalIndex(result, "ruleIndex", "result rule index");
  const refIndex = optionalIndex(ref, "index", "rule reference index");
  if (resultId !== undefined && refId !== undefined && resultId !== refId) {
    throw new Error("Conflicting SARIF result ruleId and rule.id");
  }
  if (resultIndex !== undefined && refIndex !== undefined && resultIndex !== refIndex) {
    throw new Error("Conflicting SARIF result ruleIndex and rule.index");
  }
  const id = refId ?? resultId;
  const index = refIndex ?? resultIndex;
  const guid = optionalGuid(ref, "rule reference");
  const component = resolveComponent(
    components,
    Object.hasOwn(ref, "toolComponent") ? ref.toolComponent : {},
  );
  if (!Array.isArray(component.rules)) throw new Error("SARIF component is missing rule metadata");
  let rule;
  if (index !== undefined && index !== -1) {
    rule = component.rules[index];
    if (!rule) throw new Error(`Unknown SARIF rule index: ${index}`);
  }
  if (guid !== undefined) {
    const byGuid = uniqueMatch(
      component.rules,
      (candidate) => optionalGuid(candidate, "rule metadata") === guid,
      `rule GUID: ${guid}`,
    );
    if (rule !== undefined && rule !== byGuid) {
      throw new Error("Conflicting SARIF rule index and GUID");
    }
    rule = byGuid;
  }
  if (rule === undefined) {
    // Preserve legacy driver ID-only reports. Never search other components or
    // choose among duplicate IDs; extension metadata requires an index or GUID.
    if (!allowDriverId || id === undefined || component !== components.driver) {
      throw new Error("SARIF rule reference is missing a resolvable index or GUID");
    }
    rule = uniqueMatch(
      component.rules,
      (candidate) => matchesRuleId(id, candidate.id),
      `rule: ${id}`,
    );
    if (rule.id !== id) throw new Error(`Unknown SARIF legacy driver rule: ${id}`);
  }
  if (id !== undefined && !matchesRuleId(id, rule.id)) {
    throw new Error("Conflicting SARIF rule ID and metadata");
  }
  return { rule, id: id ?? rule.id };
}

function securityScore(rule) {
  if (!Object.hasOwn(rule, "properties")) return 0;
  const properties = object(rule.properties, "rule properties");
  if (!Object.hasOwn(properties, "security-severity")) return 0;
  const value = properties["security-severity"];
  if (
    (typeof value !== "number" &&
      (typeof value !== "string" || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value))) ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0 ||
    Number(value) > 10
  ) {
    throw new Error(`Malformed SARIF security-severity for rule: ${rule.id}`);
  }
  return Number(value);
}

function severityLevel(value, label) {
  const level = optionalString(value, "level", label);
  if (level !== undefined && !["none", "note", "warning", "error"].includes(level)) {
    throw new Error(`Malformed SARIF ${label}`);
  }
  return level;
}

function reportingConfiguration(value, label) {
  const configuration = reference(
    value,
    ["enabled", "level", "rank", "parameters", "properties"],
    label,
  );
  severityLevel(configuration, `${label} level`);
  if (Object.hasOwn(configuration, "enabled") && typeof configuration.enabled !== "boolean") {
    throw new Error(`Malformed SARIF ${label} enabled`);
  }
  if (
    Object.hasOwn(configuration, "rank") &&
    (typeof configuration.rank !== "number" ||
      !Number.isFinite(configuration.rank) ||
      configuration.rank < -1 ||
      configuration.rank > 100)
  ) {
    throw new Error(`Malformed SARIF ${label} rank`);
  }
  if (Object.hasOwn(configuration, "parameters"))
    object(configuration.parameters, `${label} parameters`);
  return configuration;
}

function invocationOverrides(run, components) {
  const invocations = Object.hasOwn(run, "invocations") ? run.invocations : [];
  if (!Array.isArray(invocations)) throw new Error("Malformed SARIF invocations");
  return invocations.map((invocation) => {
    object(invocation, "invocation");
    const overrides = Object.hasOwn(invocation, "ruleConfigurationOverrides")
      ? invocation.ruleConfigurationOverrides
      : [];
    if (!Array.isArray(overrides)) throw new Error("Malformed SARIF rule configuration overrides");
    const levels = new Map();
    for (const override of overrides) {
      reference(override, ["descriptor", "configuration", "properties"], "configuration override");
      if (!Object.hasOwn(override, "descriptor") || !Object.hasOwn(override, "configuration")) {
        throw new Error("SARIF configuration override is missing descriptor or configuration");
      }
      const { rule } = resolveRule(
        components,
        { rule: override.descriptor },
        { allowDriverId: false },
      );
      const configuration = reportingConfiguration(
        override.configuration,
        "override configuration",
      );
      const level = severityLevel(configuration, "override level");
      if (levels.has(rule)) throw new Error("Ambiguous SARIF configuration overrides for one rule");
      levels.set(rule, level);
    }
    return levels;
  });
}

function invocationLevel(run, overrides, result, rule, needsLevel) {
  const provenance = Object.hasOwn(result, "provenance")
    ? object(result.provenance, "result provenance")
    : {};
  const explicitIndex = optionalIndex(provenance, "invocationIndex", "invocation index");
  if (explicitIndex !== undefined && !Object.hasOwn(run, "invocations")) {
    throw new Error("SARIF invocation reference is missing invocations");
  }
  // §3.48.6 defaults an absent invocationIndex to 0 only for one invocation.
  const index = explicitIndex ?? (overrides.length === 1 ? 0 : -1);
  if (index >= 0) {
    if (index >= overrides.length) throw new Error(`Unknown SARIF invocation index: ${index}`);
    return overrides[index].get(rule);
  }
  if (needsLevel && overrides.some((levels) => levels.has(rule))) {
    throw new Error("Ambiguous SARIF invocation attribution for rule configuration override");
  }
  return undefined;
}

export function securityFindings(report) {
  object(report, "report");
  if (!Array.isArray(report.runs) || report.runs.length === 0) {
    throw new Error("CodeQL SARIF contains no runs");
  }
  const findings = [];
  for (const run of report.runs) {
    object(run, "run");
    if (!Array.isArray(run.results)) {
      throw new Error("CodeQL SARIF is missing rules or results");
    }
    const components = toolComponents(run);
    const overrides = invocationOverrides(run, components);
    for (const result of run.results) {
      const { rule, id } = resolveRule(components, result);
      const score = securityScore(rule);
      const defaults = Object.hasOwn(rule, "defaultConfiguration")
        ? reportingConfiguration(rule.defaultConfiguration, "rule default configuration")
        : {};
      const defaultLevel = severityLevel(defaults, "rule default level");
      const resultLevel = severityLevel(result, "result level");
      const overrideLevel = invocationLevel(
        run,
        overrides,
        result,
        rule,
        resultLevel === undefined,
      );
      // §3.27.10: an explicit result level wins, then the attributed override.
      const level = resultLevel ?? overrideLevel ?? defaultLevel ?? "warning";
      if (score >= 7 || level === "error") {
        const location = result.locations?.[0]?.physicalLocation;
        findings.push({
          rule: id,
          score,
          level,
          file: location?.artifactLocation?.uri ?? "unknown",
          line: location?.region?.startLine ?? 0,
        });
      }
    }
  }
  return findings;
}

async function main(directory) {
  if (!directory) throw new Error("Usage: node scripts/check-codeql.mjs <SARIF directory>");
  const files = (await readdir(directory, { recursive: true })).filter((file) =>
    file.endsWith(".sarif"),
  );
  if (files.length === 0) throw new Error("CodeQL produced no SARIF reports");
  const findings = [];
  for (const file of files) {
    findings.push(
      ...securityFindings(JSON.parse(await readFile(resolve(directory, file), "utf8"))),
    );
  }
  console.log(JSON.stringify({ reports: files.length, highOrErrorFindings: findings }, null, 2));
  if (findings.length > 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main(process.argv[2]);
}
