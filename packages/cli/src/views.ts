import {
  PLANNER_VIEW_MAX_BYTES,
  PLANNER_VIEW_MAX_OPERATION_BYTES,
  PLANNER_VIEW_MAX_RECEIPT_BYTES,
  type PlannerViewPlanRequestV1,
  type PlannerViewPlanV1,
  parsePlannerViewOperationsJsonV1,
  validatePlannerViewPlanRequestV1,
} from "@engineo/contracts";
import { destination } from "./arguments.js";
import { CliError, EXIT, integrity } from "./errors.js";
import { readInput, reserveOutput } from "./files.js";
import { parseViewJson, record, rejectCredentials } from "./json.js";
import type { CliOutputV1 } from "./run.js";
import { AmbiguousTransport, ApiClient, loadSession } from "./transport.js";
import { type ViewArguments, VIEW_HELP, parseViewArguments } from "./view-arguments.js";
import {
  checkSavedViewReview,
  checkViewCapabilities,
  checkViewList,
  checkViewOperationStatus,
  checkViewPlan,
  checkViewProjection,
  checkViewRead,
  checkViewReceipt,
  checkViewValidation,
  checkedViewConfiguration,
  savedViewReview,
} from "./view-artifacts.js";

const PROJECTION_MAX_BYTES = 4 * 1024 * 1024;
const responsePolicy = {
  parseResponse: parseViewJson,
  maxRequestBytes: PLANNER_VIEW_MAX_OPERATION_BYTES,
  preserveBom: true,
  requireNoStore: true,
  exactJsonMediaType: true,
};
function viewRequest(
  client: ApiClient,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  maxBytes = PLANNER_VIEW_MAX_OPERATION_BYTES,
): Promise<unknown> {
  return client.request(method, path, body, maxBytes, responsePolicy);
}
function success(command: string, data: unknown): CliOutputV1 {
  return { schemaVersion: 1, kind: "engineo-cli-output", command, ok: true, exitCode: 0, data };
}
function unknownApply(plan: PlannerViewPlanV1, interrupted: boolean): CliError {
  return new CliError(
    interrupted ? "interrupted" : "uncertain",
    interrupted ? "view_mutation_interrupted" : "view_mutation_outcome_unknown",
    "View mutation outcome is unknown. Query the original operation window and UUID; interruption is not cancellation.",
    {
      action: plan.review.action,
      operationWindowId: plan.review.operationWindowId,
      operationId: plan.review.operationId,
      outcomeKnown: false,
    },
  );
}

