import { plannerViewOperationWindowV1 } from "@engineo/contracts";
import type { Arguments } from "./arguments.js";
import { CliError } from "./errors.js";
import { uuid } from "./json.js";

export const VIEW_COMMANDS = [
  "help",
  "capabilities",
  "list",
  "read",
  "validate",
  "plan",
  "apply",
  "status",
  "project",
  "select",
] as const;
export type ViewCommand = (typeof VIEW_COMMANDS)[number];
export interface ViewArguments {
  command: ViewCommand;
  /** Reuses the existing destination/session loader without extending legacy commands. */
  remote: Arguments;
}
const shared = [
  "api-origin",
  "app-origin",
  "organization",
  "project",
  "auth-file",
  "auth-fd",
  "timeout-ms",
];
const options: Record<ViewCommand, string[]> = {
  help: [],
  capabilities: shared,
  list: [...shared, "limit", "cursor"],
  read: [...shared, "view-id", "out"],
  validate: [...shared, "file"],
  plan: [
    ...shared,
    "action",
    "file",
    "view-id",
    "expected-view-revision",
    "expected-schedule-revision",
    "operation-window",
    "operation-id",
    "out",
  ],
  apply: [...shared, "review", "expected-schedule-revision"],
  status: [...shared, "operation-window", "operation-id", "review"],
  project: [...shared, "file", "view-id", "expected-schedule-revision", "out"],
  select: [...shared, "view-id", "expected-schedule-revision", "out"],
};
function usage(): never {
  throw new CliError(
    "usage",
    "invalid_view_arguments",
    "Invalid or missing private-view options. Run engineo views help.",
  );
}
export function parseViewArguments(argv: readonly string[]): ViewArguments {
  const first = argv[0];
  const command = first === undefined || first === "--help" ? "help" : first;
  if (!VIEW_COMMANDS.includes(command as ViewCommand)) usage();
  const selected = command as ViewCommand;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (!token?.startsWith("--") || token.includes("=")) usage();
    const key = token.slice(2);
    if (values.has(key) || flags.has(key)) usage();
    if (
      key === "allow-http-loopback" ||
      (selected === "validate" && ["offline", "authoritative"].includes(key))
    ) {
      if (selected === "help") usage();
      flags.add(key);
      continue;
    }
    if (!options[selected].includes(key)) usage();
    const value = argv[++index];
    if (
      !value ||
      value.startsWith("--") ||
      [...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      usage();
    values.set(key, value);
  }
  const result: ViewArguments = {
    command: selected,
    remote: { command: "read", values, flags },
  };
  if (selected === "help") return result;
  if (selected === "validate") {
    if (!values.has("file") || flags.has("offline") === flags.has("authoritative")) usage();
    if (flags.has("offline")) {
      if (values.size !== 1 || flags.size !== 1) usage();
      return result;
    }
  }
  for (const key of ["api-origin", "organization", "project"]) if (!values.has(key)) usage();
  if (values.has("auth-file") === values.has("auth-fd")) usage();
  for (const key of ["organization", "project", "view-id", "operation-id", "cursor"]) {
    const value = values.get(key);
    if (value !== undefined) {
      if (!uuid(value.toLowerCase())) usage();
      values.set(key, value.toLowerCase());
    }
  }
  for (const key of [
    "expected-schedule-revision",
    "expected-view-revision",
    "timeout-ms",
    "auth-fd",
    "limit",
  ]) {
    const raw = values.get(key);
    if (raw !== undefined && (!/^(?:0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))))
      usage();
  }
  for (const key of ["expected-schedule-revision", "expected-view-revision"])
    if (values.has(key) && Number(values.get(key)) < 1) usage();
  if (values.has("auth-fd") && Number(values.get("auth-fd")) < 3) usage();
  if (
    values.has("timeout-ms") &&
    (Number(values.get("timeout-ms")) < 100 || Number(values.get("timeout-ms")) > 120000)
  )
    usage();
  if (values.has("limit") && (Number(values.get("limit")) < 1 || Number(values.get("limit")) > 50))
    usage();
  const window = values.get("operation-window");
  if (window !== undefined) {
    try {
      if (plannerViewOperationWindowV1(`${window}T00:00:00.000Z`).operationWindowId !== window)
        usage();
    } catch {
      usage();
    }
  }
  const required: Partial<Record<ViewCommand, string[]>> = {
    read: ["view-id"],
    plan: ["action", "expected-schedule-revision", "operation-window", "operation-id", "out"],
    apply: ["review", "expected-schedule-revision"],
    status: ["operation-window", "operation-id"],
    project: ["expected-schedule-revision"],
    select: ["view-id", "expected-schedule-revision"],
  };
  for (const key of required[selected] ?? []) if (!values.has(key)) usage();
  if (selected === "project" && values.has("file") === values.has("view-id")) usage();
  if (selected === "plan") {
    const action = values.get("action");
    if (!["create", "update", "delete"].includes(action ?? "")) usage();
    if (action === "create") {
      if (!values.has("file") || values.has("view-id") || values.has("expected-view-revision"))
        usage();
    } else {
      if (!values.has("view-id") || !values.has("expected-view-revision")) usage();
      if ((action === "delete") === values.has("file")) usage();
    }
  }
  return result;
}

export const VIEW_HELP = {
  protocolVersion: 1,
  commands: {
    capabilities: "Show the server UTC operation window and protocol limits",
    list: "[--limit 1..50] [--cursor UUID]",
    read: "--view-id UUID [--out FILE]",
    validate: "--file FILE (--offline | --authoritative)",
    plan: "--action create|update|delete --operation-window YYYY-MM-DD --operation-id UUID --expected-schedule-revision N --out FILE; create/update: --file FILE; update/delete: --view-id UUID --expected-view-revision N",
    apply: "--review FILE --expected-schedule-revision N",
    status: "--operation-window YYYY-MM-DD --operation-id UUID [--review FILE]",
    project: "(--view-id UUID | --file FILE) --expected-schedule-revision N [--out FILE]",
    select: "--view-id UUID --expected-schedule-revision N [--out FILE]",
  },
  notes: [
    "Use engineo views COMMAND; remote options are the same explicit origins, project and private session source as existing commands.",
    "plan previews create/update/delete without storing a pending operation. Only apply sends a view mutation.",
    "Get the operation window from capabilities. Keep the caller-generated operation UUID and complete review after uncertainty.",
    "status reports historical receipts; an open-window absence does not establish cancellation or failure.",
    "select projects a named view for this invocation only. No persisted selection, schedule write or calculation is performed.",
    "Projection source verification belongs to the authenticated API; a digest alone does not establish real-engine provenance.",
    "The API dependency remains draft/held. No saved-view runtime, browser or cross-surface acceptance is claimed.",
  ],
};
