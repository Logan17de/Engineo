import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildApp } from "./app.js";
import { createDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import {
  LOGIN_ACCOUNT_LIMIT,
  LOGIN_IP_LIMIT,
  LoginRateLimiter,
  PasswordWorkGate,
} from "./security/rate-limit.js";

test("password work is bounded and release is idempotent", () => {
  const gate = new PasswordWorkGate(2);
  const first = gate.acquire();
  const second = gate.acquire();
  assert.ok(first);
  assert.ok(second);
  assert.equal(gate.acquire(), null);
  first();
  first();
  assert.ok(gate.acquire());
  assert.equal(gate.acquire(), null);
  second();
  assert.ok(gate.acquire());
});

test("shared login throttles enforce the HTTP boundary", {
  skip: process.env.DATABASE_URL ? false : "DATABASE_URL is not configured",
}, async (t) => {
  const db = createDatabase();
  await migrateDatabase(db);
  const first = buildApp({ database: db });
  const second = buildApp({ database: db });
  try {
    await t.test(
      "atomic counters admit exactly the quota across independent limiters",
      async () => {
        await db`TRUNCATE auth_rate_limits`;
        const instances = [new LoginRateLimiter(db), new LoginRateLimiter(db)] as const;
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            (index % 2 === 0 ? instances[0] : instances[1]).consume(
              "account:parallel@example.test",
              LOGIN_ACCOUNT_LIMIT,
            ),
          ),
        );
        assert.equal(results.filter((result) => result.current <= LOGIN_ACCOUNT_LIMIT).length, 8);
        assert.equal(Math.max(...results.map((result) => result.current)), 9);
        const rows = await db`SELECT * FROM auth_rate_limits`;
        assert.equal(rows.length, 1);
        assert.match(String(rows[0]?.key_sha256), /^[a-f0-9]{64}$/);
        assert.equal(JSON.stringify(rows).includes("parallel@example.test"), false);
      },
    );

    await t.test(
      "IP quota runs before parsing and survives app restart and forged forwarding",
      async () => {
        await db`TRUNCATE auth_rate_limits`;
        for (let index = 0; index < LOGIN_IP_LIMIT; index += 1) {
          const response = await first.inject({
            method: "POST",
            url: "/auth/login",
            remoteAddress: "192.0.2.20",
            headers: {
              "x-forwarded-for": `198.51.100.${index}`,
              "content-type": "application/json",
            },
            payload: '{"email":',
          });
          assert.equal(response.statusCode, 400);
        }
        const blocked = await second.inject({
          method: "POST",
          url: "/auth/login",
          remoteAddress: "192.0.2.20",
          payload: { email: "different@example.test", password: "test-password" },
        });
        assert.equal(blocked.statusCode, 429);
        assert.equal(blocked.json().error, "too_many_attempts");
        assert.ok(Number(blocked.headers["retry-after"]) > 0);
        const sessions = await db`SELECT count(*)::int AS total FROM auth_sessions`;
        // The assertion concerns the denied request, independent of other tests' sessions.
        const before = Number(sessions[0]?.total);
        const another = await second.inject({
          method: "POST",
          url: "/auth/login",
          remoteAddress: "192.0.2.20",
          payload: { email: "another@example.test", password: "test-password" },
        });
        assert.equal(another.statusCode, 429);
        assert.equal(
          Number((await db`SELECT count(*)::int AS total FROM auth_sessions`)[0]?.total),
          before,
        );
      },
    );

    await t.test("account quota survives rotating IPs, whitespace, and case", async () => {
      await db`TRUNCATE auth_rate_limits`;
      for (let index = 0; index < LOGIN_ACCOUNT_LIMIT; index += 1) {
        const response = await first.inject({
          method: "POST",
          url: "/auth/login",
          remoteAddress: `192.0.2.${index + 30}`,
          payload: {
            email: index % 2 ? "  MISSING@example.test  " : "missing@example.test",
            password: "incorrect",
          },
        });
        assert.equal(response.statusCode, 401);
      }
      const blocked = await second.inject({
        method: "POST",
        url: "/auth/login",
        remoteAddress: "198.51.100.80",
        payload: { email: "missing@example.test", password: "incorrect" },
      });
      assert.equal(blocked.statusCode, 429);
      assert.ok(Number(blocked.headers["retry-after"]) > 0);
    });

    await t.test("IPv6 /64 and IPv4 mapped forms share source quotas", async () => {
      await db`TRUNCATE auth_rate_limits`;
      const limiter = new LoginRateLimiter(db);
      await limiter.consume("ip:2001:db8:1::", LOGIN_IP_LIMIT);
      await db`UPDATE auth_rate_limits SET attempts = ${LOGIN_IP_LIMIT}`;
      const ipv6 = await first.inject({
        method: "POST",
        url: "/auth/login",
        remoteAddress: "2001:db8:1::abcd",
        payload: { email: "ipv6@example.test", password: "incorrect" },
      });
      assert.equal(ipv6.statusCode, 429);
      await db`TRUNCATE auth_rate_limits`;
      await limiter.consume("ip:192.0.2.44", LOGIN_IP_LIMIT);
      await db`UPDATE auth_rate_limits SET attempts = ${LOGIN_IP_LIMIT}`;
      const mapped = await second.inject({
        method: "POST",
        url: "/auth/login",
        remoteAddress: "::ffff:192.0.2.44",
        payload: { email: "mapped@example.test", password: "incorrect" },
      });
      assert.equal(mapped.statusCode, 429);
    });

    await t.test(
      "stalled cleanup bounds admission and database lock waits",
      { timeout: 12_000 },
      async () => {
        const fresh = buildApp({ database: db });
        try {
          await db.begin(async (sql) => {
            await sql`LOCK TABLE auth_rate_limits IN ACCESS EXCLUSIVE MODE`;
            const started = Date.now();
            const responses = await Promise.all(
              Array.from({ length: 20 }, (_, index) =>
                fresh.inject({
                  method: "POST",
                  url: "/auth/login",
                  remoteAddress: `198.51.100.${index + 1}`,
                  payload: { email: "unavailable@example.test", password: "incorrect" },
                }),
              ),
            );
            assert.ok(Date.now() - started < 10_000);
            assert.ok(responses.every((response) => response.statusCode === 503));
            assert.ok(responses.every((response) => response.headers["set-cookie"] === undefined));
          });
          const retried = await fresh.inject({
            method: "POST",
            url: "/auth/login",
            remoteAddress: "198.51.100.100",
            payload: { email: "after-recovery@example.test", password: "incorrect" },
          });
          assert.equal(retried.statusCode, 401);
        } finally {
          await fresh.close();
        }
      },
    );

    await t.test(
      "cleanup failure is retried and never advances the successful deadline",
      async () => {
        const limiter = new LoginRateLimiter(db);
        await db`ALTER TABLE auth_rate_limits RENAME TO auth_rate_limits_offline`;
        try {
          await assert.rejects(limiter.prune());
          await assert.rejects(limiter.prune());
        } finally {
          await db`ALTER TABLE auth_rate_limits_offline RENAME TO auth_rate_limits`;
        }
        await limiter.prune();
      },
    );

    await t.test("expired windows reset and bounded cleanup keeps active buckets", async () => {
      await db`TRUNCATE auth_rate_limits`;
      const limiter = new LoginRateLimiter(db);
      await limiter.consume("expired", 1);
      await limiter.consume("active", 1);
      const digest = createHash("sha256").update("expired").digest("hex");
      await db`UPDATE auth_rate_limits SET expires_at = now() - interval '1 second' WHERE key_sha256 = ${digest}`;
      assert.equal((await limiter.consume("expired", 1)).current, 1);
      await db`UPDATE auth_rate_limits SET expires_at = now() - interval '1 second' WHERE key_sha256 = ${digest}`;
      await limiter.prune();
      assert.equal(
        Number((await db`SELECT count(*)::int AS total FROM auth_rate_limits`)[0]?.total),
        1,
      );
      assert.equal((await limiter.consume("active", 1)).current, 2);
    });

    await t.test("limiter storage failure fails closed before authentication", async () => {
      await db`ALTER TABLE auth_rate_limits RENAME TO auth_rate_limits_offline`;
      try {
        const response = await first.inject({
          method: "POST",
          url: "/auth/login",
          remoteAddress: "192.0.2.90",
          payload: { email: "missing@example.test", password: "incorrect" },
        });
        assert.equal(response.statusCode, 503);
        assert.equal(response.headers["set-cookie"], undefined);
        assert.equal(response.body.includes("auth_rate_limits"), false);
        assert.equal(response.body.includes("SELECT"), false);
      } finally {
        await db`ALTER TABLE auth_rate_limits_offline RENAME TO auth_rate_limits`;
      }
    });
  } finally {
    await first.close();
    await second.close();
    await db.end({ timeout: 5 });
  }
});
