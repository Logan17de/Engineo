#!/usr/bin/env node
import { runCli } from "./run.js";

const interruption = new AbortController();
const stop = () => interruption.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const output = await runCli(process.argv.slice(2), interruption.signal);
process.off("SIGINT", stop);
process.off("SIGTERM", stop);
// One bounded machine-readable envelope. No credentials, logs or exception dumps on either stream.
process.stdout.once("error", () => process.exit(8));
// Flush before exit. This CLI owns no background work after its envelope.
process.stdout.write(`${JSON.stringify(output)}\n`, () => process.exit(output.exitCode));
