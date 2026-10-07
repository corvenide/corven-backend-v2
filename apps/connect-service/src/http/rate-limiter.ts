// apps/connect-service/src/http/rate-limiter.ts
//
// Fixed-window, in-memory limiter. Fine for one connect-service instance;
// move to Redis if it ever runs on several.

import { fail } from './errors';

export class RateLimiter {
    private readonly hits = new Map<string, { count: number; resetAt: number }>();

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
        private readonly message = 'Too many attempts. Please wait a few minutes and try again.',
    ) { }

    consume(key: string): void {
        const now = Date.now();
        const entry = this.hits.get(key);

        if (!entry || entry.resetAt <= now) {
            this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
            if (this.hits.size > 20_000) this.sweep(now);
            return;
        }

        entry.count += 1;
        if (entry.count > this.limit) throw fail(429, this.message, 'rate_limited');
    }

    reset(key: string): void {
        this.hits.delete(key);
    }

    private sweep(now: number): void {
        for (const [key, entry] of this.hits) {
            if (entry.resetAt <= now) this.hits.delete(key);
        }
    }
}
