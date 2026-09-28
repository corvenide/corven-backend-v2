// apps/api-gateway/src/auth-session.ts
//
// HTTP-side session helpers for the gateway: the refresh-token cookie,
// allowed origins, and a small per-IP rate limiter for auth routes.

import {
    ForbiddenException,
    HttpException,
    HttpStatus,
} from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';

export const REFRESH_COOKIE = 'corven_rt';

export function allowedOrigins(): string[] {
    return (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
}

/**
 * Refresh/logout rely on a cookie, so a cross-site page could try to
 * trigger them. Browsers always send Origin on cross-origin POSTs; reject
 * any origin that isn't ours.
 */
export function assertTrustedOrigin(req: Request): void {
    const origin = req.headers.origin;

    if (origin && !allowedOrigins().includes(origin)) {
        throw new ForbiddenException('Origin not allowed');
    }
}

function cookieOptions(): CookieOptions {
    // Use SameSite=None when the frontend and API are on different sites
    // (e.g. Vercel + Lightsail). That requires Secure, i.e. HTTPS.
    const sameSite = (process.env.REFRESH_COOKIE_SAMESITE || 'lax').toLowerCase() as
        | 'lax'
        | 'strict'
        | 'none';

    return {
        httpOnly: true,
        secure: sameSite === 'none' || process.env.NODE_ENV === 'production',
        sameSite,
        path: '/api/auth',
        domain: process.env.REFRESH_COOKIE_DOMAIN || undefined,
    };
}

export function setRefreshCookie(res: Response, token: string, expiresAt: Date | string): void {
    res.cookie(REFRESH_COOKIE, token, {
        ...cookieOptions(),
        expires: new Date(expiresAt),
    });
}

export function clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, cookieOptions());
}

export function readRefreshCookie(req: Request): string | undefined {
    const header = req.headers.cookie;

    if (!header) return undefined;

    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index === -1) continue;

        const name = part.slice(0, index).trim();

        if (name === REFRESH_COOKIE) {
            try {
                return decodeURIComponent(part.slice(index + 1).trim());
            } catch {
                return undefined;
            }
        }
    }

    return undefined;
}

export function sessionMeta(req: Request) {
    return {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip,
    };
}

/**
 * Fixed-window, in-memory limiter. Fine for a single gateway instance;
 * move it to Redis once the gateway runs on more than one node.
 */
export class RateLimiter {
    private readonly hits = new Map<string, { count: number; resetAt: number }>();

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
    ) { }

    consume(key: string): void {
        const now = Date.now();
        const entry = this.hits.get(key);

        if (!entry || entry.resetAt <= now) {
            this.hits.set(key, { count: 1, resetAt: now + this.windowMs });

            if (this.hits.size > 10_000) this.sweep(now);
            return;
        }

        entry.count += 1;

        if (entry.count > this.limit) {
            throw new HttpException(
                'Too many attempts. Please wait a minute and try again.',
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }
    }

    private sweep(now: number): void {
        for (const [key, entry] of this.hits) {
            if (entry.resetAt <= now) this.hits.delete(key);
        }
    }
}
