// apps/file-service/src/docker.service.ts
import {
    Injectable,
    InternalServerErrorException,
    Logger,
    OnModuleInit,
} from '@nestjs/common';
import type { Duplex } from 'node:stream';

import { PrismaService } from '../../../libs/prisma/src/prisma.service';
import { ContainerHostRouter } from '../../../libs/runtime-hosts/src';

interface ExecuteOptions {
    containerId: string;
    command: string[];
    workingDirectory?: string;
    input?: Buffer | string;
}

interface ExecuteResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

@Injectable()
export class DockerService
    implements OnModuleInit {
    private readonly logger =
        new Logger(DockerService.name);

    /** Workspaces can run on several Docker hosts; find the right one per container. */
    private readonly router: ContainerHostRouter;

    constructor(prisma: PrismaService) {
        this.router = new ContainerHostRouter(prisma);

        this.logger.log(
            `Docker hosts: ${this.router.registry.hosts.map((h) => h.id).join(', ')}`,
        );
    }

    async onModuleInit(): Promise<void> {
        // Only the default host is checked here; other hosts may be added
        // or down, and are reached when a workspace on them is used.
        await this.router.registry.client().ping();

        this.logger.log(
            'File service connected to Docker',
        );
    }

    async execute(
        options: ExecuteOptions,
    ): Promise<ExecuteResult> {
        const docker = await this.router.clientFor(options.containerId);

        const container = docker.getContainer(
            options.containerId,
        );

        const details = await container.inspect();

        if (!details.State.Running) {
            throw new InternalServerErrorException(
                'Workspace runtime container is not running',
            );
        }

        const exec = await container.exec({
            AttachStdin: Boolean(options.input),
            AttachStdout: true,
            AttachStderr: true,
            Tty: false,
            Cmd: options.command,
            WorkingDir:
                options.workingDirectory || '/workspace',
        });

        const stream = (await exec.start({
            hijack: true,
            stdin: Boolean(options.input),
            Tty: false,
        })) as Duplex;

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        const stdout = new (require('node:stream')
            .PassThrough)();

        const stderr = new (require('node:stream')
            .PassThrough)();

        stdout.on('data', (chunk: Buffer) => {
            stdoutChunks.push(Buffer.from(chunk));
        });

        stderr.on('data', (chunk: Buffer) => {
            stderrChunks.push(Buffer.from(chunk));
        });

        docker.modem.demuxStream(
            stream,
            stdout,
            stderr,
        );

        if (options.input !== undefined) {
            stream.write(options.input);
            stream.end();
        }

        await new Promise<void>((resolve, reject) => {
            stream.on('end', resolve);
            stream.on('close', resolve);
            stream.on('error', reject);
        });

        const result = await exec.inspect();

        return {
            stdout: Buffer.concat(stdoutChunks).toString(
                'utf8',
            ),

            stderr: Buffer.concat(stderrChunks).toString(
                'utf8',
            ),

            exitCode: result.ExitCode ?? 1,
        };
    }
}