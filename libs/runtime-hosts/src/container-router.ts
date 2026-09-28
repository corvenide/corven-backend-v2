// libs/runtime-hosts/src/container-router.ts
//
// Finds the Docker host a workspace container lives on, for services that
// only know the container id (file-service, terminal-service).

import type Docker from 'dockerode';

import type { PrismaService } from '../../prisma/src/prisma.service';
import { DockerHostRegistry } from './docker-hosts';

/** Container ids never move between hosts, so the answer can be cached. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 5_000;

export class ContainerHostRouter {
    private readonly cache = new Map<string, { hostId: string | null; at: number }>();

    constructor(
        private readonly prisma: PrismaService,
        readonly registry: DockerHostRegistry = new DockerHostRegistry(),
    ) { }

    /** Docker client for the host running `containerId`. */
    async clientFor(containerId: string): Promise<Docker> {
        return this.registry.client(await this.hostIdFor(containerId));
    }

    async hostIdFor(containerId: string): Promise<string | null> {
        const cached = this.cache.get(containerId);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.hostId;

        const row = await this.prisma.workspaceContainer.findUnique({
            where: { containerId },
            select: { workspace: { select: { hostId: true } } },
        });

        // Unknown containers (and workspaces from before multi-host support)
        // are on the default host.
        const hostId = row?.workspace.hostId && this.registry.has(row.workspace.hostId)
            ? row.workspace.hostId
            : null;

        if (this.cache.size >= CACHE_LIMIT) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
        }
        this.cache.set(containerId, { hostId, at: Date.now() });

        return hostId;
    }
}
