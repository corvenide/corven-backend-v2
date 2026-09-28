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
import { DEFAULT_TEMPLATE_ID, findTemplate } from 'libs/prisma/src/workspace-templates';

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
    }) {
        const templateId = data.templateId || DEFAULT_TEMPLATE_ID;
        if (!findTemplate(templateId)) {
            throw new RpcException(`Unknown project template: ${templateId}`);
        }

        return this.prisma.workspace.create({
            data: {
                name: data.name,
                userId: data.userId,
                templateId,
                status: 'PENDING',
            },
        });
    }

    async findMine(userId: string) {
        return this.prisma.workspace.findMany({
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

        return workspace;
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