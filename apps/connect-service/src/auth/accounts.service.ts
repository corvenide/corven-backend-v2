// apps/connect-service/src/auth/accounts.service.ts
//
// Signing in and linking. A verified phone number, email or Google account
// (an "identity") belongs to at most one user per app:
//   - identity known          -> sign in as its user
//   - unknown, not signed in  -> new user (with wallets)
//   - unknown, signed in      -> link it to the signed-in user ("Ways to sign in")
//   - known, signed in as someone else -> refused; identities never move
//     between users silently.
// Passkeys can only be added by a signed-in user, then used to sign in.

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
} from '@simplewebauthn/server';

import { PrismaService } from '@app/prisma';

import type { LoginMethod } from '../http/app-registry.service';
import type { ConnectRequestContext } from '../http/app.guard';
import { fail } from '../http/errors';
import { RateLimiter } from '../http/rate-limiter';
import { WalletsService } from '../wallets/wallets.service';
import { maskEmail, maskPhone, normalizeEmail, normalizePhone } from './destinations';
import { googleClientIdFor, verifyGoogleIdToken } from './google';
import { OTP_PROVIDER, type OtpChannel, type OtpProvider } from './otp';
import { TokensService, type StepUpPurpose } from './tokens.service';

type Kind = 'PHONE' | 'EMAIL' | 'GOOGLE';

interface VerifiedIdentity {
    kind: Kind;
    value: string;
    label?: string | null;
    displayName?: string | null;
}

const PHONE_CHANNELS: OtpChannel[] = ['sms', 'whatsapp', 'call'];

@Injectable()
export class AccountsService {
    private readonly logger = new Logger('ConnectAccounts');

    // Sends: per IP and per destination. Checks: per destination.
    private readonly sendPerIp = new RateLimiter(10, 10 * 60_000);
    private readonly sendPerDestination = new RateLimiter(10, 60 * 60_000, 'Too many codes sent to this number or email. Try again in an hour.');
    private readonly checksPerDestination = new RateLimiter(10, 10 * 60_000, 'Too many wrong codes. Wait 10 minutes and request a new one.');
    private readonly loginsPerIp = new RateLimiter(30, 10 * 60_000);

    constructor(
        private readonly prisma: PrismaService,
        private readonly tokens: TokensService,
        private readonly wallets: WalletsService,
        @Inject(OTP_PROVIDER) private readonly otp: OtpProvider,
    ) { }

    // ------------------------------------------------------------- app config

    publicConfig(ctx: ConnectRequestContext) {
        const { app } = ctx;
        return {
            appId: app.id,
            name: app.name,
            logoUrl: app.logoUrl,
            loginMethods: app.loginMethods,
            googleClientId: app.loginMethods.includes('GOOGLE') ? googleClientIdFor(app.googleClientId) : null,
            networks: app.mainnetEnabled ? ['TESTNET', 'MAINNET'] : ['TESTNET'],
            phoneChannels: PHONE_CHANNELS,
        };
    }

    // ------------------------------------------------------------- codes

    async sendCode(ctx: ConnectRequestContext, body: { phone?: unknown; email?: unknown; channel?: unknown }) {
        const { destination, channel } = this.destination(ctx, body);

        this.sendPerIp.consume(`send:${ctx.app.id}:${ctx.ip}`);
        this.sendPerDestination.consume(`send:${ctx.app.id}:${destination}`);
        await this.otp.send(destination, channel);

        return {
            sent: true,
            channel,
            to: channel === 'email' ? maskEmail(destination) : maskPhone(destination),
        };
    }

    async verifyCode(ctx: ConnectRequestContext, authorization: unknown, body: { phone?: unknown; email?: unknown; code?: unknown }) {
        const { destination, kind } = this.destination(ctx, body);
        await this.checkCode(ctx, destination, body.code);
        return this.signIn(ctx, authorization, { kind, value: destination });
    }

