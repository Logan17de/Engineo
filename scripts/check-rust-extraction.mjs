import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const cleanRule = "rust/summary/number-of-successfully-extracted-files";
const failedRule = "rust/summary/number-of-files-extracted-with-errors";

export function rustExtractionCoverage(report, sources) {
  if (
    !Array.isArray(sources) ||
    sources.length === 0 ||
    !sources.every((source) => typeof source === "string" && source.endsWith(".rs")) ||
    new Set(sources).size !== sources.length
  ) {
    throw new Error("Expected a nonempty tracked Rust source inventory");
  }
  const expectedFiles = sources.length;
  if (!Array.isArray(report.runs) || report.runs.length === 0) {
    throw new Error("Rust coverage SARIF contains no runs");
  }
  return report.runs.map((run) => {
    const metrics = run.properties?.metricResults;
    if (!Array.isArray(metrics)) throw new Error("Rust extraction metrics are missing");
    const count = (id) => {
      const entries = metrics.filter((metric) => metric.ruleId === id || metric.rule?.id === id);
      if (entries.length !== 1) throw new Error(`Expected one extraction metric: ${id}`);
      const metric = entries[0];
      if (
        (metric.ruleId !== undefined && metric.ruleId !== id) ||
        (metric.rule?.id !== undefined && metric.rule.id !== id) ||
        !Number.isSafeInteger(metric.value) ||
        metric.value < 0
      )
        throw new Error(`Invalid extraction metric: ${id}`);
      return metric.value;
    };
    const cleanFiles = count(cleanRule);
    const failedFiles = count(failedRule);
    if (failedFiles !== 0 || cleanFiles !== expectedFiles) {
      throw new Error(
        `Rust extraction incomplete: ${cleanFiles} clean, ${failedFiles} with errors; ${expectedFiles} tracked source files expected`,
      );
    }
    if (!Array.isArray(run.invocations) || run.invocations.length === 0) {
      throw new Error("Rust extraction invocation evidence is missing");
    }
    const extracted = new Set();
    for (const invocation of run.invocations) {
      if (invocation.executionSuccessful !== true)
        throw new Error("Rust extraction failed or successful invocation evidence is missing");
      for (const notification of invocation.toolExecutionNotifications ?? []) {
        if (
          notification.level === "error" ||
          /rust\/diagnostics\/extraction-(warnings|errors)/.test(notification.descriptor?.id ?? "")
        )
          throw new Error(`Rust extraction diagnostic: ${notification.message?.text ?? "unknown"}`);
        if (notification.descriptor?.id === "rust/diagnostics/successfully-extracted-files") {
          for (const location of notification.locations ?? []) {
            const artifact = location.physicalLocation?.artifactLocation;
            if (artifact?.uriBaseId !== "%SRCROOT%" || typeof artifact.uri !== "string")
              throw new Error("Rust source extraction has no repository-relative location");
            extracted.add(decodeURIComponent(artifact.uri));
          }
        }
      }
    }
    if (extracted.size !== expectedFiles || sources.some((source) => !extracted.has(source)))
      throw new Error("Rust extracted source inventory does not match tracked files");
    return { cleanFiles, failedFiles, expectedFiles };
  });
}

async function main(directory) {
  if (!directory)
    throw new Error("Usage: node scripts/check-rust-extraction.mjs <SARIF directory>");
  const sources = execFileSync("git", ["ls-files", "-z", "--", "*.rs"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const files = (await readdir(directory, { recursive: true })).filter((file) =>
    file.endsWith(".sarif"),
  );
  if (files.length === 0) throw new Error("CodeQL produced no Rust SARIF reports");
  const coverage = [];
  for (const file of files) {
    coverage.push(
      ...rustExtractionCoverage(
        JSON.parse(await readFile(resolve(directory, file), "utf8")),
        sources,
      ),
    );
  }
  console.log(JSON.stringify({ reports: files.length, coverage }, null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main(process.argv[2]);
}
