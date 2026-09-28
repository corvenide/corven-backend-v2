// apps/runtime-service/src/host-scheduler.ts
//
// Decides which Docker host a workspace runs on.
//
//  - A new workspace goes to the online, non-draining host with the most
//    free capacity (maxWorkspaces minus workspaces running or starting there).
//  - A workspace that has run before stays on its host, because its volumes
//    are there.
//  - It moves only when it has to (its host is offline, draining, or full)
//    and it can: the database holds a copy of its files (WorkspaceFile), which
//    is restored on the new host. Build output and the devnet chain are not
//    carried over.
//
// Placement runs under a Postgres advisory lock so two starts can't both take
// the last free slot on a host, even with several runtime-service instances.

import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

import { HostStatus, WorkspaceStatus } from 'src/generated/prisma/enums';
import { PrismaService } from 'libs/prisma/src/prisma.service';
import { describeEndpoint, type DockerHostConfig } from 'libs/runtime-hosts/src';

import { DockerService } from './docker/docker.service';

/** A host is considered down after this many failed checks in a row. */
const OFFLINE_AFTER_FAILURES = 3;

const HEALTH_TIMEOUT_MS = 5_000;

/** Statuses that occupy a slot on a host. */
const ACTIVE_STATUSES = [WorkspaceStatus.PROVISIONING, WorkspaceStatus.RUNNING];

export interface HostState {
    id: string;
    endpoint: string;
    maxWorkspaces: number;
    online: boolean;
    draining: boolean;
    consecutiveFailures: number;
    cpus?: number;
    memoryBytes?: number;
    containersRunning?: number;
    lastError?: string | null;
}

export interface PlacementInput {
    id: string;
    hostId: string | null;
    runtimeVolume: string | null;
    ckbDataVolume: string | null;
    filesSnapshotAt: Date | null;
    containerCount: number;
}

export interface Placement {
    hostId: string;
    /** Set when the workspace moved and its old containers/volumes must be abandoned. */
    movedFrom?: string;
}

export interface HostCandidate {
    id: string;
    maxWorkspaces: number;
    load: number;
    containersRunning?: number;
}

/**
 * Picks the candidate with the most free slots. Ties go to the one with the
 * larger share free, then fewer running containers, then id order.
 * Exported for tests.
 */
export function pickHost(candidates: HostCandidate[]): HostCandidate | null {
    const withRoom = candidates.filter((c) => c.maxWorkspaces - c.load > 0);
    if (!withRoom.length) return null;

    return [...withRoom].sort((a, b) => {
        const freeA = a.maxWorkspaces - a.load;
        const freeB = b.maxWorkspaces - b.load;
        if (freeA !== freeB) return freeB - freeA;

        const shareA = freeA / a.maxWorkspaces;
        const shareB = freeB / b.maxWorkspaces;
        if (shareA !== shareB) return shareB - shareA;

        const busyA = a.containersRunning ?? 0;
        const busyB = b.containersRunning ?? 0;
        if (busyA !== busyB) return busyA - busyB;

        return a.id.localeCompare(b.id);
    })[0];
}

@Injectable()
export class HostScheduler {
    private readonly logger = new Logger(HostScheduler.name);
    private readonly states = new Map<string, HostState>();

    constructor(
        private readonly prisma: PrismaService,
        private readonly docker: DockerService,
    ) {
        for (const host of this.docker.registry.hosts) {
            this.states.set(host.id, this.initialState(host));
        }
    }

    private initialState(host: DockerHostConfig): HostState {
        return {
            id: host.id,
            endpoint: describeEndpoint(host.endpoint),
            maxWorkspaces: host.maxWorkspaces,
            // Optimistic until the first check says otherwise.
            online: true,
            draining: false,
            consecutiveFailures: 0,
        };
    }

    get hosts(): HostState[] {
        return [...this.states.values()];
    }

    /** Hosts that can take new work (pool containers, new workspaces). */
    get schedulableHostIds(): string[] {
        return this.hosts.filter((h) => h.online && !h.draining).map((h) => h.id);
    }

