import { constants, createReadStream, fstatSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { Socket } from "node:net";
import type { Readable } from "node:stream";
import { CliError } from "./errors.js";

export async function readInput(
  path: string,
  maxBytes: number,
  signal: AbortSignal,
  privateFile = false,
  preserveBom = false,
): Promise<string> {
  if (path === "-") {
    if (privateFile)
      throw new CliError(
        "usage",
        "invalid_auth_source",
        "Use a private file or an explicit descriptor above stderr for session material.",
      );
    return await readDescriptor(0, maxBytes, signal, preserveBom);
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // Opening a FIFO in blocking mode would wait for a writer before fstat can
    // reject it. Nonblocking open keeps even invalid file sources bounded.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new CliError("usage", "input_unavailable", "Input file could not be opened safely.");
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > maxBytes ||
      (privateFile && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
      throw new CliError(
        "validation",
        "invalid_input_file",
        "Input must be a bounded regular file; session files must be private and owned by the current user.",
      );
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > maxBytes)
        throw new CliError(
          "validation",
          "input_too_large",
          "Input exceeds the documented byte limit.",
        );
      chunks.push(bytes);
    }
    return decode(Buffer.concat(chunks), preserveBom);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (signal.aborted)
      throw new CliError(
        "interrupted",
        "input_interrupted",
        "Input was interrupted or exceeded the command deadline.",
      );
    throw new CliError("usage", "input_unavailable", "Input file could not be read safely.");
  } finally {
    await handle.close();
  }
}
export async function readDescriptor(
  fd: number,
  maxBytes: number,
  signal: AbortSignal,
  preserveBom = false,
): Promise<string> {
  let stream: Readable;
  try {
    const stat = fstatSync(fd);
    if (stat.isFile()) {
      if (stat.size > maxBytes)
        throw new CliError(
          "validation",
          "input_too_large",
          "Input exceeds the documented byte limit.",
        );
      stream = createReadStream("", { fd, autoClose: false, signal });
    } else if (stat.isFIFO() || stat.isSocket()) {
      // uv pipe/socket polling is nonblocking. A thread-pool fs read of an
      // inherited pipe can hang even process.exit while libuv joins workers.
      stream = new Socket({ fd, readable: true, writable: false });
    } else
      throw new CliError(
        "usage",
        "invalid_input_descriptor",
        "Input descriptor must be a regular file or an explicit pipe/socket.",
      );
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "usage",
      "input_unavailable",
      "Input descriptor could not be opened safely.",
    );
  }
  // An already-aborted signal can emit before an iterator is attached. Errors
  // are reported only through the authored envelope, never as event dumps.
  stream.on("error", () => {});
  const interrupted = () =>
    new CliError(
      signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
        ? "transport"
        : "interrupted",
      signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
        ? "input_timeout"
        : "input_interrupted",
      "Input was interrupted or exceeded the command deadline.",
    );
  let onAbort: (() => void) | undefined;
  try {
    // Settle independently of stream teardown and keep authored errors bounded.
    return await new Promise<string>((resolve, reject) => {
      onAbort = () => {
        stream.destroy();
        reject(interrupted());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      void (async () => {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of stream) {
          const bytes = Buffer.from(chunk);
          length += bytes.length;
          if (length > maxBytes)
            throw new CliError(
              "validation",
              "input_too_large",
              "Input exceeds the documented byte limit.",
            );
          chunks.push(bytes);
        }
        resolve(decode(Buffer.concat(chunks), preserveBom));
      })().catch(reject);
    });
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (signal.aborted) throw interrupted();
    throw new CliError("usage", "input_unavailable", "Input descriptor could not be read safely.");
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
function decode(bytes: Buffer, preserveBom = false): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: preserveBom }).decode(bytes);
  } catch {
    throw new CliError("validation", "invalid_utf8", "Input must use valid UTF-8.");
  }
}

/** Reserve before network mutations. A failed/incomplete plan never leaves an applyable artifact. */
export async function reserveOutput(path: string): Promise<{
  save: (value: unknown) => Promise<void>;
  discard: () => Promise<void>;
}> {
  if (path === "-")
    throw new CliError("usage", "invalid_output", "Saved output needs a new file path.");
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw new CliError(
      "usage",
      "output_unavailable",
      "Output must be a new writable file; existing files are never overwritten.",
    );
  }
  let closed = false;
  return {
    async save(value) {
      const serialized = `${JSON.stringify(value, null, 2)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > 16 * 1024 * 1024)
        throw new CliError(
          "validation",
          "output_too_large",
          "Complete saved output exceeds the 16 MiB bound; no truncated artifact was written.",
        );
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
        await handle.close();
        closed = true;
      } catch {
        throw new CliError(
          "unavailable",
          "output_write_failed",
          "Could not save complete output. Mutation outcome may already be recorded; query the same identity.",
        );
      }
    },
    async discard() {
      if (!closed) {
        await handle.close().catch(() => {});
        await unlink(path).catch(() => {});
        closed = true;
      }
    },
  };
}
