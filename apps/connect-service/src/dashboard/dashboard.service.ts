// apps/connect-service/src/dashboard/dashboard.service.ts
//
// What developers do in the Connect dashboard (inside Corven IDE): create
// and edit their apps, look at their users and usage, and manage a team.
//
// Roles per app:
//   VIEWER  sees settings, users, stats and the team
//   ADMIN   + edits settings, signs users out or deletes them, invites
//           admins and viewers, removes non-owners
//   OWNER   + mainnet on/off, roles, owners, deleting the app

import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

import { inviteEmail, mailerFromEnv, type Mailer } from '@app/mailer';
import { PrismaService } from '@app/prisma';

import { appFields, newAppId } from '../http/app-fields';
import { AppRegistry } from '../http/app-registry.service';
import { fail } from '../http/errors';
import type { IdeUser } from './ide-user.guard';

type Role = 'OWNER' | 'ADMIN' | 'VIEWER';
const RANK: Record<Role, number> = { VIEWER: 1, ADMIN: 2, OWNER: 3 };
const ROLES: Role[] = ['OWNER', 'ADMIN', 'VIEWER'];
const MAX_OWNED_APPS = 10;
const INVITE_DAYS = 7;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export function dashboardUrl(env = process.env): string {
    const explicit = env.CONNECT_DASHBOARD_URL?.trim();
    if (explicit) return explicit.replace(/\/+$/, '');
    const first = (env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).find(Boolean);
    return (first ?? 'https://corvanide.space').replace(/\/+$/, '');
}

@Injectable()
export class DashboardService {
    private readonly logger = new Logger('ConnectDashboard');
    private mailerCache: Mailer | null | undefined;

    constructor(
        private readonly prisma: PrismaService,
        private readonly registry: AppRegistry,
    ) { }

    // ------------------------------------------------------------- apps

    async listApps(user: IdeUser) {
        const memberships = await this.prisma.connectAppMember.findMany({
            where: { userId: user.id },
            include: { app: { include: { _count: { select: { users: true } } } } },
            orderBy: { createdAt: 'desc' },
        });
        return memberships.map((m) => ({ ...this.appView(m.app), role: m.role, userCount: m.app._count.users }));
    }

    async createApp(user: IdeUser, body: any) {
        const owned = await this.prisma.connectAppMember.count({ where: { userId: user.id, role: 'OWNER' } });
        if (owned >= MAX_OWNED_APPS) throw fail(400, `You can own up to ${MAX_OWNED_APPS} apps.`);

        const app = await this.prisma.connectApp.create({
            data: {
                id: newAppId(),
                createdById: user.id,
                ...(appFields(body, false) as any),
                mainnetEnabled: false,
                members: { create: { userId: user.id, role: 'OWNER' } },
            },
        });
        this.registry.invalidate();
        this.logger.log(`${user.id} created app ${app.id}`);
        return { ...this.appView(app), role: 'OWNER' as Role, userCount: 0 };
    }

    async getApp(user: IdeUser, appId: string) {
        const role = await this.roleOf(user, appId, 'VIEWER');
        const app = await this.prisma.connectApp.findUniqueOrThrow({ where: { id: appId }, include: { _count: { select: { users: true } } } });
        return { ...this.appView(app), role, userCount: app._count.users };
    }

    async updateApp(user: IdeUser, appId: string, body: any) {
        const role = await this.roleOf(user, appId, 'ADMIN');
        const data = appFields(body, true);
        if ('mainnetEnabled' in data && role !== 'OWNER') throw fail(403, 'Only owners can turn mainnet on or off.');
        await this.prisma.connectApp.update({ where: { id: appId }, data });
        this.registry.invalidate();
        return this.getApp(user, appId);
    }

    async deleteApp(user: IdeUser, appId: string, body: any) {
        await this.roleOf(user, appId, 'OWNER');
        const app = await this.prisma.connectApp.findUniqueOrThrow({ where: { id: appId } });
        if (String(body?.confirm ?? '') !== app.name) throw fail(400, `Type the app name (${app.name}) to confirm.`);
        await this.prisma.connectApp.delete({ where: { id: appId } });
        this.registry.invalidate();
        this.logger.warn(`${user.id} deleted app ${appId}`);
        return { ok: true };
    }

    // ------------------------------------------------------------- users