    isOnline(hostId: string): boolean {
        return this.states.get(hostId)?.online ?? false;
    }

    /** Makes the Host table match DOCKER_HOSTS and loads operator flags (draining). */
    async syncHosts(): Promise<void> {
        const configured = this.docker.registry.hosts;

        for (const host of configured) {
            const row = await this.prisma.host.upsert({
                where: { id: host.id },
                create: {
                    id: host.id,
                    endpoint: describeEndpoint(host.endpoint),
                    maxWorkspaces: host.maxWorkspaces,
                },
                update: {
                    endpoint: describeEndpoint(host.endpoint),
                    maxWorkspaces: host.maxWorkspaces,
                },
            });

            const state = this.states.get(host.id);
            if (state) state.draining = row.draining;
        }

        await this.prisma.host.updateMany({
            where: { id: { notIn: configured.map((h) => h.id) } },
            data: { status: HostStatus.OFFLINE, lastError: 'Not listed in DOCKER_HOSTS' },
        });
    }

    /**
     * Pings every host and records engine facts. A host is marked offline
     * after several failed checks in a row, and the workspaces that were
     * running there are marked failed so users can start them elsewhere.
     */
    async checkHealth(): Promise<void> {
        // Pick up draining flags changed in the database.
        const rows = await this.prisma.host.findMany({ select: { id: true, draining: true } });
        for (const row of rows) {
            const state = this.states.get(row.id);
            if (state) state.draining = row.draining;
        }

        await Promise.all(this.hosts.map((state) => this.checkHost(state)));
    }

