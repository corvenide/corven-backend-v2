// apps/connect-service/src/dashboard/ide-user.guard.ts
//
// The Connect dashboard uses the developer's Corven account session: an IDE access token (signed by auth-service with
// JWT_SECRET, `typ: 'access'`). Connect only verifies these tokens; it never
// issues them.

import { CanActivate, createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { PrismaService } from '@app/prisma';

import { fail } from '../http/errors';

export interface IdeUser {
    id: string;
    name: string;
    email: string | null;
}

@Injectable()
export class IdeUserGuard implements CanActivate {
    private readonly jwt = new JwtService({});

    constructor(private readonly prisma: PrismaService) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();
        const secret = process.env.JWT_SECRET;
        if (!secret) throw fail(503, 'The dashboard isn\'t set up on this server (JWT_SECRET missing).');

        const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
        if (!match) throw fail(401, 'Sign in to Corven first.', 'unauthorized');

        let payload: { sub?: string; typ?: string };
        try {
            payload = await this.jwt.verifyAsync(match[1], { secret });
        } catch {
            throw fail(401, 'Your Corven session has expired.', 'unauthorized');
        }
        if (!payload.sub || payload.typ !== 'access') throw fail(401, 'Invalid token.', 'unauthorized');

        const user = await this.prisma.user.findUnique({
            where: { id: payload.sub },
            select: { id: true, name: true, email: true, authProvider: true },
        });
        if (!user) throw fail(401, 'Your Corven account no longer exists.', 'unauthorized');

        // Guests (no sign-in) can try the IDE but can't own Connect apps.
        if (user.authProvider === 'GUEST') {
            throw fail(403, 'Connect a wallet or sign in to manage Connect apps.', 'guest');
        }

        req.ideUser = { id: user.id, name: user.name, email: user.email };
        return true;
    }
}

export const CurrentIdeUser = createParamDecorator((_: unknown, context: ExecutionContext): IdeUser => {
    return context.switchToHttp().getRequest().ideUser;
});