    async listUsers(user: IdeUser, appId: string, query: { q?: string; cursor?: string; limit?: string }) {
        await this.roleOf(user, appId, 'VIEWER');
        const take = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
        const q = (query.q ?? '').trim().slice(0, 100);

        const where: any = { appId };
        if (q) {
            where.OR = [
                { id: q },
                { displayName: { contains: q, mode: 'insensitive' } },
                { identities: { some: { OR: [{ value: { contains: q, mode: 'insensitive' } }, { label: { contains: q, mode: 'insensitive' } }] } } },
                { wallets: { some: { address: { contains: q } } } },
            ];
        }

        const rows = await this.prisma.connectUser.findMany({
            where,
            include: {
                identities: { orderBy: { createdAt: 'asc' } },
                wallets: { select: { network: true, address: true } },
                _count: { select: { passkeys: true, signatures: true } },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: take + 1,
            ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        });

        const page = rows.slice(0, take);
        return {
            users: page.map((u) => this.userView(u)),
            nextCursor: rows.length > take ? page[page.length - 1].id : null,
            total: await this.prisma.connectUser.count({ where: { appId } }),
        };
    }

    async getUser(user: IdeUser, appId: string, userId: string) {
        await this.roleOf(user, appId, 'VIEWER');
        const u = await this.prisma.connectUser.findFirst({
            where: { id: userId, appId },
            include: {
                identities: { orderBy: { createdAt: 'asc' } },
                wallets: { select: { network: true, address: true } },
                passkeys: { select: { id: true, name: true, rpId: true, createdAt: true, lastUsedAt: true } },
                signatures: { orderBy: { createdAt: 'desc' }, take: 20, select: { network: true, txHash: true, outflow: true, origin: true, createdAt: true } },
                _count: { select: { passkeys: true, signatures: true } },
            },
        });
        if (!u) throw fail(404, 'User not found.');
        const activeSessions = await this.prisma.connectSession.count({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } } });
        return { ...this.userView(u), passkeys: u.passkeys, signatures: u.signatures, activeSessions };
    }

    async signOutUser(user: IdeUser, appId: string, userId: string) {
        await this.roleOf(user, appId, 'ADMIN');
        await this.assertUserInApp(appId, userId);
        const { count } = await this.prisma.connectSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
        return { revoked: count };
    }

    async deleteUser(user: IdeUser, appId: string, userId: string, body: any) {
        await this.roleOf(user, appId, 'ADMIN');
        await this.assertUserInApp(appId, userId);
        if (body?.confirm !== 'DELETE') throw fail(400, 'Confirm with "DELETE". This also deletes the user\'s Corven-held wallet keys.');
        await this.prisma.connectUser.delete({ where: { id: userId } });
        this.logger.warn(`${user.id} deleted Connect user ${userId} of app ${appId}`);
        return { ok: true };
    }

    // ------------------------------------------------------------- stats

    async stats(user: IdeUser, appId: string, daysParam?: string) {
        await this.roleOf(user, appId, 'VIEWER');
        const days = [7, 30, 90].includes(Number(daysParam)) ? Number(daysParam) : 30;
        const since = new Date(Date.now() - days * 86_400_000);
        since.setUTCHours(0, 0, 0, 0);

        const rows = await this.prisma.$queryRaw<{ day: string; kind: string; count: number }[]>`
            SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day, kind::text AS kind, count(*)::int AS count
            FROM "ConnectEvent"
            WHERE "appId" = ${appId} AND "createdAt" >= ${since}
            GROUP BY 1, 2
            ORDER BY 1`;

        const series: { day: string; signUps: number; signIns: number; codesSent: number; txSigned: number }[] = [];
        for (let i = 0; i < days + 1; i++) {
            const d = new Date(since.getTime() + i * 86_400_000);
            if (d.getTime() > Date.now()) break;
            series.push({ day: d.toISOString().slice(0, 10), signUps: 0, signIns: 0, codesSent: 0, txSigned: 0 });
        }
        const byDay = new Map(series.map((s) => [s.day, s]));
        const key = { SIGN_UP: 'signUps', SIGN_IN: 'signIns', CODE_SENT: 'codesSent', TX_SIGNED: 'txSigned' } as const;
        for (const r of rows) {
            const entry = byDay.get(r.day);
            if (entry && r.kind in key) entry[key[r.kind as keyof typeof key]] += Number(r.count);
        }

        const methods = await this.prisma.connectEvent.groupBy({
            by: ['method'],
            where: { appId, kind: { in: ['SIGN_UP', 'SIGN_IN'] }, createdAt: { gte: since } },
            _count: { _all: true },
        });

        const [totalUsers, newUsers, activeUsers] = await Promise.all([
            this.prisma.connectUser.count({ where: { appId } }),
            this.prisma.connectUser.count({ where: { appId, createdAt: { gte: since } } }),
            this.prisma.connectUser.count({ where: { appId, lastLoginAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } }),
        ]);

        const sum = (k: keyof (typeof series)[number]) => series.reduce((n, s) => n + (typeof s[k] === 'number' ? (s[k] as number) : 0), 0);
        return {
            days,
            totals: { users: totalUsers, newUsers, activeUsers7d: activeUsers, signIns: sum('signIns') + sum('signUps'), codesSent: sum('codesSent'), txSigned: sum('txSigned') },
            series,
            methods: methods.map((m) => ({ method: m.method ?? 'UNKNOWN', count: m._count._all })).sort((a, b) => b.count - a.count),
        };
    }

    // ------------------------------------------------------------- team

    async team(user: IdeUser, appId: string) {
        const role = await this.roleOf(user, appId, 'VIEWER');
        const members = await this.prisma.connectAppMember.findMany({ where: { appId }, orderBy: { createdAt: 'asc' } });
        const people = await this.prisma.user.findMany({
            where: { id: { in: members.map((m) => m.userId) } },
            select: { id: true, name: true, email: true, walletAddress: true },
        });
        const byId = new Map(people.map((p) => [p.id, p]));
        const invites =
            RANK[role] >= RANK.ADMIN
                ? await this.prisma.connectAppInvite.findMany({
                    where: { appId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
                    orderBy: { createdAt: 'desc' },
                    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
                })
                : [];
        return {
            role,
            members: members.map((m) => ({
                id: m.id,
                userId: m.userId,
                role: m.role,
                isYou: m.userId === user.id,
                name: byId.get(m.userId)?.name ?? 'Deleted account',
                email: byId.get(m.userId)?.email ?? null,
                walletAddress: byId.get(m.userId)?.walletAddress ?? null,
                createdAt: m.createdAt,
            })),
            invites,
        };
    }

    async invite(user: IdeUser, appId: string, body: any) {
        const myRole = await this.roleOf(user, appId, 'ADMIN');
        const role = String(body?.role ?? 'VIEWER').toUpperCase() as Role;
        if (!ROLES.includes(role)) throw fail(400, 'Role must be OWNER, ADMIN or VIEWER.');
        if (RANK[role] > RANK[myRole] || (role === 'OWNER' && myRole !== 'OWNER')) throw fail(403, 'You can\'t invite someone with a higher role than yours.');

        const email = body?.email ? String(body.email).trim().toLowerCase() : null;
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw fail(400, 'Enter a valid email, or leave it empty to get a link.');

        const pending = await this.prisma.connectAppInvite.count({ where: { appId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } });
        if (pending >= 20) throw fail(400, 'Too many pending invites. Revoke some first.');

        const token = randomBytes(24).toString('base64url');
        const invite = await this.prisma.connectAppInvite.create({
            data: { appId, email, role, tokenHash: hash(token), invitedById: user.id, expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) },
            select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
        });
        const link = `${dashboardUrl()}/connect/invite/${token}`;

        let emailed = false;
        const mailer = this.mailer();
        if (email && mailer) {
            const app = await this.prisma.connectApp.findUniqueOrThrow({ where: { id: appId }, select: { name: true } });
            try {
                await mailer.send({ to: email, fromName: 'Corven Connect', ...inviteEmail({ appName: app.name, inviterName: user.name, role, link, daysValid: INVITE_DAYS }) });
                emailed = true;
            } catch (error) {
                this.logger.warn(`Invite email to ${email} failed: ${error instanceof Error ? error.message : error}`);
            }
        }
        return { invite, link, emailed };
    }

    async revokeInvite(user: IdeUser, appId: string, inviteId: string) {
        await this.roleOf(user, appId, 'ADMIN');
        const { count } = await this.prisma.connectAppInvite.updateMany({ where: { id: inviteId, appId, acceptedAt: null }, data: { revokedAt: new Date() } });
        if (!count) throw fail(404, 'Invite not found.');
        return { ok: true };
    }

    async changeRole(user: IdeUser, appId: string, memberId: string, body: any) {
        await this.roleOf(user, appId, 'OWNER');
        const role = String(body?.role ?? '').toUpperCase() as Role;
        if (!ROLES.includes(role)) throw fail(400, 'Role must be OWNER, ADMIN or VIEWER.');
        const member = await this.prisma.connectAppMember.findFirst({ where: { id: memberId, appId } });
        if (!member) throw fail(404, 'Member not found.');
        if (member.role === 'OWNER' && role !== 'OWNER') await this.assertNotLastOwner(appId);
        return this.prisma.connectAppMember.update({ where: { id: memberId }, data: { role } });
    }

    async removeMember(user: IdeUser, appId: string, memberId: string) {
        const myRole = await this.roleOf(user, appId, 'VIEWER');
        const member = await this.prisma.connectAppMember.findFirst({ where: { id: memberId, appId } });
        if (!member) throw fail(404, 'Member not found.');

        const self = member.userId === user.id;
        if (!self) {
            if (myRole === 'VIEWER') throw fail(403, 'Only admins and owners can remove people.');
            if (member.role === 'OWNER' && myRole !== 'OWNER') throw fail(403, 'Only owners can remove an owner.');
        }
        if (member.role === 'OWNER') await this.assertNotLastOwner(appId);
        await this.prisma.connectAppMember.delete({ where: { id: memberId } });
        return { ok: true };
    }

    async previewInvite(user: IdeUser, token: string) {
        const invite = await this.findInvite(token);
        const [app, inviter, member] = await Promise.all([
            this.prisma.connectApp.findUnique({ where: { id: invite.appId }, select: { id: true, name: true, logoUrl: true } }),
            this.prisma.user.findUnique({ where: { id: invite.invitedById }, select: { name: true } }),
            this.prisma.connectAppMember.findUnique({ where: { appId_userId: { appId: invite.appId, userId: user.id } } }),
        ]);
        return {
            app,
            role: invite.role,
            email: invite.email,
            invitedBy: inviter?.name ?? 'Someone',
            expiresAt: invite.expiresAt,
            alreadyMember: !!member,
            status: invite.acceptedAt ? 'accepted' : invite.revokedAt ? 'revoked' : invite.expiresAt < new Date() ? 'expired' : 'pending',
        };
    }

    async acceptInvite(user: IdeUser, token: string) {
        const invite = await this.findInvite(token);
        if (invite.acceptedAt) throw fail(410, 'This invite was already used.');
        if (invite.revokedAt) throw fail(410, 'This invite was revoked.');
        if (invite.expiresAt < new Date()) throw fail(410, 'This invite has expired. Ask for a new one.');

        const claimed = await this.prisma.connectAppInvite.updateMany({
            where: { id: invite.id, acceptedAt: null },
            data: { acceptedAt: new Date(), acceptedById: user.id },
        });
        if (!claimed.count) throw fail(410, 'This invite was already used.');

        const existing = await this.prisma.connectAppMember.findUnique({ where: { appId_userId: { appId: invite.appId, userId: user.id } } });
        if (!existing) {
            await this.prisma.connectAppMember.create({ data: { appId: invite.appId, userId: user.id, role: invite.role } });
        } else if (RANK[invite.role] > RANK[existing.role]) {
            await this.prisma.connectAppMember.update({ where: { id: existing.id }, data: { role: invite.role } });
        }
        return { appId: invite.appId };
    }

    // ------------------------------------------------------------- helpers

    private async roleOf(user: IdeUser, appId: string, needed: Role): Promise<Role> {
        const member = await this.prisma.connectAppMember.findUnique({ where: { appId_userId: { appId, userId: user.id } } });
        if (!member) throw fail(404, 'App not found.');
        if (RANK[member.role] < RANK[needed]) throw fail(403, `You need to be ${needed === 'OWNER' ? 'an owner' : 'an admin'} of this app to do that.`);
        return member.role;
    }

    private async assertNotLastOwner(appId: string) {
        const owners = await this.prisma.connectAppMember.count({ where: { appId, role: 'OWNER' } });
        if (owners <= 1) throw fail(400, 'An app needs at least one owner. Make someone else an owner first.');
    }

    private async assertUserInApp(appId: string, userId: string) {
        const found = await this.prisma.connectUser.findFirst({ where: { id: userId, appId }, select: { id: true } });
        if (!found) throw fail(404, 'User not found.');
    }

    private async findInvite(token: string) {
        if (typeof token !== 'string' || token.length < 20) throw fail(404, 'Invite not found.');
        const invite = await this.prisma.connectAppInvite.findUnique({ where: { tokenHash: hash(token) } });
        if (!invite) throw fail(404, 'Invite not found.');
        return invite;
    }

    private mailer(): Mailer | null {
        if (this.mailerCache === undefined) {
            try {
                this.mailerCache = mailerFromEnv();
            } catch {
                this.mailerCache = null;
            }
        }
        return this.mailerCache;
    }

    private appView(app: any) {
        return {
            id: app.id,
            name: app.name,
            logoUrl: app.logoUrl,
            allowedOrigins: app.allowedOrigins,
            loginMethods: app.loginMethods,
            googleClientId: app.googleClientId,
            mainnetEnabled: app.mainnetEnabled,
            createdAt: app.createdAt,
            updatedAt: app.updatedAt,
        };
    }

    private userView(u: any) {
        return {
            id: u.id,
            displayName: u.displayName,
            embeddedWallets: u.embeddedWallets,
            identities: u.identities.map((i: any) => ({ kind: i.kind, value: i.kind === 'GOOGLE' ? i.label : i.value, label: i.kind === 'WALLET' ? i.label : null })),
            wallets: u.wallets,
            passkeyCount: u._count?.passkeys ?? 0,
            txSigned: u._count?.signatures ?? 0,
            lastLoginAt: u.lastLoginAt,
            createdAt: u.createdAt,
        };
    }
}