    private async checkHost(state: HostState): Promise<void> {
        const client = this.docker.on(state.id);

        try {
            const info = await Promise.race([
                client.hostInfo(),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('health check timed out')), HEALTH_TIMEOUT_MS),
                ),
            ]);

            const wasOffline = !state.online;

            Object.assign(state, {
                online: true,
                consecutiveFailures: 0,
                cpus: info.cpus,
                memoryBytes: info.memoryBytes,
                containersRunning: info.containersRunning,
                lastError: null,
            });

            if (wasOffline) this.logger.log(`Host ${state.id} is back online`);

            await this.prisma.host.update({
                where: { id: state.id },
                data: {
                    status: HostStatus.ONLINE,
                    cpus: info.cpus,
                    memoryBytes: BigInt(info.memoryBytes),
                    containersRunning: info.containersRunning,
                    lastSeenAt: new Date(),
                    lastError: null,
                },
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            state.consecutiveFailures += 1;
            state.lastError = message;

            if (state.online && state.consecutiveFailures >= OFFLINE_AFTER_FAILURES) {
                state.online = false;
                this.logger.error(`Host ${state.id} is offline: ${message}`);
                await this.failWorkspacesOn(state.id);
            }

            await this.prisma.host
                .update({
                    where: { id: state.id },
                    data: {
                        status: state.online ? HostStatus.ONLINE : HostStatus.OFFLINE,
                        lastError: message.slice(0, 500),
                    },
                })
                .catch(() => undefined);
        }
    }

    private async failWorkspacesOn(hostId: string): Promise<void> {
        const onDefault = hostId === this.docker.registry.defaultHostId;

        const result = await this.prisma.workspace.updateMany({
            where: {
                status: { in: ACTIVE_STATUSES },
                ...(onDefault ? { OR: [{ hostId }, { hostId: null }] } : { hostId }),
            },
            data: {
                status: WorkspaceStatus.FAILED,
                provisionStage: null,
                provisionError:
                    'The server running this workspace stopped responding. Start it again to continue, on another server if needed.',
            },
        });

        if (result.count) {
            this.logger.warn(`Marked ${result.count} workspace(s) on ${hostId} as failed`);
        }
    }

    /**
     * Chooses (and records) the host for a workspace that is about to start.
     * Throws an RpcException with a user-facing message when nothing fits.
     */
    async place(workspace: PlacementInput): Promise<Placement> {
        const registry = this.docker.registry;

        const hasState =
            Boolean(workspace.runtimeVolume || workspace.ckbDataVolume) || workspace.containerCount > 0;

        // Workspaces from before multi-host support live on the default host.
        const current = workspace.hostId ?? (hasState ? registry.defaultHostId : null);
        const canMove = Boolean(workspace.filesSnapshotAt);

        return this.prisma.$transaction(async (tx) => {
            // 724001: arbitrary key for "workspace placement"; released at commit.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(724001)`;

            const grouped = await tx.workspace.groupBy({
                by: ['hostId'],
                where: { status: { in: ACTIVE_STATUSES }, id: { not: workspace.id } },
                _count: { _all: true },
            });

            const load = new Map<string, number>();
            for (const group of grouped) {
                const id = group.hostId ?? registry.defaultHostId;
                load.set(id, (load.get(id) ?? 0) + group._count._all);
            }

            const candidate = (state: HostState): HostCandidate => ({
                id: state.id,
                maxWorkspaces: state.maxWorkspaces,
                load: load.get(state.id) ?? 0,
                containersRunning: state.containersRunning,
            });

            const pickOther = (exclude: string | null) =>
                pickHost(
                    this.hosts
                        .filter((h) => h.online && !h.draining && h.id !== exclude)
                        .map(candidate),
                );

            const assign = async (hostId: string, movedFrom?: string): Promise<Placement> => {
                if (hostId !== workspace.hostId) {
                    await tx.workspace.update({ where: { id: workspace.id }, data: { hostId } });
                }
                return movedFrom ? { hostId, movedFrom } : { hostId };
            };

            // -- Brand-new workspace ------------------------------------------------
            if (!current) {
                const best = pickOther(null);
                if (!best) throw this.capacityError();
                return assign(best.id);
            }

            // -- Has a home host -----------------------------------------------------
            const home = registry.has(current) ? this.states.get(current) : undefined;

            if (home?.online) {
                const full = candidate(home).load >= home.maxWorkspaces;

                if ((home.draining || full) && canMove) {
                    const other = pickOther(home.id);
                    if (other) {
                        this.logger.log(
                            `Moving workspace ${workspace.id} from ${home.id} (${home.draining ? 'draining' : 'full'}) to ${other.id}`,
                        );
                        return assign(other.id, home.id);
                    }
                }

                // Stay, even if over the soft limit: its files are here.
                return assign(home.id);
            }

            // Home host is down or no longer configured.
            if (!canMove) {
                throw new RpcException(
                    `This workspace's server (${current}) is unavailable, and there is no saved copy of its files to move. Try again when the server is back.`,
                );
            }

            const other = pickOther(current);
            if (!other) throw this.capacityError();

            this.logger.warn(`Moving workspace ${workspace.id} off unavailable host ${current} to ${other.id}`);
            return assign(other.id, current);
        });
    }

    private capacityError(): RpcException {
        return new RpcException(
            'All workspace servers are at capacity right now. Stop a running workspace or try again in a few minutes.',
        );
    }

    /** Current load per host, for the admin/status endpoint. */
    async summary() {
        const grouped = await this.prisma.workspace.groupBy({
            by: ['hostId'],
            where: { status: { in: ACTIVE_STATUSES } },
            _count: { _all: true },
        });

        const load = new Map<string, number>();
        for (const group of grouped) {
            const id = group.hostId ?? this.docker.registry.defaultHostId;
            load.set(id, (load.get(id) ?? 0) + group._count._all);
        }

        return this.hosts.map((h) => ({
            id: h.id,
            endpoint: h.endpoint,
            online: h.online,
            draining: h.draining,
            maxWorkspaces: h.maxWorkspaces,
            activeWorkspaces: load.get(h.id) ?? 0,
            cpus: h.cpus ?? null,
            memoryBytes: h.memoryBytes ?? null,
            containersRunning: h.containersRunning ?? null,
            lastError: h.lastError ?? null,
        }));
    }
}
