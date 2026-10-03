import {
  ProjectConfigurationError,
  type ProjectConfigurationPlanV1,
  type ProjectConfigurationReadV1,
  parseProjectConfigurationReviewJsonV1,
  parseProjectConfigurationV1,
  serializeScheduleInputV1,
  validateProjectConfigurationV1,
} from "@engineo/contracts";
import { type Arguments, destination, HELP, parseArguments } from "./arguments.js";
import {
  checkPlan,
  checkPlanRead,
  checkRead,
  checkReceipt,
  checkSavedReview,
  hash,
  savedReview,
} from "./artifacts.js";
import { CliError, EXIT, integrity } from "./errors.js";
import { readInput, reserveOutput } from "./files.js";
import { exactKeys, record, rejectCredentials } from "./json.js";
import { checkResult } from "./result.js";
import { AmbiguousTransport, ApiClient, loadSession } from "./transport.js";

export interface CliOutputV1 {
  schemaVersion: 1;
  kind: "engineo-cli-output";
  command: string;
  ok: boolean;
  exitCode: number;
  data?: unknown;
  error?: { category: string; code: string; message: string; details?: unknown };
}
function success(command: string, data: unknown): CliOutputV1 {
  return { schemaVersion: 1, kind: "engineo-cli-output", command, ok: true, exitCode: 0, data };
}

function checkedConfiguration(source: string, secrets: readonly string[] = []) {
  let value: unknown;
  let parsed = false;
  try {
    value = JSON.parse(source);
    parsed = true;
  } catch {
    // The strict shared parser still owns malformed/duplicate/version rejection.
    value = null;
  }
  rejectCredentials(value, secrets);
  const checked = parseProjectConfigurationV1(source);
  if (!checked.valid) {
    const details = parsed
      ? checked
      : {
          ...checked,
          diagnostics: {
            ...checked.diagnostics,
            // Malformed input has not been credential-screened as decoded JSON.
            // Paths can contain quoted/escaped literal keys. Keep safe issue codes,
            // counts and character offsets, but never echo those untrusted keys.
            issues: checked.diagnostics.issues.map((issue) => ({ ...issue, path: "" })),
          },
        };
    rejectCredentials(details, secrets);
    throw new CliError(
      "validation",
      "configuration_invalid",
      "Configuration failed offline validation.",
      details,
    );
  }
  return checked;
}

export async function runCli(
  argv: readonly string[],
  interruption = new AbortController().signal,
): Promise<CliOutputV1> {
  let command = "unknown";
  let secrets: readonly string[] = [];
  try {
    const args = parseArguments(argv);
    command = args.command;
    if (command === "help") return success(command, HELP);
    const deadline = Date.now() + Number(args.values.get("timeout-ms") ?? 30000);
    const signal = AbortSignal.any([
      interruption,
      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    ]);
    if (args.flags.has("offline")) {
      const source = await readInput(args.values.get("file") ?? "", 1024 * 1024, signal);
      const checked = checkedConfiguration(source);
      return success(command, { ...checked, authoritative: false });
    }
    const target = destination(args);
    const session = await loadSession(args, signal);
    secrets = [session.sessionToken, session.csrfToken];
    const client = new ApiClient(target, session, deadline, interruption);
    await client.verifyIdentity();
    let output: Awaited<ReturnType<typeof reserveOutput>> | undefined;
    if (args.values.has("out")) output = await reserveOutput(args.values.get("out") ?? "");
    try {
      const data = await execute(args, client, signal, interruption);
      rejectCredentials(data, client.secrets);
      if (output) {
        const fileData =
          (command === "plan" || command === "status") && record(data) && record(data.plan)
            ? savedReview(checkPlan(data.plan, target, session), target)
            : (command === "read" || command === "export") && record(data)
              ? data.configuration
              : undefined;
        if (fileData === undefined)
          throw new CliError(
            "unavailable",
            "artifact_unavailable",
            "No complete review artifact is available to save.",
          );
        await output.save(fileData);
      }
      return success(command, data);
    } finally {
      await output?.discard();
    }
  } catch (error) {
    const failure =
      error instanceof AmbiguousTransport && interruption.aborted
        ? new CliError(
            "interrupted",
            "command_interrupted",
            "Command was interrupted before a mutation was sent.",
          )
        : error instanceof ProjectConfigurationError
          ? new CliError(
              "validation",
              "invalid_review_json",
              "Saved review must be bounded, duplicate-free versioned JSON.",
            )
          : error instanceof CliError
            ? error
            : new CliError(
                "unavailable",
                "command_failed",
                "Command failed without exposing underlying exception details.",
              );
    const output: CliOutputV1 = {
      schemaVersion: 1,
      kind: "engineo-cli-output",
      command,
      ok: false,
      exitCode: EXIT[failure.category],
      error: {
        category: failure.category,
        code: failure.code,
        message: failure.message,
        ...(failure.details === undefined ? {} : { details: failure.details }),
      },
    };
    // Screen decoded error details as well as supplied secrets, including offline
    // invocations that have no loaded session material.
    try {
      rejectCredentials(output, secrets);
    } catch {
      return {
        schemaVersion: 1,
        kind: "engineo-cli-output",
        command,
        ok: false,
        exitCode: EXIT.integrity,
        error: {
          category: "integrity",
          code: "credential_output_refused",
          message: "Unsafe output was refused.",
        },
      };
    }
    return output;
  }
}