/** Application CLI only. Shared digests bind intent; the live API remains the authority. */
export async function runViewsCli(
  argv: readonly string[],
  interruption = new AbortController().signal,
): Promise<CliOutputV1> {
  let command = "views unknown";
  let secrets: readonly string[] = [];
  try {
    const args = parseViewArguments(argv);
    command = `views ${args.command}`;
    if (args.command === "help") return success(command, VIEW_HELP);
    const deadline = Date.now() + Number(args.remote.values.get("timeout-ms") ?? 30000);
    const signal = AbortSignal.any([
      interruption,
      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    ]);
    if (args.remote.flags.has("offline")) {
      const checked = checkedViewConfiguration(
        await readInput(
          args.remote.values.get("file") ?? "",
          PLANNER_VIEW_MAX_BYTES,
          signal,
          false,
          true,
        ),
      );
      return success(command, {
        schemaVersion: 1,
        valid: true,
        normalizedConfiguration: checked.configuration,
        configHashSha256: checked.configHashSha256,
        diagnostics: checked.diagnostics,
        authoritative: false,
        calculationChecked: false,
      });
    }
    const target = destination(args.remote);
    const session = await loadSession(args.remote, signal);
    secrets = [session.sessionToken, session.csrfToken];
    const client = new ApiClient(target, session, deadline, interruption);
    await client.verifyIdentity();
    const output = args.remote.values.has("out")
      ? await reserveOutput(args.remote.values.get("out") ?? "", true)
      : undefined;
    try {
      const data = await executeViews(args, client, signal, interruption, deadline);
      rejectCredentials(data, secrets);
      if (output) {
        const fileData =
          args.command === "plan"
            ? savedViewReview(data as PlannerViewPlanV1, target)
            : args.command === "read" && record(data)
              ? data.configuration
              : args.command === "project" || args.command === "select"
                ? data
                : undefined;
        const maxBytes =
          args.command === "read"
            ? PLANNER_VIEW_MAX_BYTES
            : args.command === "plan"
              ? PLANNER_VIEW_MAX_OPERATION_BYTES
              : PROJECTION_MAX_BYTES;
        if (fileData === undefined) integrity();
        if (Buffer.byteLength(`${JSON.stringify(fileData, null, 2)}\n`, "utf8") > maxBytes)
          throw new CliError(
            "validation",
            "view_output_too_large",
            "Complete private-view artifact exceeds its byte bound; no truncated file was written.",
          );
        await output.save(fileData);
      }
      return success(command, data);
    } finally {
      await output?.discard();
    }
  } catch (error) {
    const failure =
      error instanceof CliError
        ? error instanceof AmbiguousTransport && interruption.aborted
          ? new CliError(
              "interrupted",
              "command_interrupted",
              "Command was interrupted before a view mutation was sent.",
            )
          : error
        : new CliError(
            "unavailable",
            "view_command_failed",
            "Private-view command failed without exposing underlying exception details.",
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
    try {
      rejectCredentials(output, secrets);
      return output;
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
  }
}

async function savedPlan(
  args: ViewArguments,
  client: ApiClient,
  signal: AbortSignal,
  historical = false,
): Promise<PlannerViewPlanV1> {
  let value: unknown;
  try {
    value = parsePlannerViewOperationsJsonV1(
      await readInput(
        args.remote.values.get("review") ?? "",
        PLANNER_VIEW_MAX_OPERATION_BYTES,
        signal,
        false,
        true,
      ),
    );
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "validation",
      "view_review_invalid",
      "Saved view review must be bounded, duplicate-free versioned JSON.",
    );
  }
  rejectCredentials(value, client.secrets);
  return checkSavedViewReview(
    value,
    client.target,
    client.session,
    historical ? undefined : Number(args.remote.values.get("expected-schedule-revision")),
    historical,
  ).plan;
}

async function applyView(
  plan: PlannerViewPlanV1,
  client: ApiClient,
  interruption: AbortSignal,
  deadline: number,
): Promise<unknown> {
  const path = `${client.projectPath}/views`;
  const window = plan.review.operationWindowId;
  const operationId = plan.review.operationId;
  if (interruption.aborted || Date.now() >= deadline)
    throw new CliError(
      interruption.aborted ? "interrupted" : "transport",
      interruption.aborted ? "command_interrupted" : "command_timeout",
      "Command ended before a view mutation was sent.",
    );
  try {
    const receipt = checkViewReceipt(
      await viewRequest(client, "POST", `${path}/apply`, plan, PLANNER_VIEW_MAX_RECEIPT_BYTES),
      client.target,
      client.session,
      window,
      operationId,
      plan,
    );
    return { historical: true, receipt, recovered: false };
  } catch (error) {
    // A 2xx response can be lost or unusable after commit. Header/body/receipt
    // integrity failures, redirects and 5xx responses therefore require the
    // same original-key status query, never another mutation or a fresh key.
    const httpStatus =
      error instanceof CliError && record(error.details) ? error.details.httpStatus : undefined;
    if (
      error instanceof CliError &&
      (error.code === "request_too_large" ||
        (typeof httpStatus === "number" && httpStatus >= 400 && httpStatus < 500))
    )
      throw error;
    if (interruption.aborted) throw unknownApply(plan, true);
    let status: ReturnType<typeof checkViewOperationStatus>;
    try {
      status = checkViewOperationStatus(
        await viewRequest(client, "GET", `${path}/operations/${window}/${operationId}`),
        client.target,
        client.session,
        window,
        operationId,
        plan,
      );
    } catch (recoveryError) {
      if (interruption.aborted) throw unknownApply(plan, true);
      if (recoveryError instanceof CliError && !(recoveryError instanceof AmbiguousTransport))
        throw new CliError(
          recoveryError.category,
          recoveryError.code,
          "Recovery query was rejected; the original view mutation outcome remains unknown.",
          { operationWindowId: window, operationId, outcomeKnown: false },
        );
      throw unknownApply(plan, interruption.aborted);
    }
    if (status.receipt) return { historical: true, receipt: status.receipt, recovered: true };
    if (status.absenceDefinitive)
      throw new CliError(
        "conflict",
        "view_operation_not_recorded",
        "The operation window closed with no recorded mutation for the original identity.",
        { operationWindowId: window, operationId, outcomeKnown: true },
      );
    throw unknownApply(plan, interruption.aborted);
  }
}

async function executeViews(
  args: ViewArguments,
  client: ApiClient,
  signal: AbortSignal,
  interruption: AbortSignal,
  deadline: number,
): Promise<unknown> {
  const values = args.remote.values;
  const path = `${client.projectPath}/views`;
  const viewId = values.get("view-id") ?? "";
  const expectedScheduleRevision = Number(values.get("expected-schedule-revision"));
  switch (args.command) {
    case "capabilities":
      return checkViewCapabilities(await viewRequest(client, "GET", `${path}/capabilities`));
    case "list": {
      const limit = Number(values.get("limit") ?? 50);
      const cursor = values.get("cursor");
      return checkViewList(
        await viewRequest(
          client,
          "GET",
          `${path}?limit=${limit}${cursor === undefined ? "" : `&cursor=${cursor}`}`,
        ),
        limit,
        cursor,
      );
    }
    case "read":
      return checkViewRead(await viewRequest(client, "GET", `${path}/${viewId}`), viewId);
    case "validate": {
      const checked = checkedViewConfiguration(
        await readInput(values.get("file") ?? "", PLANNER_VIEW_MAX_BYTES, signal, false, true),
        client.secrets,
      );
      return {
        ...checkViewValidation(
          await viewRequest(client, "POST", `${path}/validate`, {
            configuration: checked.configuration,
          }),
          checked,
        ),
        authoritative: true,
      };
    }
    case "plan": {
      const capabilities = checkViewCapabilities(
        await viewRequest(client, "GET", `${path}/capabilities`),
      );
      const operationWindowId = values.get("operation-window") ?? "";
      if (operationWindowId !== capabilities.operationWindowId)
        throw new CliError(
          "conflict",
          "view_operation_window_closed",
          "The explicit operation window is not the server's current open window.",
        );
      const action = values.get("action");
      const common = {
        operationWindowId,
        operationId: values.get("operation-id") ?? "",
        expectedScheduleRevision,
      };
      const base =
        action === "create"
          ? undefined
          : checkViewRead(await viewRequest(client, "GET", `${path}/${viewId}`), viewId);
      const expectedViewRevision = Number(values.get("expected-view-revision"));
      if (base && base.viewRevision !== expectedViewRevision)
        throw new CliError(
          "conflict",
          "view_base_changed",
          "View revision differs from the explicit expected revision.",
        );
      const checked =
        action === "delete"
          ? undefined
          : checkedViewConfiguration(
              await readInput(
                values.get("file") ?? "",
                PLANNER_VIEW_MAX_BYTES,
                signal,
                false,
                true,
              ),
              client.secrets,
            );
      const request = validatePlannerViewPlanRequestV1(
        action === "create" && checked
          ? { action, ...common, configuration: checked.configuration }
          : action === "update" && checked
            ? {
                action,
                ...common,
                viewId,
                expectedViewRevision,
                configuration: checked.configuration,
              }
            : { action: "delete", ...common, viewId, expectedViewRevision },
      );
      if (!request.valid) integrity();
      return checkViewPlan(
        await viewRequest(client, "POST", `${path}/plan`, request.value),
        client.target,
        client.session,
        request.value as PlannerViewPlanRequestV1,
        base,
      );
    }
    case "apply":
      return applyView(await savedPlan(args, client, signal), client, interruption, deadline);
    case "status": {
      const window = values.get("operation-window") ?? "";
      const operationId = values.get("operation-id") ?? "";
      const plan = values.has("review") ? await savedPlan(args, client, signal, true) : undefined;
      if (
        plan &&
        (plan.review.operationWindowId !== window || plan.review.operationId !== operationId)
      )
        throw new CliError(
          "conflict",
          "view_operation_identity_mismatch",
          "Saved review does not match the explicit operation window and UUID.",
        );
      return {
        historical: true,
        ...checkViewOperationStatus(
          await viewRequest(client, "GET", `${path}/operations/${window}/${operationId}`),
          client.target,
          client.session,
          window,
          operationId,
          plan,
        ),
      };
    }
    case "project":
    case "select": {
      const configuration = values.has("view-id")
        ? checkViewRead(await viewRequest(client, "GET", `${path}/${viewId}`), viewId).configuration
        : checkedViewConfiguration(
            await readInput(values.get("file") ?? "", PLANNER_VIEW_MAX_BYTES, signal, false, true),
            client.secrets,
          ).configuration;
      const response = values.has("view-id")
        ? await viewRequest(
            client,
            "GET",
            `${path}/${viewId}/projection`,
            undefined,
            PROJECTION_MAX_BYTES,
          )
        : await viewRequest(
            client,
            "POST",
            `${path}/projection`,
            { configuration, expectedScheduleRevision },
            PROJECTION_MAX_BYTES,
          );
      return checkViewProjection(response, client.target, configuration, expectedScheduleRevision);
    }
    default:
      return integrity();
  }
}
