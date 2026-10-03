import { createHash } from "node:crypto";
import type { FastifyRateLimitStore } from "@fastify/rate-limit";
import type { Database } from "../db/client.js";

export const LOGIN_WINDOW_MS = 5 * 60 * 1000;
export const LOGIN_IP_LIMIT = 60;
export const LOGIN_ACCOUNT_LIMIT = 8;

interface BucketResult {
  current: number;
  ttl: number;
}

// SQL's atomic UPSERT serializes concurrent attempts across API replicas. Keys
// contain only one-way digests; email addresses and IPs never enter this table.
export class LoginRateLimiter {
  private nextPruneAt = 0;
  private cleanup: Promise<void> | null = null;
  private readonly databaseGate = new PasswordWorkGate(16);

  constructor(private readonly db: Database) {}

  async consume(key: string, max: number, windowMs = LOGIN_WINDOW_MS): Promise<BucketResult> {
    const release = this.databaseGate.acquire();
    if (!release) throw new Error("Login limiter is busy");
    try {
      const digest = createHash("sha256").update(key).digest("hex");
      const rows = await this.db`
      INSERT INTO auth_rate_limits (key_sha256, attempts, expires_at)
      VALUES (${digest}, 1, statement_timestamp() + ${windowMs} * interval '1 millisecond')
      ON CONFLICT (key_sha256) DO UPDATE SET
        attempts = CASE
          WHEN auth_rate_limits.expires_at <= statement_timestamp() THEN 1
          ELSE LEAST(auth_rate_limits.attempts + 1, ${max + 1})
        END,
        expires_at = CASE
          WHEN auth_rate_limits.expires_at <= statement_timestamp()
            THEN statement_timestamp() + ${windowMs} * interval '1 millisecond'
          ELSE auth_rate_limits.expires_at
        END
      RETURNING attempts,
        GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - statement_timestamp())) * 1000)) AS ttl
    `;
      const row = rows[0];
      if (!row) {
        throw new Error("Login limit could not be checked");
      }
      return { current: Number(row.attempts), ttl: Number(row.ttl) };
    } finally {
      release();
    }
  }

  async prune(): Promise<void> {
    const release = this.databaseGate.acquire();
    if (!release) throw new Error("Login limiter is busy");
    try {
      if (Date.now() < this.nextPruneAt) {
        return;
      }
      // Bounded cleanup uses an expiry index; traffic never walks all buckets.
      if (!this.cleanup) {
        this.cleanup = this.db`
      DELETE FROM auth_rate_limits WHERE key_sha256 IN (
        SELECT key_sha256 FROM auth_rate_limits
        WHERE expires_at <= statement_timestamp()
        ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED
      )
    `
          .then(() => {
            this.nextPruneAt = Date.now() + 60_000;
          })
          .finally(() => {
            this.cleanup = null;
          });
      }
      await this.cleanup;
    } finally {
      release();
    }
  }
}

export function loginRateLimitStore(limiter: LoginRateLimiter) {
  return class implements FastifyRateLimitStore {
    incr(
      key: string,
      callback: (error: Error | null, result?: BucketResult) => void,
      timeWindow: number,
      max: number,
    ): void {
      void limiter
        .prune()
        .then(() => limiter.consume(`ip:${key}`, max, timeWindow))
        .then(
          (result) => callback(null, result),
          () =>
            callback(
              Object.assign(new Error("Login temporarily unavailable"), { statusCode: 503 }),
            ),
        );
    }

    child(): FastifyRateLimitStore {
      return this;
    }
  };
}

export class PasswordWorkGate {
  private active = 0;

  constructor(private readonly maximum = 4) {}

  acquire(): (() => void) | null {
    if (this.active >= this.maximum) {
      return null;
    }
    this.active += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active -= 1;
      }
    };
  }
}
