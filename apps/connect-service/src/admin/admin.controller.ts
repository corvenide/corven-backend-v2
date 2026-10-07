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
import { createHash, timingSafeEqual } from 'node:crypto';

import { PrismaService } from '@app/prisma';

import { AppRegistry } from '../http/app-registry.service';
import { appFields, newAppId } from '../http/app-fields';
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
        const id = newAppId();
        const app = await this.prisma.connectApp.create({ data: { id, ...(appFields(body, false) as any) } });
        this.registry.invalidate();
        return app;
    }

    /** Body: { userId (Corven IDE user id), role? }: gives an IDE account access to the app in the dashboard. */
    @Post(':id/members')
    async addMember(@Param('id') id: string, @Body() body: any) {
        const userId = String(body?.userId ?? '').trim();
        const role = ['OWNER', 'ADMIN', 'VIEWER'].includes(body?.role) ? body.role : 'OWNER';
        if (!(await this.prisma.connectApp.findUnique({ where: { id } }))) throw fail(404, 'No app with that id.');
        if (!(await this.prisma.user.findUnique({ where: { id: userId } }))) throw fail(404, 'No Corven user with that id.');
        return this.prisma.connectAppMember.upsert({
            where: { appId_userId: { appId: id, userId } },
            create: { appId: id, userId, role },
            update: { role },
        });
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
