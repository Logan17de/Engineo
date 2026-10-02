import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

const KEY_LENGTH = 64;
const COST = 32_768;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const MAX_MEMORY = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new Error("Password must be at least 12 characters.");
  }

  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
    maxmem: MAX_MEMORY,
  })) as Buffer;

  return [
    "scrypt",
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, costText, blockText, parallelText, saltText, expectedText] = encoded.split("$");

  if (
    algorithm !== "scrypt" ||
    !costText ||
    !blockText ||
    !parallelText ||
    !saltText ||
    !expectedText
  ) {
    return false;
  }

  const cost = Number.parseInt(costText, 10);
  const blockSize = Number.parseInt(blockText, 10);
  const parallelization = Number.parseInt(parallelText, 10);
  if (
    !Number.isSafeInteger(cost) ||
    !Number.isSafeInteger(blockSize) ||
    !Number.isSafeInteger(parallelization) ||
    cost < 16_384 ||
    cost > 65_536 ||
    blockSize < 1 ||
    blockSize > 16 ||
    parallelization < 1 ||
    parallelization > 4
  ) {
    return false;
  }

  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(expectedText, "base64url");
  if (expected.length !== KEY_LENGTH || salt.length < 16) {
    return false;
  }

  const actual = (await scrypt(password, salt, expected.length, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: MAX_MEMORY,
  })) as Buffer;

  return timingSafeEqual(actual, expected);
}

export async function consumePasswordWork(password: string): Promise<void> {
  const salt = Buffer.from("engineo-login-dummy-salt", "utf8");
  await scrypt(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
    maxmem: MAX_MEMORY,
  });
}
