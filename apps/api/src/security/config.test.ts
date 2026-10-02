import assert from "node:assert/strict";
import test from "node:test";
import { validateSecurityConfiguration } from "./config.js";

test("production authentication rejects development transport and missing or malformed origins", () => {
  const prior = {
    node: process.env.NODE_ENV,
    origin: process.env.APP_ORIGIN,
    secure: process.env.COOKIE_SECURE,
  };
  try {
    process.env.NODE_ENV = "production";
    delete process.env.APP_ORIGIN;
    delete process.env.COOKIE_SECURE;
    assert.throws(validateSecurityConfiguration, /APP_ORIGIN is required/);
    for (const origin of [
      "http://example.test",
      "https://example.test/path",
      "https://user:pass@example.test",
      "https://example.test?x=1",
      "invalid",
    ]) {
      process.env.APP_ORIGIN = origin;
      assert.throws(validateSecurityConfiguration, /APP_ORIGIN/);
    }
    process.env.APP_ORIGIN = "https://example.test";
    process.env.COOKIE_SECURE = "false";
    assert.throws(validateSecurityConfiguration, /cookies require Secure/);
    delete process.env.COOKIE_SECURE;
    assert.doesNotThrow(validateSecurityConfiguration);
    process.env.NODE_ENV = "test";
    process.env.COOKIE_SECURE = "false";
    process.env.APP_ORIGIN = "http://localhost:3000";
    assert.doesNotThrow(validateSecurityConfiguration);
  } finally {
    if (prior.node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior.node;
    if (prior.origin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = prior.origin;
    if (prior.secure === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = prior.secure;
  }
});
