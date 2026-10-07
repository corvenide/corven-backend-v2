// apps/auth-service/src/auth-service.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { JwtService } from '@nestjs/jwt';

import { PrismaService } from '@app/prisma';

import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { ccc } from '@ckb-ccc/core';

import {
    clientForAddress,
    parseSignature,
    verifyWalletOwnership,
} from './wallet-verification';
import {
    GoogleVerificationError,
    verifyGoogleCredential,
    type GoogleIdentity,
} from './google-verification';

export interface SessionMeta {
    userAgent?: string;
    ipAddress?: string;
}

interface UserRecord {
    id: string;
    email: string | null;
    walletAddress: string | null;
    role: string;
    name: string;
    authProvider: string;
    createdAt: Date;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** A guest's workspaces handed to the account they signed in to. */
export interface ClaimedWorkspace {
    id: string;
    name: string;
    temporary: boolean;
}

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

function unauthorized(message: string): RpcException {
    return new RpcException({ statusCode: 401, message });
}

function badRequest(message: string): RpcException {
    return new RpcException({ statusCode: 400, message });
}

@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);

    // Real bcrypt hash of a random value, used to equalise login timing.
    private readonly dummyHash = bcrypt.hashSync(randomBytes(16).toString('hex'), 12);

    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
    ) { }

    // ------------------------------------------------------------------
    // Guests: use the IDE without signing in
    // ------------------------------------------------------------------

    /**
     * Starts a guest session. Guests get a real (but nameless) account so
     * every service keeps working with normal access tokens; they can only
     * make temporary workspaces. Signing in later with a wallet or Google
     * hands those workspaces to the real account.
     */
    async guestStart(data: { meta?: SessionMeta }) {
        const user = await this.prisma.user.create({
            data: {
                name: `Guest ${randomBytes(2).toString('hex').toUpperCase()}`,
                authProvider: 'GUEST',
            },
        });

        return this.issueSession(user, data.meta);
    }

    /** The guest behind an access token, or null for anything else. */
    private async guestIdFrom(token?: string): Promise<string | null> {
        if (!token) return null;

        try {
            const payload = await this.jwtService.verifyAsync<{ sub?: string; typ?: string }>(token);
            if (!payload.sub || payload.typ !== 'access') return null;

            const user = await this.prisma.user.findUnique({
                where: { id: payload.sub },
                select: { id: true, authProvider: true },
            });

            return user?.authProvider === 'GUEST' ? user.id : null;
        } catch {
            return null;
        }
    }

    private async guestWorkspaces(tx: Tx, guestId: string): Promise<ClaimedWorkspace[]> {
        return tx.workspace.findMany({
            where: { userId: guestId, status: { not: 'DELETED' } },
            select: { id: true, name: true, temporary: true },
            orderBy: { createdAt: 'desc' },
        });
    }

    /** Moves a guest's workspaces into an existing account and removes the guest. */
    private async mergeGuest(tx: Tx, guestId: string, accountId: string): Promise<ClaimedWorkspace[]> {
        const stillGuest = await tx.user.findFirst({ where: { id: guestId, authProvider: 'GUEST' }, select: { id: true } });
        if (!stillGuest || guestId === accountId) return [];

        const workspaces = await this.guestWorkspaces(tx, guestId);

        await tx.workspace.updateMany({ where: { userId: guestId }, data: { userId: accountId } });
        await tx.user.delete({ where: { id: guestId } });

        return workspaces;
    }

    /**
     * Turns the guest itself into the new account, keeping its id (and so
     * its workspaces). Old guest sessions are revoked: they must not carry
     * over to an account that now has a wallet or Google behind it.
     */
    private async upgradeGuest(
        tx: Tx,
        guestId: string,
        data: { name: string; authProvider: 'CKB_WALLET' | 'GOOGLE'; walletAddress?: string; email?: string; googleId?: string },
    ): Promise<{ user: UserRecord; workspaces: ClaimedWorkspace[] } | null> {
        const upgraded = await tx.user.updateMany({ where: { id: guestId, authProvider: 'GUEST' }, data });
        if (upgraded.count === 0) return null;

        await tx.refreshToken.updateMany({ where: { userId: guestId, revokedAt: null }, data: { revokedAt: new Date() } });

        const user = await tx.user.findUniqueOrThrow({ where: { id: guestId } });

        return { user, workspaces: await this.guestWorkspaces(tx, guestId) };
    }

    // ------------------------------------------------------------------
    // Wallet authentication
    // ------------------------------------------------------------------

    async createWalletChallenge(data: { walletAddress: string }) {
        const walletAddress = (data.walletAddress ?? '').trim();

        if (!walletAddress) {
            throw badRequest('Wallet address is required');
        }

        await this.assertValidWalletAddress(walletAddress);

        // Keep the table small: drop challenges that expired over an hour ago.
        await this.prisma.walletChallenge.deleteMany({
            where: { expiresAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } },
        });

        const nonce = randomBytes(32).toString('hex');
        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);

        const message = this.buildWalletMessage({
            walletAddress,
            nonce,
            issuedAt,
            expiresAt,
        });

        const challenge = await this.prisma.walletChallenge.create({
            data: { walletAddress, nonce, message, expiresAt },
        });

        return {
            challengeId: challenge.id,
            nonce: challenge.nonce,
            message: challenge.message,
            expiresAt: challenge.expiresAt,
        };
    }

    async walletLogin(data: {
        walletAddress: string;
        challengeId: string;
        signature: unknown;
        meta?: SessionMeta;
        /** The current access token, when a guest is connecting a wallet. */
        guestToken?: string;
    }) {
        const walletAddress = (data.walletAddress ?? '').trim();

        if (!walletAddress || !data.challengeId) {
            throw badRequest('Wallet address and challenge are required');
        }

        const signature = parseSignature(data.signature);

        if (!signature) {
            throw badRequest('Malformed wallet signature');
        }

        const challenge = await this.prisma.walletChallenge.findUnique({
            where: { id: data.challengeId },
        });

        if (!challenge || challenge.walletAddress !== walletAddress) {
            throw unauthorized('Sign-in request not found. Please try again.');
        }

        if (challenge.usedAt) {
            throw unauthorized('This sign-in request was already used. Please try again.');
        }

        if (challenge.expiresAt.getTime() < Date.now()) {
            throw unauthorized('This sign-in request expired. Please try again.');
        }

        const verification = await verifyWalletOwnership({
            message: challenge.message,
            walletAddress,
            signature,
        });

        if (!verification.ok) {
            this.logger.warn(
                `Wallet login rejected (${verification.reason}) for ${walletAddress}`,
            );

            throw unauthorized(
                verification.reason === 'unsupported_signer'
                    ? 'This wallet type is not supported for sign-in yet.'
                    : 'The signature does not match this wallet.',
            );
        }

        const guestId = await this.guestIdFrom(data.guestToken);

        const { user, claimed: claimedWorkspaces } = await this.prisma.$transaction(async (tx) => {
            // Atomically claim the challenge so it can only be used once,
            // even with concurrent requests.
            const challengeClaim = await tx.walletChallenge.updateMany({
                where: { id: challenge.id, usedAt: null },
                data: { usedAt: new Date() },
            });

            if (challengeClaim.count === 0) {
                throw unauthorized('This sign-in request was already used. Please try again.');
            }

            const existing = await tx.user.findUnique({
                where: { walletAddress },
            });

            let account: UserRecord | null = existing;
            let claimed: ClaimedWorkspace[] = [];

            if (existing) {
                if (guestId) claimed = await this.mergeGuest(tx, guestId, existing.id);
            } else if (guestId) {
                const upgraded = await this.upgradeGuest(tx, guestId, {
                    name: this.walletDisplayName(walletAddress),
                    walletAddress,
                    authProvider: 'CKB_WALLET',
                });

                if (upgraded) {
                    account = upgraded.user;
                    claimed = upgraded.workspaces;
                }
            }

            account ??= await tx.user.create({
                data: {
                    name: this.walletDisplayName(walletAddress),
                    walletAddress,
                    authProvider: 'CKB_WALLET',
                },
            });

            await tx.walletChallenge.update({
                where: { id: challenge.id },
                data: { userId: account.id },
            });

            return { user: account, claimed };
        });

        return { ...(await this.issueSession(user, data.meta)), claimedWorkspaces };
    }

    // ------------------------------------------------------------------
    // Google authentication
    // ------------------------------------------------------------------

    /**
     * Signs in with a Google ID token from Google Identity Services.
     *
     * The account is found by Google account id; the first sign-in creates
     * it. Google accounts are never merged into an existing account with
     * the same email: email/password sign-up doesn't verify emails, so
     * someone could register a victim's address first and keep access
     * after the victim later signed in with Google.
     */
    async googleLogin(data: { credential: string; meta?: SessionMeta; guestToken?: string }) {
        let identity: GoogleIdentity;

        try {
            identity = await verifyGoogleCredential(data.credential);
        } catch (error) {
            const reason = error instanceof GoogleVerificationError ? error.reason : 'invalid_token';

            if (reason === 'not_configured') {
                throw new RpcException({ statusCode: 503, message: 'Google sign-in is not set up on this server.' });
            }

            this.logger.warn(`Google login rejected (${reason})`);

            throw unauthorized(
                reason === 'email_not_verified'
                    ? 'Your Google account email is not verified.'
                    : 'Google sign-in failed. Please try again.',
            );
        }

        let user: UserRecord;
        let claimed: ClaimedWorkspace[] = [];
        const guestId = await this.guestIdFrom(data.guestToken);

        try {
            ({ user, claimed } = await this.findOrCreateGoogleUser(identity, guestId));
        } catch (error) {
            // Two first-time sign-ins racing: the other one created the user.
            if ((error as { code?: string })?.code !== 'P2002') throw error;

            const existing = await this.prisma.user.findUnique({ where: { googleId: identity.sub } });
            if (!existing) {
                throw new RpcException({ statusCode: 409, message: 'An account with this email already exists.' });
            }
            user = existing;
        }

        return { ...(await this.issueSession(user, data.meta)), claimedWorkspaces: claimed };
    }

    private async findOrCreateGoogleUser(
        identity: GoogleIdentity,
        guestId: string | null,
    ): Promise<{ user: UserRecord; claimed: ClaimedWorkspace[] }> {
        return this.prisma.$transaction(async (tx) => {
            const linked = await tx.user.findUnique({ where: { googleId: identity.sub } });
            if (linked) {
                return { user: linked, claimed: guestId ? await this.mergeGuest(tx, guestId, linked.id) : [] };
            }

            const byEmail = await tx.user.findUnique({ where: { email: identity.email } });

            if (byEmail) {
                throw new RpcException({
                    statusCode: 409,
                    message: 'An account with this email already exists. Sign in the way you did before.',
                });
            }

            const fields = {
                name: identity.name ?? identity.email.split('@')[0],
                email: identity.email,
                googleId: identity.sub,
                authProvider: 'GOOGLE' as const,
            };

            if (guestId) {
                const upgraded = await this.upgradeGuest(tx, guestId, fields);
                if (upgraded) return { user: upgraded.user, claimed: upgraded.workspaces };
            }

            return { user: await tx.user.create({ data: fields }), claimed: [] };
        });
    }

    // ------------------------------------------------------------------
    // Email authentication (kept for API compatibility; not used by the UI)
    // ------------------------------------------------------------------

    async register(data: {
        name: string;
        email: string;
        password: string;
        meta?: SessionMeta;
    }) {
        const name = (data.name ?? '').trim();
        const email = (data.email ?? '').trim().toLowerCase();
        const password = data.password ?? '';

        if (!name || name.length > 80) {
            throw badRequest('Name is required (max 80 characters)');
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            throw badRequest('A valid email is required');
        }

        if (password.length < 8 || password.length > 128) {
            throw badRequest('Password must be 8–128 characters');
        }

        const existing = await this.prisma.user.findUnique({ where: { email } });

        if (existing) {
            throw badRequest('An account with this email already exists');
        }

        const user = await this.prisma.user.create({
            data: {
                name,
                email,
                passwordHash: await bcrypt.hash(password, 12),
                authProvider: 'EMAIL',
            },
        });

        return this.issueSession(user, data.meta);
    }

    async login(data: { email: string; password: string; meta?: SessionMeta }) {
        const email = (data.email ?? '').trim().toLowerCase();

        const user = await this.prisma.user.findUnique({ where: { email } });

        // Compare against a dummy hash when the user doesn't exist, so
        // response timing doesn't reveal which emails are registered.
        const hash = user?.passwordHash ?? this.dummyHash;

        const ok = await bcrypt.compare(data.password ?? '', hash);

        if (!user || !user.passwordHash || !ok) {
            throw unauthorized('Invalid credentials');
        }

        return this.issueSession(user, data.meta);
    }

    // ------------------------------------------------------------------
    // Sessions: access + rotating refresh tokens
    // ------------------------------------------------------------------

    async refresh(data: { refreshToken: string; meta?: SessionMeta }) {
        if (!data.refreshToken) {
            throw unauthorized('No session');
        }

        const tokenHash = this.hashToken(data.refreshToken);

        const current = await this.prisma.refreshToken.findUnique({
            where: { tokenHash },
            include: { user: true },
        });

        if (!current) {
            throw unauthorized('Session not found');
        }

        if (current.revokedAt && current.replacedById && this.withinReuseGrace(current.revokedAt)) {
            // Rotated moments ago, but the browser never stored the new token:
            // the page navigated or reloaded while the refresh was in flight.
            // Treat it as the same session rather than theft (which would sign
            // the person out, and cost a guest their workspaces).
            return this.rotateFamily(current, data.meta);
        }

        if (current.revokedAt) {
            // A revoked token being presented again means it was copied.
            // Kill every session descended from the same login.
            await this.prisma.refreshToken.updateMany({
                where: { familyId: current.familyId, revokedAt: null },
                data: { revokedAt: new Date() },
            });

            this.logger.warn(
                `Refresh token reuse detected for user ${current.userId}; family ${current.familyId} revoked`,
            );

            throw unauthorized('Session expired. Please sign in again.');
        }

        if (current.expiresAt.getTime() < Date.now()) {
            throw unauthorized('Session expired. Please sign in again.');
        }

        const next = this.generateRefreshToken();

        await this.prisma.$transaction(async (tx) => {
            const created = await tx.refreshToken.create({
                data: {
                    userId: current.userId,
                    familyId: current.familyId,
                    tokenHash: this.hashToken(next.token),
                    expiresAt: next.expiresAt,
                    userAgent: data.meta?.userAgent?.slice(0, 500),
                    ipAddress: data.meta?.ipAddress?.slice(0, 100),
                },
            });

            // Guard against two tabs refreshing with the same token at once:
            // only one of them gets to revoke it.
            const revoked = await tx.refreshToken.updateMany({
                where: { id: current.id, revokedAt: null },
                data: {
                    revokedAt: new Date(),
                    replacedById: created.id,
                    lastUsedAt: new Date(),
                },
            });

            if (revoked.count === 0) {
                throw unauthorized('Session expired. Please sign in again.');
            }
        });

        return {
            accessToken: this.signAccessToken(current.user),
            refreshToken: next.token,
            refreshTokenExpiresAt: next.expiresAt,
            user: this.sanitizeUser(current.user),
        };
    }

    /** REFRESH_REUSE_GRACE_SECONDS (default 30): how late a just-rotated token is still accepted. */
    private withinReuseGrace(revokedAt: Date): boolean {
        const raw = Number(process.env.REFRESH_REUSE_GRACE_SECONDS);
        const seconds = Number.isFinite(raw) && raw >= 0 ? raw : 30;
        return Date.now() - revokedAt.getTime() < seconds * 1000;
    }

    /** Issues a new token in the family and retires every other live one. */
    private async rotateFamily(
        current: { userId: string; familyId: string; expiresAt: Date; user: UserRecord },
        meta?: SessionMeta,
    ) {
        if (current.expiresAt.getTime() < Date.now()) {
            throw unauthorized('Session expired. Please sign in again.');
        }

        const next = this.generateRefreshToken();

        await this.prisma.$transaction(async (tx) => {
            const family = await tx.refreshToken.findFirst({
                where: { familyId: current.familyId },
                orderBy: { createdAt: 'desc' },
                select: { revokedAt: true, replacedById: true },
            });

            // The family was ended (sign-out, or real reuse detected).
            if (!family || (family.revokedAt && !family.replacedById)) {
                throw unauthorized('Session expired. Please sign in again.');
            }

            const created = await tx.refreshToken.create({
                data: {
                    userId: current.userId,
                    familyId: current.familyId,
                    tokenHash: this.hashToken(next.token),
                    expiresAt: next.expiresAt,
                    userAgent: meta?.userAgent?.slice(0, 500),
                    ipAddress: meta?.ipAddress?.slice(0, 100),
                },
            });

            await tx.refreshToken.updateMany({
                where: { familyId: current.familyId, revokedAt: null, id: { not: created.id } },
                data: { revokedAt: new Date(), replacedById: created.id },
            });
        });

        return {
            accessToken: this.signAccessToken(current.user),
            refreshToken: next.token,
            refreshTokenExpiresAt: next.expiresAt,
            user: this.sanitizeUser(current.user),
        };
    }

    async logout(data: { refreshToken?: string }) {
        if (!data.refreshToken) {
            return { success: true };
        }

        const token = await this.prisma.refreshToken.findUnique({
            where: { tokenHash: this.hashToken(data.refreshToken) },
        });

        if (token) {
            await this.prisma.refreshToken.updateMany({
                where: { familyId: token.familyId, revokedAt: null },
                data: { revokedAt: new Date() },
            });
        }

        return { success: true };
    }

    async logoutAll(data: { userId: string }) {
        await this.prisma.refreshToken.updateMany({
            where: { userId: data.userId, revokedAt: null },
            data: { revokedAt: new Date() },
        });

        return { success: true };
    }

    async verifyToken(token: string) {
        let payload: { sub?: string; typ?: string };

        try {
            payload = await this.jwtService.verifyAsync(token);
        } catch {
            throw unauthorized('Invalid token');
        }

        if (!payload.sub || payload.typ !== 'access') {
            throw unauthorized('Invalid token');
        }

        const user = await this.prisma.user.findUnique({
            where: { id: payload.sub },
        });

        if (!user) {
            throw unauthorized('Invalid token');
        }

        return { valid: true, user: this.sanitizeUser(user) };
    }

    async getProfile(userId: string) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });

        if (!user) {
            throw new RpcException({ statusCode: 404, message: 'User not found' });
        }

        return this.sanitizeUser(user);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private async issueSession(user: UserRecord, meta?: SessionMeta) {
        const refresh = this.generateRefreshToken();

        await this.prisma.refreshToken.create({
            data: {
                userId: user.id,
                familyId: randomUUID(),
                tokenHash: this.hashToken(refresh.token),
                expiresAt: refresh.expiresAt,
                userAgent: meta?.userAgent?.slice(0, 500),
                ipAddress: meta?.ipAddress?.slice(0, 100),
            },
        });

        return {
            accessToken: this.signAccessToken(user),
            refreshToken: refresh.token,
            refreshTokenExpiresAt: refresh.expiresAt,
            user: this.sanitizeUser(user),
        };
    }

    private signAccessToken(user: UserRecord): string {
        return this.jwtService.sign({
            sub: user.id,
            typ: 'access',
            authProvider: user.authProvider,
        });
    }

    private generateRefreshToken() {
        const days = Number(process.env.REFRESH_TOKEN_TTL_DAYS) || 30;

        return {
            token: randomBytes(48).toString('base64url'),
            expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
        };
    }

    private hashToken(token: string): string {
        return createHash('sha256').update(token).digest('hex');
    }

    private async assertValidWalletAddress(walletAddress: string) {
        try {
            await ccc.Address.fromString(walletAddress, clientForAddress(walletAddress));
        } catch {
            throw badRequest('Invalid CKB wallet address');
        }
    }

    private buildWalletMessage(input: {
        walletAddress: string;
        nonce: string;
        issuedAt: Date;
        expiresAt: Date;
    }): string {
        const origin = process.env.APP_ORIGIN || 'Corven';

        return [
            `${origin} wants you to sign in with your CKB wallet.`,
            '',
            'Signing this message proves you own this wallet.',
            'It does not create a transaction or spend any funds.',
            '',
            `Wallet: ${input.walletAddress}`,
            `Nonce: ${input.nonce}`,
            `Issued At: ${input.issuedAt.toISOString()}`,
            `Expires At: ${input.expiresAt.toISOString()}`,
        ].join('\n');
    }

    private walletDisplayName(walletAddress: string): string {
        return `CKB User ${walletAddress.slice(-6)}`;
    }

    private sanitizeUser(user: UserRecord) {
        return {
            id: user.id,
            name: user.name,
            email: user.email,
            walletAddress: user.walletAddress,
            authProvider: user.authProvider,
            role: user.role,
            isGuest: user.authProvider === 'GUEST',
            createdAt: user.createdAt,
        };
    }
}
