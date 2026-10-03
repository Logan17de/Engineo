import { CliError } from "./errors.js";
import { uuid } from "./json.js";

export const COMMANDS = [
  "validate",
  "read",
  "export",
  "plan",
  "apply",
  "cancel",
  "status",
  "receipt",
  "calculate",
  "result",
  "help",
] as const;
export type Command = (typeof COMMANDS)[number];
export interface Arguments {
  command: Command;
  values: ReadonlyMap<string, string>;
  flags: ReadonlySet<string>;
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
const options: Record<Command, string[]> = {
  validate: [...shared, "file"],
  read: [...shared, "out"],
  export: [...shared, "out"],
  plan: [...shared, "file", "plan-id", "expected-revision", "out"],
  apply: [...shared, "plan", "expected-revision"],
  cancel: [...shared, "plan", "expected-revision"],
  status: [...shared, "plan-id", "out"],
  receipt: [...shared, "plan-id"],
  calculate: [...shared, "expected-revision"],
  result: [...shared, "expected-revision"],
  help: [],
};
function usage(): never {
  throw new CliError(
    "usage",
    "invalid_arguments",
    "Invalid or missing options. Run engineo help for the versioned command contract.",
  );
}
export function parseArguments(argv: readonly string[]): Arguments {
  const first = argv[0];
  const command = first === "--help" || first === undefined ? "help" : first;
  if (!COMMANDS.includes(command as Command)) usage();
  const selected = command as Command;
  const values = new Map<string, string>(),
    flags = new Set<string>();
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
  if (selected === "help") return { command: selected, values, flags };
  if (selected === "validate") {
    if (!values.has("file") || flags.has("offline") === flags.has("authoritative")) usage();
    if (flags.has("offline")) {
      if (values.size !== 1 || flags.size !== 1) usage();
      return { command: selected, values, flags };
    }
  }
  for (const key of ["api-origin", "organization", "project"]) if (!values.has(key)) usage();
  if (values.has("auth-file") === values.has("auth-fd")) usage();
  for (const key of ["organization", "project", "plan-id"]) {
    const value = values.get(key);
    if (value !== undefined) {
      if (!uuid(value.toLowerCase())) usage();
      values.set(key, value.toLowerCase());
    }
  }
  for (const key of ["expected-revision", "timeout-ms", "auth-fd"]) {
    const raw = values.get(key);
    if (raw !== undefined && (!/^(?:0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))))
      usage();
  }
  if (
    values.has("timeout-ms") &&
    (Number(values.get("timeout-ms")) < 100 || Number(values.get("timeout-ms")) > 120000)
  )
    usage();
  if (values.has("expected-revision") && Number(values.get("expected-revision")) < 1) usage();
  if (values.has("auth-fd") && Number(values.get("auth-fd")) < 3) usage();
  const required: Partial<Record<Command, string[]>> = {
    plan: ["file", "plan-id", "expected-revision", "out"],
    apply: ["plan", "expected-revision"],
    cancel: ["plan", "expected-revision"],
    status: ["plan-id"],
    receipt: ["plan-id"],
    calculate: ["expected-revision"],
    result: ["expected-revision"],
  };
  for (const key of required[selected] ?? []) if (!values.has(key)) usage();
  return { command: selected, values, flags };
}

export interface Destination {
  apiOrigin: string;
  appOrigin: string;
  organizationId: string;
  projectId: string;
}
export function safeOrigin(source: string, allowHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return usage();
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.origin === "null"
  )
    usage();
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      allowHttp &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new CliError(
      "usage",
      "https_required",
      "Use HTTPS, or explicitly allow disposable loopback HTTP.",
    );
  // Reject URL-parser aliases such as 127.1, integer IPv4 or percent-encoded hostnames.
  if (source !== url.origin && source !== `${url.origin}/`) usage();
  return url.origin;
}
export function destination(args: Arguments): Destination {
  const allowHttp = args.flags.has("allow-http-loopback");
  const apiOrigin = safeOrigin(args.values.get("api-origin") ?? "", allowHttp);
  const appOrigin = safeOrigin(args.values.get("app-origin") ?? apiOrigin, allowHttp);
  return {
    apiOrigin,
    appOrigin,
    organizationId: args.values.get("organization") ?? "",
    projectId: args.values.get("project") ?? "",
  };
}

export const HELP = {
  protocolVersion: 1,
  commands: {
    validate: "--file FILE (--offline | --authoritative)",
    read: "[--out FILE]",
    export: "[--out FILE]",
    plan: "--file FILE --plan-id UUID --expected-revision N --out FILE",
    apply: "--plan FILE --expected-revision N",
    cancel: "--plan FILE --expected-revision N",
    status: "--plan-id UUID [--out FILE]",
    receipt: "--plan-id UUID",
    calculate: "--expected-revision N",
    result: "--expected-revision N",
  },
  remoteOptions:
    "--api-origin ORIGIN --organization UUID --project UUID (--auth-file FILE | --auth-fd N) [--app-origin ORIGIN] [--timeout-ms 100..120000] [--allow-http-loopback]",
  notes: [
    "No login, password, Terraform provider, credential provisioning or JavaScript schedule math.",
    "plan-id is caller generated. Never change it after uncertainty.",
    "Apply/cancel require a complete saved review; receipts are historical.",
    "Output is one engineo-cli-output JSON v1 envelope, including errors. No diagnostic exception dumps.",
  ],
};
