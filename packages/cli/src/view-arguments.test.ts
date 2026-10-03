import assert from "node:assert/strict";
import test from "node:test";
import { parseArguments } from "./arguments.js";
import { CliError } from "./errors.js";
import { parseJson, parseViewJson } from "./json.js";
import { parseViewArguments } from "./view-arguments.js";

const id = "00000000-0000-0000-0000-000000000001";
const remote = [
  "--api-origin",
  "https://api.example.test",
  "--organization",
  id,
  "--project",
  id,
  "--auth-fd",
  "3",
];
const plan = [
  "plan",
  ...remote,
  "--action",
  "create",
  "--file",
  "view.json",
  "--operation-window",
  "2026-10-03",
  "--operation-id",
  id,
  "--expected-schedule-revision",
  "1",
  "--out",
  "review.json",
];

test("view namespace leaves legacy command parsing unchanged", () => {
  assert.equal(parseArguments(["read", ...remote]).command, "read");
  assert.throws(() => parseArguments(["views", "list", ...remote]), CliError);
  assert.equal(parseViewArguments([]).command, "help");
  assert.equal(parseViewArguments(["--help"]).command, "help");
  assert.equal(parseViewArguments(["list", ...remote]).command, "list");
});
test("view plan requires explicit operation identity, review path and action-specific revisions", () => {
  assert.equal(parseViewArguments(plan).remote.values.get("action"), "create");
  const update = [...plan];
  update[update.indexOf("create")] = "update";
  assert.throws(() => parseViewArguments(update), CliError);
  assert.equal(
    parseViewArguments([...update, "--view-id", id, "--expected-view-revision", "2"]).command,
    "plan",
  );
  const deleting = [...update, "--view-id", id, "--expected-view-revision", "2"];
  deleting[deleting.indexOf("update")] = "delete";
  assert.throws(() => parseViewArguments(deleting), CliError);
  deleting.splice(deleting.indexOf("--file"), 2);
  assert.equal(parseViewArguments(deleting).remote.values.get("action"), "delete");
});
test("view validation has mutually exclusive explicit offline/authoritative modes", () => {
  assert.equal(parseViewArguments(["validate", "--file", "-", "--offline"]).command, "validate");
  for (const args of [
    ["validate", "--file", "x"],
    ["validate", "--file", "x", "--offline", "--authoritative"],
    ["validate", ...remote, "--file", "x", "--offline"],
  ])
    assert.throws(() => parseViewArguments(args), CliError);
  assert.equal(
    parseViewArguments(["validate", ...remote, "--file", "x", "--authoritative"]).command,
    "validate",
  );
});
test("view parser rejects unbounded, duplicate, unknown or conflicting flags", () => {
  for (const args of [
    ["list", ...remote, "--limit", "0"],
    ["list", ...remote, "--limit", "51"],
    ["list", ...remote, "--limit", "01"],
    ["list", ...remote, "--limit", "1e1"],
    ["list", ...remote, "--limit", "1", "--limit", "2"],
    ["read", ...remote, "--view-id", "Native"],
    ["project", ...remote, "--view-id", id, "--file", "x", "--expected-schedule-revision", "1"],
    ["select", ...remote, "--file", "x", "--expected-schedule-revision", "1"],
    ["apply", ...remote, "--review", "x", "--expected-schedule-revision", "-0"],
    ["status", ...remote, "--operation-window", "2026-02-30", "--operation-id", id],
    ["status", ...remote, "--operation-window", "9999-12-30", "--operation-id", id],
  ])
    assert.throws(() => parseViewArguments(args), CliError);
});
test("private-view response parsing enforces original integers without changing legacy JSON", () => {
  assert.deepEqual(parseJson('{"n":1e0}', 100), { n: 1 });
  assert.deepEqual(parseViewJson('{"n":1}', 100), { n: 1 });
  for (const source of [
    '{"n":1e0}',
    '{"n":1.0}',
    '{"n":-0}',
    '{"n":1,"n":2}',
    '{"constructor":0}',
    "\uFEFF{}",
  ])
    assert.throws(() => parseViewJson(source, 100), CliError);
  assert.doesNotThrow(() => parseViewJson("[".repeat(8) + "]".repeat(8), 100));
  assert.throws(() => parseViewJson("[".repeat(9) + "]".repeat(9), 100), CliError);
});
