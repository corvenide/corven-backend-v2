// apps/connect-service/src/auth/tokens.service.ts
//
// Connect sessions:
//   access token   JWT, 15 minutes, audience = app id, sent as a bearer token
//   refresh token  random, stored hashed, 30 days, rotated on every use;
//                  reusing a rotated token revokes the whole family
//   step-up token  JWT, 5 minutes, single use; proves the user just
//                  re-verified (needed for mainnet signing and key export)
//   challenge      JWT carrying a WebAuthn challenge between the options
//                  call and the verify call, single use
//
// All JWTs are signed with CONNECT_JWT_SECRET and carry a `typ`, so one
// kind can never be used as another.

import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { PrismaService } from '@app/prisma';

import { ACCESS_TOKEN_TTL_S, CHALLENGE_TTL_S, REFRESH_TOKEN_TTL_DAYS, STEP_UP_TTL_S } from '../config';
import type { ConnectRequestContext } from '../http/app.guard';
import { fail } from '../http/errors';

export type StepUpPurpose = 'sign' | 'export';
export type ChallengePurpose = 'register' | 'login' | 'step-up';

export interface SessionTokens {
    accessToken: string;
    accessTokenExpiresAt: string;
    refreshToken: string;
    refreshTokenExpiresAt: string;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class TokensService {
    /** jti of single-use tokens already spent, until they expire. */
    private readonly spent = new Map<string, number>();

    constructor(
        private readonly jwt: JwtService,
        private readonly prisma: PrismaService,
    ) { }

    // ---------------------------------------------------------------- sessions

    async issueSession(userId: string, ctx: ConnectRequestContext, familyId: string = randomUUID()): Promise<SessionTokens & { id: string }> {
        const refreshToken = `crt_${randomBytes(32).toString('base64url')}`;
        const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000);

        const row = await this.prisma.connectSession.create({
            data: {
                userId,
                tokenHash: hash(refreshToken),
                familyId,
                expiresAt,
                userAgent: ctx.userAgent,
                ipAddress: ctx.ip,
                origin: ctx.origin,
            },
        });

        return {
            id: row.id,
            ...this.accessToken(userId, ctx.app.id),
            refreshToken,
            refreshTokenExpiresAt: expiresAt.toISOString(),
        };
    }

    async rotate(refreshToken: unknown, ctx: ConnectRequestContext): Promise<{ userId: string; tokens: SessionTokens }> {
        if (typeof refreshToken !== 'string' || !refreshToken.startsWith('crt_')) {
            throw fail(401, 'Your session has ended. Please sign in again.', 'session_expired');
        }

        const row = await this.prisma.connectSession.findUnique({
            where: { tokenHash: hash(refreshToken) },
            include: { user: { select: { appId: true } } },
        });

        if (!row || row.user.appId !== ctx.app.id || row.expiresAt <= new Date()) {
            throw fail(401, 'Your session has ended. Please sign in again.', 'session_expired');
        }

        if (row.revokedAt) {
            // A rotated token came back: someone else may hold this session.
            await this.prisma.connectSession.updateMany({
                where: { familyId: row.familyId, revokedAt: null },
                data: { revokedAt: new Date() },
            });
            throw fail(401, 'Your session has ended. Please sign in again.', 'session_expired');
        }

        const next = await this.issueSession(row.userId, ctx, row.familyId);
        const claimed = await this.prisma.connectSession.updateMany({
            where: { id: row.id, revokedAt: null },
            data: { revokedAt: new Date(), replacedById: next.id },
        });
        if (claimed.count === 0) {
            // Lost a race with another refresh of the same token.
            await this.prisma.connectSession.update({ where: { id: next.id }, data: { revokedAt: new Date() } });
            throw fail(401, 'Your session has ended. Please sign in again.', 'session_expired');
        }

        const { id: _id, ...tokens } = next;
        return { userId: row.userId, tokens };
    }

    async revoke(refreshToken: unknown): Promise<void> {
        if (typeof refreshToken !== 'string') return;
        const row = await this.prisma.connectSession.findUnique({ where: { tokenHash: hash(refreshToken) } });
        if (!row) return;
        await this.prisma.connectSession.updateMany({
            where: { familyId: row.familyId, revokedAt: null },
            data: { revokedAt: new Date() },
        });
    }

    async revokeAll(userId: string): Promise<void> {
        await this.prisma.connectSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    }

