import { ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';

import {
    REFRESH_COOKIE,
    RateLimiter,
    allowedOrigins,
    assertTrustedOrigin,
    clearRefreshCookie,
    readRefreshCookie,
    setRefreshCookie,
} from './auth-session';

function requestWith(headers: Record<string, string>): Request {
    return { headers } as unknown as Request;
}

describe('auth-session', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.CORS_ORIGINS;
        delete process.env.REFRESH_COOKIE_SAMESITE;
        delete process.env.REFRESH_COOKIE_DOMAIN;
        delete process.env.NODE_ENV;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('allowedOrigins', () => {
        it('defaults to the local dev servers', () => {
            expect(allowedOrigins()).toEqual(['http://localhost:3000', 'http://localhost:5173']);
        });

        it('reads a comma-separated CORS_ORIGINS, ignoring spaces and blanks', () => {
            process.env.CORS_ORIGINS = ' https://corven.space, https://www.corven.space ,,';
            expect(allowedOrigins()).toEqual(['https://corven.space', 'https://www.corven.space']);
        });
    });

    describe('assertTrustedOrigin', () => {
        beforeEach(() => {
            process.env.CORS_ORIGINS = 'https://corven.space';
        });

        it('accepts requests from an allowed origin', () => {
            expect(() => assertTrustedOrigin(requestWith({ origin: 'https://corven.space' }))).not.toThrow();
        });

        it('accepts requests without an Origin header (same-origin or non-browser)', () => {
            expect(() => assertTrustedOrigin(requestWith({}))).not.toThrow();
        });

        it('rejects other sites, so they cannot use the refresh cookie', () => {
            expect(() => assertTrustedOrigin(requestWith({ origin: 'https://evil.example' }))).toThrow(
                ForbiddenException,
            );
        });

        it('does not treat a lookalike domain as allowed', () => {
            expect(() =>
                assertTrustedOrigin(requestWith({ origin: 'https://corven.space.evil.example' })),
            ).toThrow(ForbiddenException);
        });
    });

    describe('refresh cookie', () => {
        function captureCookie(action: (res: Response) => void) {
            const res = { cookie: jest.fn(), clearCookie: jest.fn() };
            action(res as unknown as Response);
            return res;
        }

        it('is httpOnly, scoped to /api/auth and Lax by default', () => {
            const expiresAt = new Date('2026-10-28T00:00:00Z');
            const res = captureCookie((r) => setRefreshCookie(r, 'token-1', expiresAt));

            expect(res.cookie).toHaveBeenCalledWith(REFRESH_COOKIE, 'token-1', {
                httpOnly: true,
                secure: false,
                sameSite: 'lax',
                path: '/api/auth',
                domain: undefined,
                expires: expiresAt,
            });
        });

        it('is Secure in production', () => {
            process.env.NODE_ENV = 'production';
            const res = captureCookie((r) => setRefreshCookie(r, 't', new Date()));

            expect(res.cookie.mock.calls[0][2]).toMatchObject({ secure: true, sameSite: 'lax' });
        });

        it('is SameSite=None and always Secure when the frontend is on another site', () => {
            process.env.REFRESH_COOKIE_SAMESITE = 'None';
            const res = captureCookie((r) => setRefreshCookie(r, 't', new Date()));

            expect(res.cookie.mock.calls[0][2]).toMatchObject({ secure: true, sameSite: 'none' });
        });

        it('is cleared with the same attributes it was set with', () => {
            process.env.REFRESH_COOKIE_SAMESITE = 'none';
            process.env.REFRESH_COOKIE_DOMAIN = '.corven.space';
            const res = captureCookie((r) => clearRefreshCookie(r));

            expect(res.clearCookie).toHaveBeenCalledWith(REFRESH_COOKIE, {
                httpOnly: true,
                secure: true,
                sameSite: 'none',
                path: '/api/auth',
                domain: '.corven.space',
            });
        });
    });

    describe('readRefreshCookie', () => {
        it('finds the refresh cookie among others', () => {
            const req = requestWith({ cookie: `theme=dark; ${REFRESH_COOKIE}=abc%3D123; other=1` });
            expect(readRefreshCookie(req)).toBe('abc=123');
        });

        it('returns undefined without cookies or without the refresh cookie', () => {
            expect(readRefreshCookie(requestWith({}))).toBeUndefined();
            expect(readRefreshCookie(requestWith({ cookie: 'theme=dark' }))).toBeUndefined();
        });

        it('does not match a cookie whose name only ends with the refresh cookie name', () => {
            const req = requestWith({ cookie: `x${REFRESH_COOKIE}=stolen` });
            expect(readRefreshCookie(req)).toBeUndefined();
        });

        it('returns undefined for a malformed value instead of throwing', () => {
            const req = requestWith({ cookie: `${REFRESH_COOKIE}=%E0%A4%A` });
            expect(readRefreshCookie(req)).toBeUndefined();
        });
    });

    describe('RateLimiter', () => {
        afterEach(() => {
            jest.useRealTimers();
        });

        function expectTooManyRequests(action: () => void) {
            try {
                action();
            } catch (error) {
                expect(error).toBeInstanceOf(HttpException);
                expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
                return;
            }
            throw new Error('expected a 429');
        }

        it('allows up to the limit, then answers 429', () => {
            const limiter = new RateLimiter(3, 60_000);

            limiter.consume('1.2.3.4');
            limiter.consume('1.2.3.4');
            limiter.consume('1.2.3.4');

            expectTooManyRequests(() => limiter.consume('1.2.3.4'));
        });

        it('counts each key separately', () => {
            const limiter = new RateLimiter(1, 60_000);

            limiter.consume('1.2.3.4');
            expect(() => limiter.consume('5.6.7.8')).not.toThrow();
        });

        it('starts a new window after the old one ends', () => {
            jest.useFakeTimers();
            const limiter = new RateLimiter(1, 60_000);

            limiter.consume('1.2.3.4');
            expectTooManyRequests(() => limiter.consume('1.2.3.4'));

            jest.advanceTimersByTime(60_001);
            expect(() => limiter.consume('1.2.3.4')).not.toThrow();
        });
    });
});
