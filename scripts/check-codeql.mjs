import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function securityFindings(report) {
  if (!Array.isArray(report.runs) || report.runs.length === 0) {
    throw new Error("CodeQL SARIF contains no runs");
  }
  const findings = [];
  for (const run of report.runs) {
    if (!Array.isArray(run.results) || !Array.isArray(run.tool?.driver?.rules)) {
      throw new Error("CodeQL SARIF is missing rules or results");
    }
    const rules = new Map(run.tool.driver.rules.map((rule) => [rule.id, rule]));
    for (const result of run.results) {
      const rule = rules.get(result.ruleId);
      if (!rule) throw new Error(`Unknown SARIF rule: ${result.ruleId}`);
      const score = Number(rule.properties?.["security-severity"] ?? 0);
      const level = result.level ?? rule.defaultConfiguration?.level;
      if (score >= 7 || level === "error") {
        const location = result.locations?.[0]?.physicalLocation;
        findings.push({
          rule: result.ruleId,
          score,
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