    // ------------------------------------------------------------ access tokens

    accessToken(userId: string, appId: string) {
        const accessToken = this.jwt.sign({ typ: 'connect-access' }, { subject: userId, audience: appId, expiresIn: ACCESS_TOKEN_TTL_S });
        return { accessToken, accessTokenExpiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_S * 1000).toISOString() };
    }

    /** User id from a bearer token, or null when there is none. Throws when it is invalid. */
    userFromAuthorization(header: unknown, appId: string): string | null {
        if (typeof header !== 'string' || !header) return null;
        const match = /^Bearer\s+(.+)$/i.exec(header);
        if (!match) throw fail(401, 'Malformed Authorization header.', 'unauthorized');

        const payload = this.verify(match[1], 'connect-access', appId);
        return payload.sub;
    }

    // ---------------------------------------------------------------- step-up

    stepUpToken(userId: string, appId: string, purpose: StepUpPurpose, method: string) {
        const stepUpToken = this.jwt.sign(
            { typ: 'connect-step-up', purpose, method },
            { subject: userId, audience: appId, expiresIn: STEP_UP_TTL_S, jwtid: randomUUID() },
        );
        return { stepUpToken, expiresAt: new Date(Date.now() + STEP_UP_TTL_S * 1000).toISOString() };
    }

    /** Checks and spends a step-up token. */
    consumeStepUp(token: unknown, userId: string, appId: string, purpose: StepUpPurpose): void {
        if (typeof token !== 'string' || !token) {
            throw fail(401, 'Confirm it\'s you to continue.', 'step_up_required');
        }
        let payload: { sub: string; purpose?: string; jti?: string; exp?: number };
        try {
            payload = this.verify(token, 'connect-step-up', appId);
        } catch {
            throw fail(401, 'That confirmation has expired. Confirm again.', 'step_up_required');
        }
        if (payload.sub !== userId || payload.purpose !== purpose) {
            throw fail(401, 'That confirmation is for something else. Confirm again.', 'step_up_required');
        }
        this.spend(payload.jti, payload.exp, 'step_up_required');
    }

    // ------------------------------------------------------------- challenges

    challengeToken(data: { challenge: string; purpose: ChallengePurpose; appId: string; userId?: string; rpId: string }) {
        return this.jwt.sign(
            { typ: 'connect-challenge', challenge: data.challenge, purpose: data.purpose, rpId: data.rpId },
            { audience: data.appId, subject: data.userId ?? 'anonymous', expiresIn: CHALLENGE_TTL_S, jwtid: randomUUID() },
        );
    }

    consumeChallenge(token: unknown, appId: string, purpose: ChallengePurpose) {
        if (typeof token !== 'string') throw fail(400, 'Missing passkey challenge. Try again.', 'invalid_challenge');
        let payload: { sub: string; challenge: string; purpose: string; rpId: string; jti?: string; exp?: number };
        try {
            payload = this.verify(token, 'connect-challenge', appId);
        } catch {
            throw fail(400, 'The passkey request expired. Try again.', 'invalid_challenge');
        }
        if (payload.purpose !== purpose) throw fail(400, 'Wrong passkey request. Try again.', 'invalid_challenge');
        this.spend(payload.jti, payload.exp, 'invalid_challenge');
        return { challenge: payload.challenge, rpId: payload.rpId, userId: payload.sub === 'anonymous' ? null : payload.sub };
    }

    // ---------------------------------------------------------------- helpers

    private verify<T extends object>(token: string, typ: string, appId: string): T & { sub: string } {
        let payload: any;
        try {
            payload = this.jwt.verify(token, { audience: appId });
        } catch {
            throw fail(401, 'Your session has expired.', 'unauthorized');
        }
        if (payload?.typ !== typ || typeof payload.sub !== 'string') {
            throw fail(401, 'Invalid token.', 'unauthorized');
        }
        return payload;
    }

    private spend(jti: string | undefined, exp: number | undefined, code: string): void {
        const now = Date.now();
        if (!jti) throw fail(401, 'Invalid token.', code);
        if (this.spent.has(jti)) throw fail(401, 'That confirmation was already used. Confirm again.', code);
        this.spent.set(jti, (exp ?? now / 1000 + 600) * 1000);
        if (this.spent.size > 5_000) {
            for (const [id, until] of this.spent) if (until < now) this.spent.delete(id);
        }
    }
}
