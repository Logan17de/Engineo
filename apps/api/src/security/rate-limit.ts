interface Bucket {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const current = this.buckets.get(key);

    if (!current || current.resetAt <= now) {
      this.buckets.set(key, {
        count: 1,
        resetAt: now + windowMs,
      });
      return true;
    }

    if (current.count >= limit) {
      return false;
    }

    current.count += 1;
    return true;
  }

  prune(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}
