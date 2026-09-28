// apps/terminal-service/src/terminal.service.ts
import {
    ForbiddenException,
    Inject,
    Injectable,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { Duplex } from 'stream';

import { DockerService } from './docker.service';
import { PrismaService } from 'libs/prisma/src/prisma.service';

@Injectable()
export class TerminalService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly dockerService: DockerService,

        @Inject('AUTH_SERVICE')
        private readonly authClient: ClientProxy,
    ) { }

    async verifyToken(token: string) {
        const result = await firstValueFrom(
            this.authClient
                .send(
                    { cmd: 'auth.verify' },
                    {
                        token,
                    },
                )
                .pipe(timeout(5000)),
        );

        if (!result?.valid || !result?.user) {
            throw new UnauthorizedException('Invalid token');
        }

        return result.user;
    }

    async openTerminal(
        userId: string,
        workspaceId: string,
    ): Promise<{
        stream: Duplex;
        execId: string;
    }> {
        const workspace = await this.prisma.workspace.findUnique({
            where: {
                id: workspaceId,
            },
        });

        if (!workspace) {
            throw new NotFoundException('Workspace not found');
        }

        if (workspace.userId !== userId) {
            throw new ForbiddenException(
                'You do not own this workspace',
            );
        }

        if (workspace.status !== 'RUNNING') {
            throw new ForbiddenException(
                'Workspace runtime is not running',
            );
        }

        const runtimeContainer =
            await this.prisma.workspaceContainer.findUnique({
                where: {
                    workspaceId_type: {
                        workspaceId,
                        type: 'FIBER_RUNTIME',
                    },
                },
            });

        if (!runtimeContainer) {
            throw new NotFoundException(
                'Runtime container not found',
            );
        }

        const container = await this.dockerService.getContainer(
            runtimeContainer.containerId,
        );

        const details = await container.inspect();

        if (!details.State.Running) {
            throw new ForbiddenException(
                'Runtime container is stopped',
            );
        }

        const exec = await this.dockerService.createExec(runtimeContainer.containerId, {
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Tty: true,
            Cmd: ['/bin/bash'],
            WorkingDir: '/workspace',
            Env: [
                `WORKSPACE_ID=${workspaceId}`,
                `USER_ID=${userId}`,
                'TERM=xterm-256color',
            ],
        });

        const stream = await exec.start({
            hijack: true,
            stdin: true,
            Tty: true,
        });

        return {
            stream,
            execId: exec.id,
        };
    }

    async resizeTerminal(
        execId: string,
        cols: number,
        rows: number,
    ) {
        await this.dockerService.resizeExec(
            execId,
            cols,
            rows,
        );
    }
}