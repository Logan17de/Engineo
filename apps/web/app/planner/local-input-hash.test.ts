import assert from "node:assert/strict";
import test from "node:test";
import { localInputHash } from "./local-input-hash";

for (const [source, expected] of [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  [
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
  ["a".repeat(1_000_000), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"],
] as const)
  test(`local SHA-256 matches known vector (${source.length} UTF-16 units)`, () =>
    assert.equal(localInputHash(source), expected));

for (const length of [
  1, 7, 31, 55, 56, 57, 63, 64, 65, 111, 119, 120, 121, 127, 128, 129, 1024, 4095, 4096, 65535,
]) {
  test(`synchronous source hash equals Web Crypto across padding boundary ${length}`, async () => {
    const source = Array.from({ length }, (_, i) => "aé零🙂\0\r\n"[i % 8] ?? "z")
      .join("")
      .toWellFormed();
    const expected = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    assert.equal(localInputHash(source), expected);
    assert.match(expected, /^[0-9a-f]{64}$/);
  });
}
test("source hash rejects malformed Unicode and nonstrings with fixed safe errors", () => {
  for (const value of [
    "PRIVATE\ud800",
    null,
    {
      toString() {
        throw new Error("private payload");
      },
    },
  ])
    assert.throws(
      () => localInputHash(value as string),
      (error) =>
        error instanceof Error && error.message === "Local source cannot be hashed safely.",
    );
});