async function readCurrent(
  client: ApiClient,
  expectedRevision?: number,
): Promise<ProjectConfigurationReadV1> {
  const current = checkRead(
    await client.request("GET", `${client.projectPath}/configuration`),
    client.target.projectId,
  );
  if (expectedRevision !== undefined && current.revision !== expectedRevision)
    throw new CliError(
      "conflict",
      "revision_conflict",
      "Project revision differs from the explicit expected revision.",
    );
  return current;
}
function unknownOutcome(action: string, planId: string | null, interrupted: boolean): CliError {
  return new CliError(
    interrupted ? "interrupted" : "uncertain",
    interrupted ? "mutation_interrupted" : "mutation_outcome_unknown",
    "Mutation outcome is unknown. Query the same identity; interruption or a closed socket is not cancellation.",
    { action, planId, outcomeKnown: false },
  );
}
async function recoverableMutation(
  client: ApiClient,
  path: string,
  body: unknown,
  recover: () => Promise<unknown>,
  action: string,
  planId: string | null,
  interruption: AbortSignal,
  maxResponseBytes = 16 * 1024 * 1024,
): Promise<{ value: unknown; recovered: boolean }> {
  try {
    return { value: await client.request("POST", path, body, maxResponseBytes), recovered: false };
  } catch (error) {
    if (!(error instanceof AmbiguousTransport)) throw error;
    if (interruption.aborted) throw unknownOutcome(action, planId, true);
    try {
      return { value: await recover(), recovered: true };
    } catch (recoveryError) {
      // Explicit authentication/integrity/conflict/capacity failures stay visible.
      if (
        recoveryError instanceof CliError &&
        recoveryError.code !== "configuration_not_terminal" &&
        ["auth", "integrity", "conflict", "capacity"].includes(recoveryError.category)
      )
        throw new CliError(
          recoveryError.category,
          recoveryError.code,
          "Recovery query was rejected; the original mutation outcome remains unknown.",
          {
            ...(record(recoveryError.details) ? recoveryError.details : {}),
            action,
            planId,
            outcomeKnown: false,
          },
        );
      throw unknownOutcome(action, planId, false);
    }
  }
}
async function execute(
  args: Arguments,
  client: ApiClient,
  signal: AbortSignal,
  interruption: AbortSignal,
): Promise<unknown> {
  const configurationPath = `${client.projectPath}/configuration`;
  const planId = args.values.get("plan-id") ?? "";
  const expectedRevision = Number(args.values.get("expected-revision"));
  switch (args.command) {
    case "read":
    case "export":
      return await readCurrent(client);
    case "validate": {
      const source = await readInput(args.values.get("file") ?? "", 1024 * 1024, signal);
      const checked = checkedConfiguration(source, client.secrets);
      const response = await client.request(
        "POST",
        `${configurationPath}/validate`,
        checked.normalizedConfiguration,
      );
      if (
        !record(response) ||
        !exactKeys(response, [
          "valid",
          "normalizedConfiguration",
          "desiredInputHashSha256",
          "calculationChecked",
          "diagnostics",
        ]) ||
        response.valid !== true ||
        response.calculationChecked !== false
      )
        integrity();
      const authoritative = validateProjectConfigurationV1(response.normalizedConfiguration);
      if (
        !authoritative.valid ||
        response.desiredInputHashSha256 !== hash(authoritative.canonicalInput) ||
        authoritative.canonicalInput !== checked.canonicalInput ||
        !record(response.diagnostics) ||
        !exactKeys(response.diagnostics, ["issues", "totalCount", "truncated"]) ||
        !Array.isArray(response.diagnostics.issues) ||
        response.diagnostics.issues.length !== 0 ||
        response.diagnostics.totalCount !== 0 ||
        response.diagnostics.truncated !== false
      )
        integrity();
      return { ...response, authoritative: true };
    }
    case "plan": {
      const source = await readInput(args.values.get("file") ?? "", 1024 * 1024, signal);
      const checked = checkedConfiguration(source, client.secrets);
      if (checked.normalizedInput.project.id !== client.target.projectId)
        throw new CliError(
          "validation",
          "configuration_project_mismatch",
          "Configuration project does not match the explicit target.",
        );
      const mutation = await recoverableMutation(
        client,
        `${configurationPath}/plans`,
        {
          planId,
          expectedRevision,
          configuration: checked.normalizedConfiguration,
        },
        async () => {
          const status = checkPlanRead(
            await client.request("GET", `${configurationPath}/plans/${planId}`),
            client.target,
            client.session,
            planId,
          );
          if (!status.plan)
            throw new CliError(
              "unavailable",
              "artifact_unavailable",
              "Complete plan review is unavailable.",
            );
          return status;
        },
        "plan",
        planId,
        interruption,
      );
      const status = checkPlanRead(mutation.value, client.target, client.session, planId);
      if (!status.plan)
        throw new CliError(
          "unavailable",
          "artifact_unavailable",
          "Complete plan review is unavailable.",
        );
      const plan = status.plan;
      if (
        plan.baseRevision !== expectedRevision ||
        plan.desiredInputHashSha256 !== hash(checked.canonicalInput) ||
        serializeScheduleInputV1(plan.configuration.input) !== checked.canonicalInput
      )
        integrity();
      return { ...status, recovered: mutation.recovered };
    }
    case "status":
      return checkPlanRead(
        await client.request("GET", `${configurationPath}/plans/${planId}`),
        client.target,
        client.session,
        planId,
      );
    case "receipt":
      return {
        historical: true,
        receipt: checkReceipt(
          await client.request("GET", `${configurationPath}/plans/${planId}/receipt`),
          client.target,
          planId,
        ),
      };
    case "apply":
    case "cancel": {
      const source = await readInput(args.values.get("plan") ?? "", 16 * 1024 * 1024, signal);
      const value = parseProjectConfigurationReviewJsonV1(source);
      rejectCredentials(value, client.secrets);
      const review = checkSavedReview(value, client.target, client.session, expectedRevision);
      const plan: ProjectConfigurationPlanV1 = review.plan;
      const mutation = await recoverableMutation(
        client,
        `${configurationPath}/plans/${plan.planId}/${args.command}`,
        args.command === "apply"
          ? { expectedRevision, reviewedDigest: plan.reviewedDigest }
          : { reviewedDigest: plan.reviewedDigest },
        async () =>
          checkReceipt(
            await client.request("GET", `${configurationPath}/plans/${plan.planId}/receipt`),
            client.target,
            plan.planId,
            plan,
          ),
        args.command,
        plan.planId,
        interruption,
      );
      const receipt = checkReceipt(mutation.value, client.target, plan.planId, plan);
      if (args.command === "apply" && receipt.outcome === "cancelled")
        throw new CliError(
          "conflict",
          "configuration_cancelled",
          "Plan has a recorded cancellation; no apply success is claimed.",
        );
      return { historical: true, receipt, recovered: mutation.recovered };
    }
    case "calculate":
    case "result": {
      const current = await readCurrent(client, expectedRevision);
      const getResult = async () =>
        await client.request(
          "GET",
          `${client.projectPath}/schedule/result`,
          undefined,
          32 * 1024 * 1024,
        );
      if (args.command === "result")
        return checkResult(
          await getResult(),
          current.configuration.input,
          expectedRevision,
          current.inputHashSha256,
          false,
        );
      const mutation = await recoverableMutation(
        client,
        `${client.projectPath}/schedule/run`,
        { expectedRevision },
        async () => {
          const matched = checkResult(
            await getResult(),
            current.configuration.input,
            expectedRevision,
            current.inputHashSha256,
            false,
          );
          if (!matched.result)
            throw new CliError(
              "unavailable",
              "result_unavailable",
              "No matching committed calculation is available.",
            );
          return matched;
        },
        "calculate",
        null,
        interruption,
        32 * 1024 * 1024,
      );
      return {
        ...checkResult(
          mutation.value,
          current.configuration.input,
          expectedRevision,
          current.inputHashSha256,
          true,
        ),
        recovered: mutation.recovered,
      };
    }
    default:
      return integrity();
  }
}
