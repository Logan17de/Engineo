import { CliError } from "./errors.js";

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
export function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  );
}
export function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function sha256Text(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Strict duplicate-aware JSON for auth/review/response envelopes, with bounded depth. */
export function parseJson(source: string, maxBytes: number): unknown {
  const invalid = (): never => {
    throw new CliError(
      "validation",
      "invalid_json",
      "Input must be bounded, duplicate-free UTF-8 JSON.",
    );
  };
  if (Buffer.byteLength(source, "utf8") > maxBytes || !source.isWellFormed()) invalid();
  let offset = 0;
  const whitespace = () => {
    while (/[\t\r\n ]/.test(source[offset] ?? "!")) offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < source.length) {
      const character = source[offset++];
      if (character === "\\") offset++;
      else if (character === '"') {
        try {
          const value: unknown = JSON.parse(source.slice(start, offset));
          if (typeof value !== "string" || !value.isWellFormed()) invalid();
          return value as string;
        } catch {
          invalid();
        }
      }
    }
    return invalid();
  };
  const value = (depth: number): unknown => {
    if (depth > 64) invalid();
    whitespace();
    if (source[offset] === '"') return string();
    if (source[offset] === "{") {
      offset++;
      whitespace();
      const entries: Array<[string, unknown]> = [],
        keys = new Set<string>();
      if (source[offset] === "}") {
        offset++;
        return {};
      }
      while (offset < source.length) {
        if (source[offset] !== '"') invalid();
        const key = string();
        if (keys.has(key)) invalid();
        keys.add(key);
        whitespace();
        if (source[offset++] !== ":") invalid();
        entries.push([key, value(depth + 1)]);
        whitespace();
        if (source[offset] === "}") {
          offset++;
          return Object.fromEntries(entries);
        }
        if (source[offset++] !== ",") invalid();
        whitespace();
      }
      return invalid();
    }
    if (source[offset] === "[") {
      offset++;
      whitespace();
      const entries: unknown[] = [];
      if (source[offset] === "]") {
        offset++;
        return entries;
      }
      while (offset < source.length) {
        entries.push(value(depth + 1));
        whitespace();
        if (source[offset] === "]") {
          offset++;
          return entries;
        }
        if (source[offset++] !== ",") invalid();
      }
      return invalid();
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      source.slice(offset),
    )?.[0];
    if (!token) return invalid();
    offset += token.length;
    const parsed: unknown = JSON.parse(token);
    if (typeof parsed === "number") {
      const [mantissa = "", exponent = "0"] = token.replace(/^-/, "").toLowerCase().split("e");
      const [whole = "", fraction = ""] = mantissa.split(".");
      const digits = `${whole}${fraction}`;
      const decimalPlaces = fraction.length - Number(exponent);
      if (
        !Number.isSafeInteger(parsed) ||
        (!/^0+$/.test(digits) &&
          decimalPlaces > 0 &&
          (decimalPlaces > digits.length || !/^0+$/.test(digits.slice(-decimalPlaces))))
      )
        invalid();
    }
    return parsed;
  };
  const result = value(0);
  whitespace();
  if (offset !== source.length) invalid();
  return result;
}

const credentialKey =
  /^(?:password|passwd|cookie|cookies|authorization|credentials?|csrf(?:token)?|sessiontoken|accesstoken|refreshtoken|apikey|secret|clientsecret|privatekey)$/i;
export function rejectCredentials(
  value: unknown,
  secrets: readonly string[] = [],
  depth = 0,
): void {
  if (depth > 64)
    throw new CliError("validation", "input_too_deep", "Input exceeds the documented depth limit.");
  if (typeof value === "string") {
    if (
      secrets.some((secret) => secret.length > 0 && value.includes(secret)) ||
      /(?:engineo_session|engineo_csrf)\s*=|\bBearer\s+[A-Za-z0-9._~+/-]+/i.test(value)
    )
      throw new CliError(
        "validation",
        "credentials_in_artifact",
        "Credentials must stay outside configuration and review artifacts.",
      );
  } else if (Array.isArray(value)) {
    for (const entry of value) rejectCredentials(entry, secrets, depth + 1);
  } else if (record(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (credentialKey.test(key.replace(/[-_]/g, "")))
        throw new CliError(
          "validation",
          "credentials_in_artifact",
          "Credentials must stay outside configuration and review artifacts.",
        );
      rejectCredentials(key, secrets, depth + 1);
      rejectCredentials(entry, secrets, depth + 1);
    }
  }
}
