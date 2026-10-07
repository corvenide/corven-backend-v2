// apps/workspace-service/src/workspace-service.service.ts
import {
    ForbiddenException,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

import { PrismaService } from 'libs/prisma/src/prisma.service';
import { guestWorkspaceLimit, temporaryExpiresAt } from 'libs/prisma/src/temporary-workspaces';

type WithExpiry<T> = T & { expiresAt: Date | null };

function withExpiry<T extends { temporary: boolean; lastActivityAt: Date | null; createdAt: Date }>(workspace: T): WithExpiry<T> {
    return { ...workspace, expiresAt: temporaryExpiresAt(workspace) };
}

@Injectable()
export class WorkspaceService {
    constructor(
        private readonly prisma: PrismaService,

        @Inject('RUNTIME_SERVICE')
        private readonly runtimeClient: ClientProxy,
    ) { }

    async create(data: {
        userId: string;
        name: string;
        templateId?: string;
        temporary?: boolean;
        guest?: boolean;
    }) {
        // Guests only get temporary workspaces, and only a few at a time.
        if (data.guest) {
            const limit = guestWorkspaceLimit();
            const active = await this.prisma.workspace.count({
                where: { userId: data.userId, status: { not: 'DELETED' } },
            });

            if (active >= limit) {
                throw new RpcException({
                    statusCode: 403,
                    message: `Guests can have ${limit} temporary workspace${limit === 1 ? '' : 's'} at a time. Delete one, or connect a wallet to keep more.`,
                });
            }
        }

        const workspace = await this.prisma.workspace.create({
            data: {
                name: data.name,
                userId: data.userId,
                templateId: data.templateId,
                temporary: data.guest ? true : data.temporary === true,
                status: 'PENDING',
            },
        });

        return withExpiry(workspace);
    }

    /** Keep a workspace (temporary=false) or let it expire (temporary=true). */
    async setTemporary(data: { userId: string; workspaceId: string; temporary: boolean; guest?: boolean }) {
        await this.findOne(data.userId, data.workspaceId);

        if (data.guest && !data.temporary) {
            throw new RpcException({ statusCode: 403, message: 'Connect a wallet or sign in to keep this workspace.' });
        }

        const workspace = await this.prisma.workspace.update({
            where: { id: data.workspaceId },
            // Making it temporary again starts the clock from now.
            data: data.temporary ? { temporary: true, lastActivityAt: new Date() } : { temporary: false },
        });

        return withExpiry(workspace);
    }

    async findMine(userId: string) {
        const workspaces = await this.prisma.workspace.findMany({
            where: {
                userId,
                status: {
                    not: 'DELETED',
                },
            },
            orderBy: {
                createdAt: 'desc',
            },
        });

        return workspaces.map(withExpiry);
    }

    async findOne(userId: string, workspaceId: string) {
        const workspace = await this.prisma.workspace.findUnique({
            where: {
                id: workspaceId,
            },
            include: {
                containers: true,
            },
        });

        if (!workspace || workspace.status === 'DELETED') {
            throw new NotFoundException('Workspace not found');
        }

        if (workspace.userId !== userId) {
            throw new ForbiddenException(
                'You do not own this workspace',
            );
        }

        return withExpiry(workspace);
    }

    async start(userId: string, workspaceId: string) {
        await this.findOne(userId, workspaceId);

        return firstValueFrom(
            this.runtimeClient
                .send(
                    { cmd: 'runtime.start' },
                    {
                        userId,
                        workspaceId,
                    },
                )
                .pipe(timeout(30_000))
        );
    }

    async stop(userId: string, workspaceId: string) {
        await this.findOne(userId, workspaceId);

        return firstValueFrom(
            this.runtimeClient
                .send(
                    { cmd: 'runtime.stop' },
                    {
                        userId,
                        workspaceId,
                    },
                )
                .pipe(timeout(30000)),
        );
    }

    async getStatus(userId: string, workspaceId: string) {
        await this.findOne(userId, workspaceId);

        return firstValueFrom(
            this.runtimeClient
                .send(
                    { cmd: 'runtime.status' },
                    {
                        userId,
                        workspaceId,
                    },
                )
                .pipe(timeout(30000)),
        );
    }

    async delete(userId: string, workspaceId: string) {
        await this.findOne(userId, workspaceId);

        return firstValueFrom(
            this.runtimeClient
                .send(
                    { cmd: 'runtime.delete' },
                    {
                        userId,
                        workspaceId,
                    },
                )
                .pipe(timeout(60000)),
        );
    }
}