    async google(ctx: ConnectRequestContext, authorization: unknown, body: { credential?: unknown }) {
        this.requireMethod(ctx, 'GOOGLE');
        this.loginsPerIp.consume(`login:${ctx.ip}`);
        const profile = await verifyGoogleIdToken(body.credential, googleClientIdFor(ctx.app.googleClientId));
        return this.signIn(ctx, authorization, { kind: 'GOOGLE', value: profile.sub, label: profile.email, displayName: profile.name });
    }

    // ------------------------------------------------------------- sessions

    async refresh(ctx: ConnectRequestContext, body: { refreshToken?: unknown }) {
        const { userId, tokens } = await this.tokens.rotate(body.refreshToken, ctx);
        return { ...tokens, user: await this.view(userId) };
    }

    async logout(body: { refreshToken?: unknown }) {
        await this.tokens.revoke(body.refreshToken);
        return { ok: true };
    }

    async me(userId: string) {
        return this.view(userId);
    }

    async updateProfile(userId: string, body: { displayName?: unknown }) {
        const name = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 80) : '';
        await this.prisma.connectUser.update({ where: { id: userId }, data: { displayName: name || null } });
        return this.view(userId);
    }

    /** Removes a sign-in method, keeping at least one. */
    async unlink(userId: string, kind: 'identity' | 'passkey', id: string) {
        const [identities, passkeys] = await Promise.all([
            this.prisma.connectIdentity.count({ where: { userId } }),
            this.prisma.connectPasskey.count({ where: { userId } }),
        ]);
        if (identities + passkeys <= 1) throw fail(400, 'Keep at least one way to sign in.', 'last_method');

        const removed =
            kind === 'identity'
                ? await this.prisma.connectIdentity.deleteMany({ where: { id, userId } })
                : await this.prisma.connectPasskey.deleteMany({ where: { id, userId } });
        if (removed.count === 0) throw fail(404, 'Not found.', 'not_found');
        return this.view(userId);
    }

    // ------------------------------------------------------------- passkeys

    async passkeyRegisterOptions(ctx: ConnectRequestContext, userId: string) {
        this.requireMethod(ctx, 'PASSKEY');
        const rpId = rpIdOf(ctx);
        const user = await this.prisma.connectUser.findUniqueOrThrow({
            where: { id: userId },
            include: { identities: true, passkeys: { where: { rpId } } },
        });

        const label = user.identities[0]?.label ?? user.identities[0]?.value ?? user.id;
        const options = await generateRegistrationOptions({
            rpName: ctx.app.name,
            rpID: rpId,
            userName: label,
            userDisplayName: user.displayName ?? label,
            userID: new TextEncoder().encode(user.id),
            attestationType: 'none',
            excludeCredentials: user.passkeys.map((p) => ({ id: p.credentialId, transports: p.transports })),
            authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
        });

        const challengeToken = this.tokens.challengeToken({ challenge: options.challenge, purpose: 'register', appId: ctx.app.id, userId, rpId });
        return { options, challengeToken };
    }

    async passkeyRegisterVerify(ctx: ConnectRequestContext, userId: string, body: { response?: any; challengeToken?: unknown; name?: unknown }) {
        const challenge = this.tokens.consumeChallenge(body.challengeToken, ctx.app.id, 'register');
        if (challenge.userId !== userId) throw fail(400, 'That passkey request was for someone else.', 'invalid_challenge');

        let result;
        try {
            result = await verifyRegistrationResponse({
                response: body.response,
                expectedChallenge: challenge.challenge,
                expectedOrigin: ctx.origin ?? '',
                expectedRPID: challenge.rpId,
                requireUserVerification: false,
            });
        } catch (error) {
            throw fail(400, `Passkey couldn't be added: ${error instanceof Error ? error.message : error}`, 'passkey_failed');
        }
        if (!result.verified) throw fail(400, 'Passkey couldn\'t be verified.', 'passkey_failed');

        const { credential } = result.registrationInfo;
        try {
            await this.prisma.connectPasskey.create({
                data: {
                    userId,
                    credentialId: credential.id,
                    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
                    counter: credential.counter,
                    transports: credential.transports ?? [],
                    rpId: challenge.rpId,
                    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : 'Passkey',
                },
            });
        } catch (error) {
            if ((error as { code?: string })?.code === 'P2002') throw fail(409, 'That passkey is already added.', 'passkey_exists');
            throw error;
        }
        return this.view(userId);
    }

    /** Options to sign in with a passkey, or (signed in) to confirm a sensitive action. */
    async passkeyAuthOptions(ctx: ConnectRequestContext, userId: string | null) {
        this.requireMethod(ctx, 'PASSKEY');
        const rpId = rpIdOf(ctx);
        const allow = userId
            ? (await this.prisma.connectPasskey.findMany({ where: { userId, rpId } })).map((p) => ({ id: p.credentialId, transports: p.transports }))
            : undefined;
        if (userId && allow!.length === 0) throw fail(400, 'You have no passkey on this site yet.', 'no_passkey');

        const options = await generateAuthenticationOptions({ rpID: rpId, allowCredentials: allow, userVerification: 'preferred' });
        const challengeToken = this.tokens.challengeToken({
            challenge: options.challenge,
            purpose: userId ? 'step-up' : 'login',
            appId: ctx.app.id,
            userId: userId ?? undefined,
            rpId,
        });
        return { options, challengeToken };
    }

    async passkeyLogin(ctx: ConnectRequestContext, body: { response?: any; challengeToken?: unknown }) {
        this.loginsPerIp.consume(`login:${ctx.ip}`);
        const challenge = this.tokens.consumeChallenge(body.challengeToken, ctx.app.id, 'login');
        const passkey = await this.verifyPasskey(ctx, challenge, body.response);
        return this.session(ctx, passkey.userId, false);
    }

    // ------------------------------------------------------------- step-up

    /** Sends a code to one of the user's own phone numbers or emails. */
    async stepUpSend(ctx: ConnectRequestContext, userId: string, body: { method?: unknown; channel?: unknown }) {
        const identity = await this.ownIdentity(userId, body.method);
        const channel: OtpChannel = identity.kind === 'EMAIL' ? 'email' : PHONE_CHANNELS.includes(body.channel as OtpChannel) ? (body.channel as OtpChannel) : 'sms';

        this.sendPerDestination.consume(`send:${ctx.app.id}:${identity.value}`);
        await this.otp.send(identity.value, channel);
        return { sent: true, channel, to: identity.kind === 'EMAIL' ? maskEmail(identity.value) : maskPhone(identity.value) };
    }

    async stepUpVerify(
        ctx: ConnectRequestContext,
        userId: string,
        body: { method?: unknown; purpose?: unknown; code?: unknown; credential?: unknown; response?: any; challengeToken?: unknown },
    ) {
        const purpose = body.purpose === 'export' ? 'export' : body.purpose === 'sign' ? 'sign' : null;
        if (!purpose) throw fail(400, 'purpose must be sign or export.', 'invalid_purpose');

        const method = String(body.method ?? '').toUpperCase();
        if (method === 'PHONE' || method === 'EMAIL') {
            const identity = await this.ownIdentity(userId, method);
            await this.checkCode(ctx, identity.value, body.code);
        } else if (method === 'GOOGLE') {
            const profile = await verifyGoogleIdToken(body.credential, googleClientIdFor(ctx.app.googleClientId));
            const owns = await this.prisma.connectIdentity.findFirst({ where: { userId, kind: 'GOOGLE', value: profile.sub } });
            if (!owns) throw fail(401, 'Use the Google account linked to this wallet.', 'wrong_account');
            if (Date.now() / 1000 - profile.issuedAt > 5 * 60) throw fail(401, 'That Google confirmation is too old.', 'step_up_required');
        } else if (method === 'PASSKEY') {
            const challenge = this.tokens.consumeChallenge(body.challengeToken, ctx.app.id, 'step-up');
            if (challenge.userId !== userId) throw fail(401, 'That passkey request was for someone else.', 'invalid_challenge');
            const passkey = await this.verifyPasskey(ctx, challenge, body.response);
            if (passkey.userId !== userId) throw fail(401, 'Use a passkey of this account.', 'wrong_account');
        } else {
            throw fail(400, 'method must be PHONE, EMAIL, GOOGLE or PASSKEY.', 'invalid_method');
        }

        return this.tokens.stepUpToken(userId, ctx.app.id, purpose as StepUpPurpose, method);
    }

    // ------------------------------------------------------------- internals

    private async signIn(ctx: ConnectRequestContext, authorization: unknown, identity: VerifiedIdentity) {
        const appId = ctx.app.id;
        const currentUserId = this.tokens.userFromAuthorization(authorization, appId);

        const existing = await this.prisma.connectIdentity.findUnique({
            where: { appId_kind_value: { appId, kind: identity.kind, value: identity.value } },
        });

        if (currentUserId) {
            // Linking another method to the signed-in user.
            if (existing && existing.userId !== currentUserId) {
                throw fail(409, 'That sign-in method already belongs to another account.', 'identity_in_use');
            }
            if (!existing) {
                await this.prisma.connectIdentity.create({
                    data: { appId, userId: currentUserId, kind: identity.kind, value: identity.value, label: identity.label ?? null },
                });
            }
            return this.session(ctx, currentUserId, false);
        }

        if (existing) {
            if (identity.label && identity.label !== existing.label) {
                await this.prisma.connectIdentity.update({ where: { id: existing.id }, data: { label: identity.label } });
            }
            return this.session(ctx, existing.userId, false);
        }

        let userId: string;
        try {
            userId = await this.prisma.$transaction(async (tx) => {
                const user = await tx.connectUser.create({ data: { appId, displayName: identity.displayName ?? null } });
                await tx.connectIdentity.create({
                    data: { appId, userId: user.id, kind: identity.kind, value: identity.value, label: identity.label ?? null },
                });
                return user.id;
            });
        } catch (error) {
            // Two first sign-ins racing: the other one created the user.
            if ((error as { code?: string })?.code !== 'P2002') throw error;
            const row = await this.prisma.connectIdentity.findUniqueOrThrow({
                where: { appId_kind_value: { appId, kind: identity.kind, value: identity.value } },
            });
            return this.session(ctx, row.userId, false);
        }

        this.logger.log(`New Connect user ${userId} in app ${appId} (${identity.kind})`);
        return this.session(ctx, userId, true);
    }

    private async session(ctx: ConnectRequestContext, userId: string, isNewUser: boolean) {
        await this.wallets.ensureWallets(userId);
        await this.prisma.connectUser.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
        const { id: _id, ...tokens } = await this.tokens.issueSession(userId, ctx);
        return { ...tokens, isNewUser, user: await this.view(userId) };
    }

    private async view(userId: string) {
        const user = await this.prisma.connectUser.findUnique({
            where: { id: userId },
            include: {
                identities: { orderBy: { createdAt: 'asc' } },
                passkeys: { orderBy: { createdAt: 'asc' } },
            },
        });
        if (!user) throw fail(401, 'Your account no longer exists.', 'unauthorized');

        return {
            id: user.id,
            appId: user.appId,
            displayName: user.displayName,
            identities: user.identities.map((i) => ({
                id: i.id,
                kind: i.kind,
                // Google ids mean nothing to people; show the email instead.
                value: i.kind === 'GOOGLE' ? i.label : i.value,
                verifiedAt: i.verifiedAt,
            })),
            passkeys: user.passkeys.map((p) => ({ id: p.id, name: p.name, rpId: p.rpId, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })),
            wallets: await this.wallets.addresses(userId),
            createdAt: user.createdAt,
        };
    }

    private destination(ctx: ConnectRequestContext, body: { phone?: unknown; email?: unknown; channel?: unknown }) {
        if (body.phone !== undefined && body.phone !== null && body.phone !== '') {
            this.requireMethod(ctx, 'PHONE');
            const channel = (PHONE_CHANNELS.includes(body.channel as OtpChannel) ? body.channel : 'sms') as OtpChannel;
            return { kind: 'PHONE' as const, destination: normalizePhone(body.phone), channel };
        }
        if (body.email !== undefined && body.email !== null && body.email !== '') {
            this.requireMethod(ctx, 'EMAIL');
            return { kind: 'EMAIL' as const, destination: normalizeEmail(body.email), channel: 'email' as const };
        }
        throw fail(400, 'Enter a phone number or email.', 'missing_destination');
    }

    private async checkCode(ctx: ConnectRequestContext, destination: string, code: unknown) {
        const text = String(code ?? '').replace(/\s/g, '');
        if (!/^\d{4,10}$/.test(text)) throw fail(400, 'Enter the code we sent you.', 'invalid_code');

        this.checksPerDestination.consume(`check:${ctx.app.id}:${destination}`);
        const ok = await this.otp.check(destination, text);
        if (!ok) throw fail(401, 'That code is wrong or has expired.', 'wrong_code');
        this.checksPerDestination.reset(`check:${ctx.app.id}:${destination}`);
    }

    private async ownIdentity(userId: string, method: unknown) {
        const kind = String(method ?? '').toUpperCase();
        if (kind !== 'PHONE' && kind !== 'EMAIL') throw fail(400, 'method must be PHONE or EMAIL.', 'invalid_method');
        const identity = await this.prisma.connectIdentity.findFirst({ where: { userId, kind }, orderBy: { createdAt: 'asc' } });
        if (!identity) throw fail(400, `Add ${kind === 'PHONE' ? 'a phone number' : 'an email'} to your account first.`, 'no_identity');
        return identity;
    }

    private async verifyPasskey(ctx: ConnectRequestContext, challenge: { challenge: string; rpId: string }, response: any) {
        const credentialId = typeof response?.id === 'string' ? response.id : '';
        const passkey = await this.prisma.connectPasskey.findUnique({ where: { credentialId }, include: { user: true } });
        if (!passkey || passkey.user.appId !== ctx.app.id || passkey.rpId !== challenge.rpId) {
            throw fail(401, 'That passkey isn\'t registered here.', 'unknown_passkey');
        }

        let result;
        try {
            result = await verifyAuthenticationResponse({
                response,
                expectedChallenge: challenge.challenge,
                expectedOrigin: ctx.origin ?? '',
                expectedRPID: challenge.rpId,
                credential: {
                    id: passkey.credentialId,
                    publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
                    counter: passkey.counter,
                    transports: passkey.transports,
                },
                requireUserVerification: false,
            });
        } catch (error) {
            throw fail(401, `Passkey check failed: ${error instanceof Error ? error.message : error}`, 'passkey_failed');
        }
        if (!result.verified) throw fail(401, 'Passkey check failed.', 'passkey_failed');

        await this.prisma.connectPasskey.update({
            where: { id: passkey.id },
            data: { counter: result.authenticationInfo.newCounter, lastUsedAt: new Date() },
        });
        return passkey;
    }

    private requireMethod(ctx: ConnectRequestContext, method: LoginMethod) {
        if (!ctx.app.loginMethods.includes(method)) throw fail(403, `${method.toLowerCase()} sign-in is turned off for this app.`, 'method_disabled');
    }
}

/** Passkeys are bound to the domain of the page that uses them. */
function rpIdOf(ctx: ConnectRequestContext): string {
    if (!ctx.origin) throw fail(400, 'Passkeys only work from a web page.', 'no_origin');
    return new URL(ctx.origin).hostname;
}
