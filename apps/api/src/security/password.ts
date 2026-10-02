import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

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
  const key = await scrypt(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
    maxmem: MAX_MEMORY,
  });

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
  if (encoded.split("$").length !== 6) return false;
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

  const cost = Number(costText);
  const blockSize = Number(blockText);
  const parallelization = Number(parallelText);
  if (
    !Number.isSafeInteger(cost) ||
    !Number.isSafeInteger(blockSize) ||
    !Number.isSafeInteger(parallelization) ||
    cost < 16_384 ||
    cost > 65_536 ||
    (cost & (cost - 1)) !== 0 ||
    blockSize < 1 ||
    blockSize > 16 ||
    parallelization < 1 ||
    parallelization > 4
  ) {
    return false;
  }

  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(expectedText, "base64url");
  if (expected.length !== KEY_LENGTH || salt.length < 16 || salt.length > 64) {
    return false;
  }

  try {
    const actual = await scrypt(password, salt, expected.length, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: MAX_MEMORY,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
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
