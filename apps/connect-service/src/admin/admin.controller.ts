// apps/connect-service/src/admin/admin.controller.ts
//
// Registering apps that may use Corven Connect. Protected by
// CONNECT_ADMIN_TOKEN (Authorization: Bearer <token>); the routes are off
// when it isn't set.
//
//   curl -X POST https://<api>/connect/v1/admin/apps \
//     -H "Authorization: Bearer $CONNECT_ADMIN_TOKEN" -H 'content-type: application/json' \
//     -d '{"name":"My dApp","allowedOrigins":["https://mydapp.xyz","http://localhost:5173"]}'

import { Body, CanActivate, Controller, ExecutionContext, Get, Injectable, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

import { PrismaService } from '@app/prisma';

import { AppRegistry, LOGIN_METHODS, normalizeOrigin } from '../http/app-registry.service';
import { fail } from '../http/errors';

@Injectable()
export class AdminGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const expected = process.env.CONNECT_ADMIN_TOKEN ?? '';
        if (expected.length < 24) throw fail(404, 'Not found.');

        const header = String(context.switchToHttp().getRequest().headers.authorization ?? '');
        const given = header.replace(/^Bearer\s+/i, '');
        const a = createHash('sha256').update(given).digest();
        const b = createHash('sha256').update(expected).digest();
        if (!timingSafeEqual(a, b)) throw fail(401, 'Bad admin token.');
        return true;
    }
}

function appFields(body: any, partial: boolean) {
    const data: Record<string, unknown> = {};

    if (body?.name !== undefined || !partial) {
        const name = String(body?.name ?? '').trim();
        if (!name || name.length > 60) throw fail(400, 'name is required (max 60 characters).');
        data.name = name;
    }
    if (body?.allowedOrigins !== undefined || !partial) {
        const list = Array.isArray(body?.allowedOrigins) ? body.allowedOrigins : [];
        const origins = list.map((o: unknown) => normalizeOrigin(String(o)));
        if (origins.length === 0 || origins.some((o: string | null) => !o)) {
            throw fail(400, 'allowedOrigins must list origins like https://myapp.xyz (http only for localhost).');
        }
        data.allowedOrigins = [...new Set(origins)];
    }
    if (body?.loginMethods !== undefined) {
        const methods = Array.isArray(body.loginMethods) ? body.loginMethods.map((m: unknown) => String(m).toUpperCase()) : [];
        if (methods.length === 0 || methods.some((m: string) => !(LOGIN_METHODS as readonly string[]).includes(m))) {
            throw fail(400, `loginMethods must be some of ${LOGIN_METHODS.join(', ')}.`);
        }
        data.loginMethods = [...new Set(methods)];
    }
    if (body?.googleClientId !== undefined) data.googleClientId = body.googleClientId ? String(body.googleClientId).trim() : null;
    if (body?.logoUrl !== undefined) data.logoUrl = body.logoUrl ? String(body.logoUrl).trim() : null;
    if (body?.mainnetEnabled !== undefined) data.mainnetEnabled = body.mainnetEnabled === true;
    return data;
}

@Controller('v1/admin/apps')
@UseGuards(AdminGuard)
export class AdminController {
    constructor(
        private readonly prisma: PrismaService,
        private readonly registry: AppRegistry,
    ) { }

    @Get()
    list() {
        return this.prisma.connectApp.findMany({ orderBy: { createdAt: 'desc' } });
    }

    @Post()
    async create(@Body() body: any) {
        const id = `app_${randomBytes(12).toString('base64url').replace(/[-_]/g, 'x')}`;
        const app = await this.prisma.connectApp.create({ data: { id, ...(appFields(body, false) as any) } });
        this.registry.invalidate();
        return app;
    }

    @Patch(':id')
    async update(@Param('id') id: string, @Body() body: any) {
        const data = appFields(body, true);
        const updated = await this.prisma.connectApp.updateMany({ where: { id }, data });
        if (updated.count === 0) throw fail(404, 'No app with that id.');
        this.registry.invalidate();
        return this.prisma.connectApp.findUnique({ where: { id } });
    }
}
