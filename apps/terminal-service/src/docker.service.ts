// apps/terminal-service/src/docker.service.ts
import {
    Injectable,
    Logger,
    OnModuleInit,
} from '@nestjs/common';
import Docker from 'dockerode';

import { PrismaService } from 'libs/prisma/src/prisma.service';
import { ContainerHostRouter } from 'libs/runtime-hosts/src';

/** Execs are short-lived; remember enough of them to route resizes. */
const EXEC_HOST_LIMIT = 5_000;

@Injectable()
export class DockerService implements OnModuleInit {
    private readonly logger = new Logger(DockerService.name);

    /** Workspaces can run on several Docker hosts; find the right one per container. */
    private readonly router: ContainerHostRouter;

    /** Which host each exec was created on (exec ids are per host). */
    private readonly execHosts = new Map<string, Docker>();

    constructor(prisma: PrismaService) {
        this.router = new ContainerHostRouter(prisma);
    }

    async onModuleInit() {
        await this.router.registry.client().ping();
        this.logger.log(
            `Terminal service connected to Docker (hosts: ${this.router.registry.hosts.map((h) => h.id).join(', ')})`,
        );
    }

    async getContainer(containerId: string): Promise<Docker.Container> {
        const docker = await this.router.clientFor(containerId);
        return docker.getContainer(containerId);
    }

    async resizeExec(
        execId: string,
        cols: number,
        rows: number,
    ): Promise<void> {
        const docker = this.execHosts.get(execId) ?? this.router.registry.client();
        await docker.getExec(execId).resize({
            w: cols,
            h: rows,
        });
    }

    /** Creates an exec in a container, on whichever host runs it. */
    async createExec(
        containerId: string,
        options: Docker.ExecCreateOptions,
    ): Promise<Docker.Exec> {
        const docker = await this.router.clientFor(containerId);
        const exec = await docker.getContainer(containerId).exec(options);

        if (this.execHosts.size >= EXEC_HOST_LIMIT) {
            const oldest = this.execHosts.keys().next().value;
            if (oldest !== undefined) this.execHosts.delete(oldest);
        }
        this.execHosts.set(exec.id, docker);

        return exec;
    }

    /** Starts an exec and returns its stream. */
    async startExec(
        exec: Docker.Exec,
        options?: Docker.ExecStartOptions,
    ): Promise<NodeJS.ReadableStream> {
        const stream = await exec.start({
            hijack: true,
            stdin: false,
            ...options,
        });
        return stream;
    }

    /**
     * Demultiplex a hijacked Docker exec stream into separate stdout/stderr
     * writable streams. Docker multiplexes them with an 8-byte frame header;
     * without demuxing the 'end' event on the raw stream is unreliable.
     * (The framing is the same on every host, so any client's modem works.)
     */
    demuxStream(
        stream: NodeJS.ReadableStream,
        stdout: NodeJS.WritableStream,
        stderr: NodeJS.WritableStream,
    ): void {
        this.router.registry.client().modem.demuxStream(stream, stdout, stderr);
    }
}
