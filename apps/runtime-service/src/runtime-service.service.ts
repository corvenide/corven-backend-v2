// apps/runtime-service/src/runtime-service.service.ts

import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { RpcException } from '@nestjs/microservices';

import {
    RuntimeContainerStatus,
    RuntimeContainerType,
    WorkspaceStatus,
} from 'src/generated/prisma/enums';

import { PrismaService } from 'libs/prisma/src/prisma.service';
import { recordWorkspaceActivity } from 'libs/prisma/src/workspace-activity';

import { BuildCacheService } from './build-cache.service';
import { DockerService, type DockerClient } from './docker/docker.service';
import { readDevnetInfo } from './devnet-info';
import { HostScheduler } from './host-scheduler';
import { RuntimePool, type PoolEntry } from './runtime-pool';
import {
    DEFAULT_TEMPLATE_ID,
    resolveTemplate,
    type WorkspaceTemplate,
} from 'libs/prisma/src/workspace-templates';
import { WorkspaceFileSync } from './workspace-file-sync.service';

import type {
    DeleteWorkspacePayload,
    StartWorkspacePayload,
    StopWorkspacePayload,
    WorkspaceStatusPayload,
} from './runtime.types';

interface InitializeProjectOptions {
    runtimeContainerId: string;
    projectName: string;
    /** Template to copy (see libs/prisma/src/workspace-templates.ts). */
    templateId: string;
    /** Main contract; generated if the project doesn't have it. */
    contractName: string;
}

type WorkspaceWithContainers = Awaited<ReturnType<RuntimeServiceService['getWorkspace']>>;

/** A start with no progress for this long is considered abandoned. */
const PROVISION_STALE_MS = 10 * 60 * 1000;

/** DNS name of a workspace's CKB node on its own network. */
const CKB_NODE_ALIAS = 'ckb-node';

/** Network that idle pool containers sit on until they are claimed. */
const POOL_NETWORK = 'fiberdev-pool-network';

/** How often host checks, idle checks, snapshots and pool top-ups run. */
const MAINTENANCE_INTERVAL_MS = 60 * 1000;

/** Leftovers of workspaces that moved to another host are removed this often. */
const REAP_EVERY_TICKS = 10;

/** Refresh a running workspace's file copy at most this often. */
const SNAPSHOT_INTERVAL_MS = 3 * 60 * 1000;

/** Longest a stop waits for the final file snapshot. */
const STOP_SNAPSHOT_TIMEOUT_MS = 20 * 1000;

/** Names of containers created for a workspace: fiberdev-<workspace id>-<role>. */
const WORKSPACE_CONTAINER_NAME = /^fiberdev-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(runtime|ckb)$/;

/** Thrown when a workspace is stopped or deleted while it is starting. */
class ProvisioningCancelled extends Error {}

@Injectable()
export class RuntimeServiceService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(
        RuntimeServiceService.name,
    );

    /** One pool of pre-warmed runtime containers per host. */
    private readonly pools = new Map<string, RuntimePool>();
    private maintenanceTimer?: NodeJS.Timeout;
    private maintaining = false;
    private maintenanceTicks = 0;

    /** Workspaces whose devnet is being created right now. */
    private readonly devnetStarting = new Set<string>();

    constructor(
        private readonly prisma: PrismaService,
        private readonly docker: DockerService,
        private readonly fileSync: WorkspaceFileSync,
        private readonly scheduler: HostScheduler,
        private readonly buildCache: BuildCacheService,
    ) { }

    async health() {
        await this.docker.ping();

        return {
            service: 'runtime-service',
            status: 'ok',
            timestamp: new Date().toISOString(),
            hosts: await this.scheduler.summary(),
        };
    }

    /** Docker client for the host a workspace lives on. */
    private clientFor(workspace: { hostId: string | null }): DockerClient {
        return this.docker.on(workspace.hostId);
    }

    private poolFor(hostId: string): RuntimePool {
        let pool = this.pools.get(hostId);

        if (!pool) {
            const client = this.docker.on(hostId);
            pool = new RuntimePool({
                size: this.poolSize,
                create: () => this.createPoolEntry(client),
                discard: (entry) => this.discardPoolEntry(client, entry),
                logger: {
                    log: (message: string) => this.logger.log(`[${hostId}] ${message}`),
                    warn: (message: string) => this.logger.warn(`[${hostId}] ${message}`),
                },
            });
            this.pools.set(hostId, pool);
        }

        return pool;
    }

    /**
     * Starts a workspace without waiting for it to be ready.
     *
     * The caller gets the current status back immediately (status
     * PROVISIONING) and polls `runtime.status` for progress. The containers
     * are provisioned in the background by `provision()`.
     */
    async startWorkspace(
        input: StartWorkspacePayload,
    ) {
        const workspace = await this.getWorkspace(
            input.workspaceId,
            input.userId,
        );

        if (workspace.status === WorkspaceStatus.DELETED) {
            throw new RpcException(
                'Deleted workspace cannot be started',
            );
        }

        // Claim the workspace in a single conditional update, so two
        // concurrent start requests can never both provision it. A
        // PROVISIONING workspace that has made no progress for a long time
        // is treated as abandoned and can be claimed again.
        const claimed = await this.prisma.workspace.updateMany({
            where: {
                id: workspace.id,
                OR: [
                    {
                        status: {
                            in: [
                                WorkspaceStatus.PENDING,
                                WorkspaceStatus.STOPPED,
                                WorkspaceStatus.FAILED,
                                WorkspaceStatus.IDLE,
                            ],
                        },
                    },
                    {
                        status: WorkspaceStatus.PROVISIONING,
                        updatedAt: {
                            lt: new Date(Date.now() - PROVISION_STALE_MS),
                        },
                    },
                ],
            },
            data: {
                status: WorkspaceStatus.PROVISIONING,
                provisionStage: 'preparing',
                provisionError: null,
            },
        });

        if (claimed.count === 1) {
            this.logger.log(`Provisioning workspace ${workspace.id}`);

            // Deliberately not awaited: the request returns now and the
            // provisioning continues in the background.
            void this.provision(workspace.id, workspace.userId);
        }

        return this.getWorkspaceStatus({
            workspaceId: workspace.id,
            userId: workspace.userId,
        });
    }

    /**
     * Brings a claimed workspace up. Runs in the background; progress and
     * failures are written to the workspace row for clients to poll.
     */
    private async provision(
        workspaceId: string,
        userId: string,
    ): Promise<void> {
        const startedAt = Date.now();
        const created: string[] = [];
        let docker: DockerClient | null = null;

        try {
            let workspace = await this.getWorkspace(workspaceId, userId);

            // -- 0. Host ---------------------------------------------------------
            const placement = await this.scheduler.place({
                id: workspace.id,
                hostId: workspace.hostId,
                runtimeVolume: workspace.runtimeVolume,
                ckbDataVolume: workspace.ckbDataVolume,
                filesSnapshotAt: workspace.filesSnapshotAt,
                containerCount: workspace.containers.length,
            });

            if (placement.movedFrom) {
                await this.leaveHost(workspace, placement.movedFrom);
                workspace = await this.getWorkspace(workspaceId, userId);
            }

            const client = this.docker.on(placement.hostId);
            docker = client;

            const safeWorkspaceId = this.safeName(workspace.id);

            const networkName =
                workspace.runtimeNetwork ??
                `fiberdev-${safeWorkspaceId}-network`;

            const runtimeContainerName = `fiberdev-${safeWorkspaceId}-runtime`;

            // -- 1. Network ----------------------------------------------------
            await client.createNetwork(networkName);
            await this.buildCache.attach(client, networkName);

            // -- 2. Runtime container -------------------------------------------
            // A workspace that has never run gets a pre-warmed container from
            // its host's pool when one is ready. Otherwise (or for a workspace
            // with its own volume) create one.
            const hasOwnRuntime =
                Boolean(workspace.runtimeVolume) ||
                workspace.containers.some(
                    (c) => c.type === RuntimeContainerType.FIBER_RUNTIME,
                );

            // The pool holds the default template only.
            const template = resolveTemplate(workspace.templateId);

            const pooled = hasOwnRuntime || template.id !== DEFAULT_TEMPLATE_ID
                ? null
                : await this.claimFromPool(client, networkName, runtimeContainerName);

            const workspaceVolume =
                pooled?.volume ??
                workspace.runtimeVolume ??
                `fiberdev-${safeWorkspaceId}-workspace`;

            await this.advance(workspace.id, 'starting', {
                runtimeNetwork: networkName,
                runtimeVolume: workspaceVolume,
            });

            let runtimeContainerId: string;

            if (pooled) {
                runtimeContainerId = pooled.containerId;
                created.push(runtimeContainerId);
            } else {
                await client.createVolume(workspaceVolume);

                const runtimeContainer = await this.createRuntimeContainer(client, {
                    workspaceId: workspace.id,
                    userId: workspace.userId,
                    networkName,
                    workspaceVolume,
                    containerName: runtimeContainerName,
                });

                runtimeContainerId = runtimeContainer.id;
                created.push(runtimeContainerId);

                await this.setContainerStatus(
                    workspace.id,
                    RuntimeContainerType.FIBER_RUNTIME,
                    RuntimeContainerStatus.STARTING,
                );

                await client.startContainer(runtimeContainerId);
                await client.waitForContainer(runtimeContainerId);
            }

            await this.saveContainerRecord(client, {
                workspaceId: workspace.id,
                containerId: runtimeContainerId,
                name: runtimeContainerName,
                image: this.runtimeImage,
                type: RuntimeContainerType.FIBER_RUNTIME,
                status: RuntimeContainerStatus.RUNNING,
            });

            // -- 3. Project files ------------------------------------------------
            await this.advance(workspace.id, 'project');

            await this.initializeProject(client, {
                runtimeContainerId,
                projectName: this.defaultProjectName,
                templateId: template.id,
                contractName: this.mainContractFor(template),
            });

            if (placement.movedFrom) {
                // New host: rebuild the files from the database copy.
                await this.fileSync.restoreCopy(workspace.id, runtimeContainerId, client);
            } else {
                // Edits made in the editor while the workspace was stopped.
                await this.fileSync.applyOffline(workspace.id, runtimeContainerId, client);
            }

            // -- 4. Ready ----------------------------------------------------------
            const finished = await this.prisma.workspace.updateMany({
                where: {
                    id: workspace.id,
                    status: WorkspaceStatus.PROVISIONING,
                },
                data: {
                    status: WorkspaceStatus.RUNNING,
                    provisionStage: null,
                    provisionError: null,
                    lastStartedAt: new Date(),
                    lastActivityAt: new Date(),
                },
            });

            if (finished.count === 0) {
                throw new ProvisioningCancelled();
            }

            this.logger.log(
                `Workspace ${workspace.id} ready on ${client.hostId} in ${Date.now() - startedAt}ms${pooled ? ' (from pool)' : ''}${placement.movedFrom ? ` (moved from ${placement.movedFrom})` : ''}`,
            );

            // Catch offline edits saved between the apply above and RUNNING,
            // then take the first snapshot so the editor works if it stops.
            void this.fileSync
                .applyOffline(workspace.id, runtimeContainerId, client)
                .then(() => this.fileSync.snapshot(workspace.id, runtimeContainerId, client))
                .catch(() => undefined);

            if (this.devnetMode === 'eager') {
                void this.bringUpDevnet(workspace.id, workspace.userId).catch(() => undefined);
            }
        } catch (error) {
            if (error instanceof ProvisioningCancelled) {
                if (docker) await this.cleanUpCancelled(docker, workspaceId, created);
                return;
            }

            const message =
                error instanceof RpcException
                    ? String(error.getError())
                    : error instanceof Error
                      ? error.message
                      : 'Workspace provisioning failed';

            this.logger.error(
                `Failed to start workspace ${workspaceId}: ${message}`,
            );

            await this.prisma.workspace
                .updateMany({
                    where: {
                        id: workspaceId,
                        status: WorkspaceStatus.PROVISIONING,
                    },
                    data: {
                        status: WorkspaceStatus.FAILED,
                        provisionStage: null,
                        provisionError: message.slice(0, 1000),
                    },
                })
                .catch(() => undefined);

            await this.markFailedContainers(workspaceId).catch(() => undefined);
        }
    }

    /**
     * The workspace is moving to another host. Forget its containers and
     * volumes on the old one (removing them now if that host is reachable,
     * otherwise the reaper removes them when it's back) and queue its whole
     * file copy to be written on the new host.
     */
    private async leaveHost(workspace: WorkspaceWithContainers, oldHostId: string): Promise<void> {
        if (this.scheduler.isOnline(oldHostId)) {
            const old = this.docker.on(oldHostId);

            await Promise.race([
                (async () => {
                    for (const container of workspace.containers) {
                        await old.removeContainer(container.containerId).catch(() => undefined);
                    }
                    if (workspace.runtimeNetwork) {
                        await this.buildCache.detach(old, workspace.runtimeNetwork);
                        await old.removeNetwork(workspace.runtimeNetwork);
                    }
                    for (const volume of [workspace.runtimeVolume, workspace.ckbDataVolume]) {
                        if (volume) await old.removeVolume(volume).catch(() => undefined);
                    }
                })(),
                new Promise((resolve) => setTimeout(resolve, 30_000)),
            ]);
        }

        await this.prisma.$transaction([
            this.prisma.workspaceContainer.deleteMany({ where: { workspaceId: workspace.id } }),
            this.prisma.workspace.update({
                where: { id: workspace.id },
                data: { runtimeNetwork: null, runtimeVolume: null, ckbDataVolume: null },
            }),
        ]);
    }

    /**
     * Records progress. Throws ProvisioningCancelled if the workspace was
     * stopped or deleted while it was being provisioned.
     */
    private async advance(
        workspaceId: string,
        stage: 'preparing' | 'starting' | 'project',
        data: {
            runtimeNetwork?: string;
            runtimeVolume?: string;
            ckbDataVolume?: string;
        } = {},
    ): Promise<void> {
        const updated = await this.prisma.workspace.updateMany({
            where: {
                id: workspaceId,
                status: WorkspaceStatus.PROVISIONING,
            },
            data: {
                ...data,
                provisionStage: stage,
            },
        });

        if (updated.count === 0) {
            throw new ProvisioningCancelled();
        }
    }

    /** Stopped or deleted mid-start: don't leave containers running. */
    private async cleanUpCancelled(
        docker: DockerClient,
        workspaceId: string,
        containerIds: string[],
    ): Promise<void> {
        const workspace = await this.prisma.workspace.findUnique({
            where: { id: workspaceId },
        });

        this.logger.warn(
            `Provisioning of ${workspaceId} cancelled (now ${workspace?.status ?? 'gone'})`,
        );

        for (const id of containerIds) {
            try {
                if (!workspace || workspace.status === WorkspaceStatus.DELETED) {
                    await docker.removeContainer(id);
                } else {
                    await docker.stopContainer(id);
                }
            } catch {
                /* already gone */
            }
        }
    }

    /**
     * Waits for the workspace's CKB node in the background and records the
     * result. A slow or failed node doesn't fail the workspace: editing,
     * building and testing don't need it.
     */
    private async watchCkbNode(
        docker: DockerClient,
        workspaceId: string,
        containerId: string,
    ): Promise<void> {
        try {
            await docker.waitForContainer(containerId);
            await docker.waitForCkbRpc(containerId);

            await this.setContainerStatus(
                workspaceId,
                RuntimeContainerType.CKB_NODE,
                RuntimeContainerStatus.RUNNING,
            );

            this.logger.log(`CKB node ready for workspace ${workspaceId}`);
        } catch (error) {
            this.logger.warn(
                `CKB node for workspace ${workspaceId} did not become ready: ${
                    error instanceof Error ? error.message : 'unknown error'
                }`,
            );

            await this.setContainerStatus(
                workspaceId,
                RuntimeContainerType.CKB_NODE,
                RuntimeContainerStatus.FAILED,
            ).catch(() => undefined);
        }
    }

    /**
     * Provisioning runs inside this process, so a restart (a deploy, a crash,
     * or `pnpm dev` reloading after a save) abandons any start in flight.
     * Mark those workspaces FAILED so users can simply start them again.
     *
     * Assumes a single runtime-service instance. With several, move
     * provisioning onto a job queue (e.g. BullMQ) instead.
     */
    async onModuleInit(): Promise<void> {
        const interrupted = await this.prisma.workspace.updateMany({
            where: { status: WorkspaceStatus.PROVISIONING },
            data: {
                status: WorkspaceStatus.FAILED,
                provisionStage: null,
                provisionError:
                    'Start was interrupted because the runtime service restarted. Start the workspace again.',
            },
        });

        if (interrupted.count > 0) {
            this.logger.warn(
                `Marked ${interrupted.count} interrupted workspace start(s) as failed`,
            );
        }

        await this.scheduler.syncHosts();
        await this.scheduler.checkHealth();

        // Background work: host checks, idle stops, file snapshots, pool
        // top-ups, cache warming.
        this.maintenanceTimer = setInterval(
            () => void this.runMaintenance(),
            MAINTENANCE_INTERVAL_MS,
        );
        this.maintenanceTimer.unref?.();

        for (const hostId of this.scheduler.schedulableHostIds) {
            const client = this.docker.on(hostId);

            void this.adoptPool(client)
                .then(() => this.poolFor(hostId).fill())
                .catch((error) =>
                    this.logger.warn(`Runtime pool on ${hostId} unavailable: ${error instanceof Error ? error.message : error}`),
                );

            void this.warmBuildCache(client);
            void this.reapMovedWorkspaces(client).catch(() => undefined);
        }
    }

    onModuleDestroy(): void {
        if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    }

    // =====================================================================
    // Background maintenance
    // =====================================================================

    async runMaintenance(): Promise<void> {
        if (this.maintaining) return;
        this.maintaining = true;
        this.maintenanceTicks += 1;

        try {
            await this.scheduler.checkHealth();
            await this.stopIdleWorkspaces();
            await this.refreshSnapshots();

            const reap = this.maintenanceTicks % REAP_EVERY_TICKS === 0;

            for (const hostId of this.scheduler.schedulableHostIds) {
                const client = this.docker.on(hostId);

                // Pools and warming run in the background so a slow host
                // doesn't hold up the others.
                void this.poolFor(hostId).fill();
                void this.warmBuildCache(client);
                if (reap) void this.reapMovedWorkspaces(client).catch(() => undefined);
            }
        } catch (error) {
            this.logger.warn(`Maintenance failed: ${error instanceof Error ? error.message : error}`);
        } finally {
            this.maintaining = false;
        }
    }

    private warmBuildCache(client: DockerClient): Promise<void> {
        const spec = this.runtimeContainerSpec({ networkName: POOL_NETWORK, workspaceVolume: 'unused' });

        return this.buildCache.warm(client, {
            runtimeImage: this.runtimeImage,
            projectName: this.defaultProjectName,
            contractName: this.defaultContractName,
            memory: spec.memory,
            nanoCpus: spec.nanoCpus,
        });
    }

    /**
     * Removes containers (and their volumes) left on a host by workspaces
     * that have since moved to another host or been deleted, e.g. because
     * this host was unreachable when they moved.
     */
    async reapMovedWorkspaces(client: DockerClient): Promise<number> {
        const containers = await client.listContainersByLabel('fiberdev.managed=true');
        let removed = 0;

        for (const info of containers) {
            const name = (info.Names?.[0] ?? '').replace(/^\//, '');
            const match = WORKSPACE_CONTAINER_NAME.exec(name);
            if (!match) continue;

            const workspace = await this.prisma.workspace.findUnique({
                where: { id: match[1] },
                select: { hostId: true, status: true },
            });

            // Unknown ids are left alone: they may not be ours.
            if (!workspace) continue;

            const home = workspace.hostId ?? this.docker.registry.defaultHostId;
            if (home === client.hostId && workspace.status !== WorkspaceStatus.DELETED) continue;

            this.logger.log(`Removing leftover ${name} on ${client.hostId} (workspace now on ${home})`);

            await client.removeContainer(info.Id).catch(() => undefined);

            for (const mount of info.Mounts ?? []) {
                if (mount.Type === 'volume' && mount.Name?.startsWith('fiberdev-')) {
                    await client.removeVolume(mount.Name).catch(() => undefined);
                }
            }

            removed += 1;
        }

        return removed;
    }

    /** Stops running workspaces nobody has used for WORKSPACE_IDLE_MINUTES. */
    async stopIdleWorkspaces(): Promise<number> {
        if (this.idleTimeoutMs <= 0) return 0;

        const cutoff = new Date(Date.now() - this.idleTimeoutMs);

        const idleWhere = {
            status: WorkspaceStatus.RUNNING,
            OR: [
                { lastActivityAt: { lt: cutoff } },
                { lastActivityAt: null, lastStartedAt: { lt: cutoff } },
            ],
        };

        const candidates = await this.prisma.workspace.findMany({
            where: idleWhere,
            select: { id: true },
        });

        let stopped = 0;

        for (const { id } of candidates) {
            // Re-check atomically: activity may have arrived since the query.
            const claimed = await this.prisma.workspace.updateMany({
                where: { id, ...idleWhere },
                data: { status: WorkspaceStatus.IDLE },
            });

            if (claimed.count === 0) continue;

            this.logger.log(`Workspace ${id} idle; stopping`);
            await this.stopContainers(id, WorkspaceStatus.IDLE);
            stopped += 1;
        }

        return stopped;
    }

    /** Keeps the database copy of active workspaces' files fresh. */
    async refreshSnapshots(): Promise<void> {
        const running = await this.prisma.workspace.findMany({
            where: { status: WorkspaceStatus.RUNNING },
            select: {
                id: true,
                hostId: true,
                lastActivityAt: true,
                filesSnapshotAt: true,
                containers: {
                    where: { type: RuntimeContainerType.FIBER_RUNTIME },
                    select: { containerId: true },
                },
            },
        });

        const now = Date.now();

        for (const workspace of running) {
            const runtime = workspace.containers[0];
            if (!runtime) continue;

            const hostId = workspace.hostId ?? this.docker.registry.defaultHostId;
            if (!this.scheduler.isOnline(hostId)) continue;

            const snapshotAt = workspace.filesSnapshotAt?.getTime() ?? 0;
            const activityAt = workspace.lastActivityAt?.getTime() ?? 0;

            const due =
                !workspace.filesSnapshotAt ||
                (activityAt > snapshotAt && now - snapshotAt >= SNAPSHOT_INTERVAL_MS);

            if (due) {
                await this.fileSync.snapshot(workspace.id, runtime.containerId, this.clientFor(workspace));
            }
        }
    }

    // =====================================================================
    // Activity and devnet
    // =====================================================================

    /** Called by the open IDE tab about once a minute. */
    async heartbeat(payload: { workspaceId: string; userId: string }) {
        const workspace = await this.getWorkspace(payload.workspaceId, payload.userId);

        if (workspace.status === WorkspaceStatus.RUNNING) {
            await recordWorkspaceActivity(this.prisma, workspace.id, 30_000);
        }

        return { status: workspace.status };
    }

    /**
     * Starts the workspace's CKB devnet. Devnets are started on demand
     * (DEVNET_MODE=lazy, the default), since most editing, building and
     * testing never touches the chain.
     */
    async startDevnet(payload: { workspaceId: string; userId: string }) {
        const workspace = await this.getWorkspace(payload.workspaceId, payload.userId);

        if (workspace.status !== WorkspaceStatus.RUNNING) {
            throw new RpcException('Start the workspace before starting its devnet');
        }

        await recordWorkspaceActivity(this.prisma, workspace.id, 0);

        const node = workspace.containers.find((c) => c.type === RuntimeContainerType.CKB_NODE);
        const alreadyUp =
            node &&
            (node.status === RuntimeContainerStatus.RUNNING ||
                node.status === RuntimeContainerStatus.STARTING) &&
            (await this.isContainerRunning(this.clientFor(workspace), node.containerId));

        if (!alreadyUp && !this.devnetStarting.has(workspace.id)) {
            await this.bringUpDevnet(workspace.id, workspace.userId);
        }

        return this.getWorkspaceStatus(payload);
    }

    /** Stops the devnet node; the chain data is kept for the next start. */
    async stopDevnet(payload: { workspaceId: string; userId: string }) {
        const workspace = await this.getWorkspace(payload.workspaceId, payload.userId);
        const node = workspace.containers.find((c) => c.type === RuntimeContainerType.CKB_NODE);

        if (node) {
            await this.clientFor(workspace).stopContainer(node.containerId).catch(() => undefined);
            await this.setContainerStatus(workspace.id, RuntimeContainerType.CKB_NODE, RuntimeContainerStatus.STOPPED);
        }

        return this.getWorkspaceStatus(payload);
    }

    /**
     * Live facts about the workspace's devnet (tip, recent blocks, tx pool,
     * node info), read from the node's RPC inside its container, so it works
     * whichever host the workspace runs on.
     */
    async getDevnetInfo(payload: { workspaceId: string; userId: string }) {
        const workspace = await this.getWorkspace(payload.workspaceId, payload.userId);
        const node = workspace.containers.find((c) => c.type === RuntimeContainerType.CKB_NODE);

        const base = {
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            workspaceStatus: workspace.status,
            devnetMode: this.devnetMode,
        };

        if (workspace.status !== WorkspaceStatus.RUNNING) {
            return { ...base, state: 'workspace-stopped' as const, chain: null };
        }

        if (!node || node.status === RuntimeContainerStatus.STOPPED) {
            return { ...base, state: 'off' as const, chain: null };
        }

        if (node.status === RuntimeContainerStatus.FAILED) {
            return { ...base, state: 'failed' as const, chain: null };
        }

        if (node.status !== RuntimeContainerStatus.RUNNING || this.devnetStarting.has(workspace.id)) {
            return { ...base, state: 'starting' as const, chain: null };
        }

        const client = this.clientFor(workspace);

        if (!(await this.isContainerRunning(client, node.containerId))) {
            await this.setContainerStatus(workspace.id, RuntimeContainerType.CKB_NODE, RuntimeContainerStatus.STOPPED);
            return { ...base, state: 'off' as const, chain: null };
        }

        try {
            const chain = await readDevnetInfo(client, node.containerId);
            return { ...base, state: 'running' as const, chain, rpcUrl: `http://${CKB_NODE_ALIAS}:8114` };
        } catch (error) {
            this.logger.warn(
                `Devnet info for ${workspace.id} unavailable: ${error instanceof Error ? error.message : error}`,
            );
            return { ...base, state: 'starting' as const, chain: null };
        }
    }

    /**
     * Creates (or reuses) the CKB node container and starts it. Returns once
     * it is starting; readiness is tracked in the background.
     */
    private async bringUpDevnet(workspaceId: string, userId: string): Promise<void> {
        if (this.devnetStarting.has(workspaceId)) return;
        this.devnetStarting.add(workspaceId);

        try {
            const workspace = await this.getWorkspace(workspaceId, userId);
            const client = this.clientFor(workspace);
            const safeWorkspaceId = this.safeName(workspace.id);

            const networkName = workspace.runtimeNetwork ?? `fiberdev-${safeWorkspaceId}-network`;
            const ckbDataVolume = workspace.ckbDataVolume ?? `fiberdev-${safeWorkspaceId}-ckb-data`;

            await client.createVolume(ckbDataVolume);

            if (!workspace.ckbDataVolume) {
                await this.prisma.workspace.update({
                    where: { id: workspace.id },
                    data: { ckbDataVolume },
                });
            }

            const container = await this.createCkbContainer(client, {
                workspaceId: workspace.id,
                networkName,
                ckbDataVolume,
                containerName: `fiberdev-${safeWorkspaceId}-ckb`,
            });

            await this.setContainerStatus(
                workspace.id,
                RuntimeContainerType.CKB_NODE,
                RuntimeContainerStatus.STARTING,
            );

            await client.startContainer(container.id);

            void this.watchCkbNode(client, workspace.id, container.id).finally(() =>
                this.devnetStarting.delete(workspaceId),
            );
        } catch (error) {
            this.devnetStarting.delete(workspaceId);

            await this.setContainerStatus(
                workspaceId,
                RuntimeContainerType.CKB_NODE,
                RuntimeContainerStatus.FAILED,
            ).catch(() => undefined);

            throw error;
        }
    }

    private async isContainerRunning(docker: DockerClient, containerId: string): Promise<boolean> {
        try {
            const details = await docker.inspectContainer(containerId);
            return Boolean(details.State.Running);
        } catch {
            return false;
        }
    }

    // =====================================================================
    // Runtime pool (one per host)
    // =====================================================================

    /**
     * Takes a pre-warmed runtime container from the host's pool and moves it
     * onto the workspace's network under the workspace's container name.
     * Returns null when the pool is empty or the hand-over fails.
     */
    private async claimFromPool(
        docker: DockerClient,
        networkName: string,
        containerName: string,
    ): Promise<PoolEntry | null> {
        const pool = this.poolFor(docker.hostId);
        const entry = pool.take();
        if (!entry) return null;

        try {
            if (!(await this.isContainerRunning(docker, entry.containerId))) {
                throw new Error('pool container is not running');
            }

            await docker.connectToNetwork(networkName, entry.containerId);
            await docker.disconnectFromNetwork(POOL_NETWORK, entry.containerId);
            await docker.renameContainer(entry.containerId, containerName);

            return entry;
        } catch (error) {
            this.logger.warn(
                `Could not use pool container ${entry.containerName}: ${error instanceof Error ? error.message : error}`,
            );
            await this.discardPoolEntry(docker, entry).catch(() => undefined);
            return null;
        } finally {
            void pool.fill();
        }
    }

    /** Creates one ready-to-claim runtime container with the project copied in. */
    private async createPoolEntry(docker: DockerClient): Promise<PoolEntry> {
        const id = randomBytes(5).toString('hex');
        const containerName = `fiberdev-pool-${id}-runtime`;
        const volume = `fiberdev-pool-${id}-workspace`;

        await docker.createNetwork(POOL_NETWORK);
        await this.buildCache.attach(docker, POOL_NETWORK);
        await docker.createVolume(volume);

        const container = await docker.createContainer({
            ...this.runtimeContainerSpec({ networkName: POOL_NETWORK, workspaceVolume: volume }),
            name: containerName,
            workspaceId: 'pool',
            containerType: RuntimeContainerType.FIBER_RUNTIME,
            labels: { 'fiberdev.pool': 'true', 'fiberdev.pool-volume': volume },
        });

        const entry: PoolEntry = { containerId: container.id, containerName, volume };

        try {
            await docker.startContainer(container.id);
            await docker.waitForContainer(container.id);

            await this.initializeProject(docker, {
                runtimeContainerId: container.id,
                projectName: this.defaultProjectName,
                templateId: DEFAULT_TEMPLATE_ID,
                contractName: this.defaultContractName,
            });

            return entry;
        } catch (error) {
            await this.discardPoolEntry(docker, entry).catch(() => undefined);
            throw error;
        }
    }

    private async discardPoolEntry(docker: DockerClient, entry: PoolEntry): Promise<void> {
        await docker.removeContainer(entry.containerId).catch(() => undefined);
        await docker.removeVolume(entry.volume).catch(() => undefined);
    }

    /**
     * Picks up pool containers left by a previous run of this service (for
     * example after `pnpm dev` reloads it), so they aren't wasted. Claimed
     * containers are renamed, and are also recorded in the database; both are
     * checked so a workspace's container is never mistaken for a pool one.
     */
    private async adoptPool(docker: DockerClient): Promise<void> {
        const found = await docker.listContainersByLabel('fiberdev.pool=true');
        if (!found.length) return;

        const claimed = new Set(
            (
                await this.prisma.workspaceContainer.findMany({
                    where: { containerId: { in: found.map((c) => c.Id) } },
                    select: { containerId: true },
                })
            ).map((c) => c.containerId),
        );

        const adoptable: PoolEntry[] = [];

        for (const info of found) {
            const name = (info.Names?.[0] ?? '').replace(/^\//, '');
            const volume = info.Labels?.['fiberdev.pool-volume'];

            if (claimed.has(info.Id) || !name.startsWith('fiberdev-pool-') || !volume) continue;

            const entry: PoolEntry = { containerId: info.Id, containerName: name, volume };

            const ready =
                info.State === 'running' &&
                (
                    await docker
                        .executeCommand({
                            containerId: info.Id,
                            command: ['test', '-f', `/workspace/${this.defaultProjectName}/.fiberdev-initialized`],
                            workingDirectory: '/',
                        })
                        .catch(() => ({ exitCode: 1 }))
                ).exitCode === 0;

            if (ready) {
                adoptable.push(entry);
            } else {
                await this.discardPoolEntry(docker, entry);
            }
        }

        this.poolFor(docker.hostId).adopt(adoptable);
    }

    // =====================================================================
    // Stop, status, delete
    // =====================================================================

    async stopWorkspace(
        payload: StopWorkspacePayload,
    ) {
        const workspace = await this.getWorkspace(
            payload.workspaceId,
            payload.userId,
        );

        await this.stopContainers(workspace.id, WorkspaceStatus.STOPPED);

        this.logger.log(`Workspace ${workspace.id} stopped`);

        return this.getWorkspaceRuntime(workspace.id);
    }

    /**
     * Saves a final file snapshot (so the editor keeps working while the
     * workspace is off), stops its containers, and sets its status.
     */
    private async stopContainers(
        workspaceId: string,
        finalStatus: WorkspaceStatus,
    ): Promise<void> {
        const workspace = await this.prisma.workspace.findUnique({
            where: { id: workspaceId },
            select: { hostId: true },
        });

        const hostId = workspace?.hostId ?? this.docker.registry.defaultHostId;
        const reachable = this.scheduler.isOnline(hostId);
        const docker = this.docker.on(hostId);

        const containers = await this.prisma.workspaceContainer.findMany({
            where: { workspaceId },
            orderBy: { createdAt: 'desc' },
        });

        const runtime = containers.find(
            (c) => c.type === RuntimeContainerType.FIBER_RUNTIME,
        );

        if (reachable && runtime && (await this.isContainerRunning(docker, runtime.containerId))) {
            await Promise.race([
                this.fileSync.snapshot(workspaceId, runtime.containerId, docker),
                new Promise((resolve) => setTimeout(resolve, STOP_SNAPSHOT_TIMEOUT_MS)),
            ]);
        }

        for (const container of containers) {
            try {
                if (reachable) await docker.stopContainer(container.containerId);

                await this.prisma.workspaceContainer.update({
                    where: { id: container.id },
                    data: { status: RuntimeContainerStatus.STOPPED },
                });
            } catch (error) {
                this.logger.warn(
                    `Failed to stop container ${container.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
                );

                await this.prisma.workspaceContainer
                    .update({
                        where: { id: container.id },
                        data: { status: RuntimeContainerStatus.FAILED },
                    })
                    .catch(() => undefined);
            }
        }

        await this.prisma.workspace.update({
            where: { id: workspaceId },
            data: {
                status: finalStatus,
                provisionStage: null,
                lastStoppedAt: new Date(),
            },
        });
    }

    async getWorkspaceStatus(
        payload: WorkspaceStatusPayload,
    ) {
        const workspace = await this.getWorkspace(
            payload.workspaceId,
            payload.userId,
        );

        const hostId = workspace.hostId ?? (workspace.containers.length ? this.docker.registry.defaultHostId : null);
        const hostOnline = hostId ? this.scheduler.isOnline(hostId) : true;
        const docker = this.clientFor(workspace);

        const containers = await this.prisma.workspaceContainer.findMany({
            where: { workspaceId: workspace.id },
            orderBy: { createdAt: 'asc' },
        });

        // Inspect each container directly: containers claimed from the pool
        // don't carry this workspace's label.
        const dockerStates = await Promise.all(
            containers.map(async (container) => {
                if (!hostOnline) return null;
                try {
                    const details = await docker.inspectContainer(container.containerId);
                    return { state: details.State.Status, status: details.State.Status };
                } catch {
                    return null;
                }
            }),
        );

        return {
            workspaceId: workspace.id,
            name: workspace.name,
            status: workspace.status,

            provisionStage: workspace.provisionStage,
            provisionError: workspace.provisionError,

            /** Server the workspace runs on (null until first start). */
            hostId,
            hostOnline,

            runtimeNetwork: workspace.runtimeNetwork,
            runtimeVolume: workspace.runtimeVolume,
            ckbDataVolume: workspace.ckbDataVolume,

            lastStartedAt: workspace.lastStartedAt,
            lastStoppedAt: workspace.lastStoppedAt,
            lastActivityAt: workspace.lastActivityAt,

            /** The editor can open files even while the runtime is off. */
            filesAvailable: Boolean(workspace.filesSnapshotAt),

            idleTimeoutMinutes: Math.round(this.idleTimeoutMs / 60_000),
            devnetMode: this.devnetMode,

            containers: containers.map((container, i) => ({
                id: container.id,
                containerId: container.containerId,
                name: container.name,
                image: container.image,
                type: container.type,
                status: container.status,
                dockerState: dockerStates[i]?.state ?? 'missing',
                dockerStatus: dockerStates[i]?.status ?? 'Container not found',
                internalPort: container.internalPort,
                hostPort: container.hostPort,
            })),
        };
    }

    async deleteWorkspace(
        payload: DeleteWorkspacePayload,
    ) {
        return this.deleteWorkspaceRuntime(
            payload.workspaceId,
            payload.userId,
            payload.deleteWorkspaceFiles ?? true,
            payload.deleteCkbData ?? true,
        );
    }

    async deleteWorkspaceRuntime(
        workspaceId: string,
        userId?: string,
        deleteWorkspaceFiles = true,
        deleteCkbData = true,
    ) {
        const workspace = await this.getWorkspace(
            workspaceId,
            userId,
        );

        const docker = this.clientFor(workspace);
        const reachable = this.scheduler.isOnline(docker.hostId);

        if (!reachable) {
            // The reaper removes the containers when the host is back.
            this.logger.warn(
                `Host ${docker.hostId} is offline; containers of ${workspace.id} will be removed when it returns`,
            );
        }

        const containers =
            await this.prisma.workspaceContainer.findMany(
                {
                    where: {
                        workspaceId: workspace.id,
                    },
                },
            );

        if (reachable) {
            for (const container of containers) {
                try {
                    await docker.removeContainer(
                        container.containerId,
                    );
                } catch (error) {
                    const message =
                        error instanceof Error
                            ? error.message
                            : 'Unknown error';

                    this.logger.warn(
                        `Failed to remove container ${container.name}: ${message}`,
                    );
                }
            }
        }

        await this.prisma.workspaceContainer.deleteMany(
            {
                where: {
                    workspaceId: workspace.id,
                },
            },
        );

        if (reachable) {
            if (workspace.runtimeNetwork) {
                await this.buildCache.detach(docker, workspace.runtimeNetwork);
                await docker.removeNetwork(
                    workspace.runtimeNetwork,
                );
            }

            if (
                deleteWorkspaceFiles &&
                workspace.runtimeVolume
            ) {
                await docker.removeVolume(
                    workspace.runtimeVolume,
                );
            }

            if (
                deleteCkbData &&
                workspace.ckbDataVolume
            ) {
                await docker.removeVolume(
                    workspace.ckbDataVolume,
                );
            }
        }

        if (deleteWorkspaceFiles) {
            await this.prisma.workspaceFile.deleteMany({
                where: { workspaceId: workspace.id },
            });
        }

        const updatedWorkspace =
            await this.prisma.workspace.update({
                where: {
                    id: workspace.id,
                },

                data: {
                    ...(deleteWorkspaceFiles ? { filesSnapshotAt: null } : {}),
                    status: WorkspaceStatus.DELETED,

                    runtimeNetwork: null,

                    runtimeVolume:
                        deleteWorkspaceFiles
                            ? null
                            : workspace.runtimeVolume,

                    ckbDataVolume:
                        deleteCkbData
                            ? null
                            : workspace.ckbDataVolume,

                    lastStoppedAt: new Date(),
                },
            });

        this.logger.log(
            `Workspace runtime ${workspace.id} deleted`,
        );

        return updatedWorkspace;
    }

    async resetWorkspace(
        workspaceId: string,
        userId?: string,
    ) {
        const workspace = await this.getWorkspace(
            workspaceId,
            userId,
        );

        await this.deleteWorkspaceRuntime(
            workspace.id,
            userId,
            true,
            true,
        );

        await this.prisma.workspace.update({
            where: {
                id: workspace.id,
            },

            data: {
                status: WorkspaceStatus.PENDING,
                runtimeNetwork: null,
                runtimeVolume: null,
                ckbDataVolume: null,
                // Nothing is left on its host, so it can be placed anywhere.
                hostId: null,
            },
        });

        return this.startWorkspace({
            workspaceId: workspace.id,
            userId: workspace.userId,
        });
    }

    async getWorkspaceRuntime(
        workspaceId: string,
        userId?: string,
    ) {
        const workspace = await this.getWorkspace(
            workspaceId,
            userId,
        );

        return this.prisma.workspace.findUnique({
            where: {
                id: workspace.id,
            },

            include: {
                containers: true,
            },
        });
    }

    async executeRuntimeCommand(
        workspaceId: string,
        command: string[],
        workingDirectory?: string,
        userId?: string,
    ) {
        const workspace = await this.getWorkspace(
            workspaceId,
            userId,
        );

        if (
            workspace.status !==
            WorkspaceStatus.RUNNING
        ) {
            throw new RpcException(
                'Workspace runtime is not running',
            );
        }

        const runtimeContainer =
            await this.prisma.workspaceContainer.findUnique(
                {
                    where: {
                        workspaceId_type: {
                            workspaceId: workspace.id,
                            type:
                                RuntimeContainerType.FIBER_RUNTIME,
                        },
                    },
                },
            );

        if (!runtimeContainer) {
            throw new RpcException(
                'Runtime container not found',
            );
        }

        await recordWorkspaceActivity(this.prisma, workspace.id);

        return this.clientFor(workspace).executeCommand({
            containerId:
                runtimeContainer.containerId,

            command,

            workingDirectory:
                workingDirectory ??
                `/workspace/${this.defaultProjectName}`,
        });
    }

    async buildProject(
        workspaceId: string,
        userId?: string,
    ) {
        return this.executeRuntimeCommand(
            workspaceId,
            ['make', 'build'],
            `/workspace/${this.defaultProjectName}`,
            userId,
        );
    }

    async testProject(
        workspaceId: string,
        userId?: string,
    ) {
        return this.executeRuntimeCommand(
            workspaceId,
            ['make', 'test'],
            `/workspace/${this.defaultProjectName}`,
            userId,
        );
    }

    async runDefaultContract(
        workspaceId: string,
        userId?: string,
    ) {
        const record = await this.prisma.workspace.findUnique({
            where: { id: workspaceId },
            select: { templateId: true },
        });
        const contract = this.mainContractFor(resolveTemplate(record?.templateId));

        return this.executeRuntimeCommand(
            workspaceId,
            [
                'ckb-debugger',
                '--bin',
                `build/release/${contract}`,
            ],
            `/workspace/${this.defaultProjectName}`,
            userId,
        );
    }

    // =====================================================================
    // Containers
    // =====================================================================

    private async createCkbContainer(
        docker: DockerClient,
        options: {
            workspaceId: string;
            networkName: string;
            ckbDataVolume: string;
            containerName: string;
        },
    ) {
        const existing =
            await docker.getContainer(
                options.containerName,
            );

        if (existing) {
            const details =
                await existing.inspect();

            await this.saveContainerRecord(docker, {
                workspaceId: options.workspaceId,
                containerId: details.Id,
                name: options.containerName,
                image: this.ckbNodeImage,

                type:
                    RuntimeContainerType.CKB_NODE,

                status: details.State.Running
                    ? RuntimeContainerStatus.RUNNING
                    : RuntimeContainerStatus.CREATED,

                internalPort: 8114,
            });

            return existing;
        }

        const container =
            await docker.createContainer({
                name: options.containerName,
                image: this.ckbNodeImage,

                networkName:
                    options.networkName,

                workspaceId:
                    options.workspaceId,

                containerType:
                    RuntimeContainerType.CKB_NODE,

                exposedPorts: [
                    '8114/tcp',
                    '28114/tcp',
                ],

                binds: [
                    `${options.ckbDataVolume}:/ckb-data`,
                ],

                // Stable name for the runtime's CKB_RPC_URL, whichever way the
                // runtime container was created.
                networkAliases: [CKB_NODE_ALIAS],

                environment: [
                    `WORKSPACE_ID=${options.workspaceId}`,
                    'HOME=/ckb-data',
                ],

                memory:
                    Number(
                        process.env
                            .CKB_NODE_MEMORY_BYTES,
                    ) ||
                    1024 * 1024 * 1024,

                nanoCpus:
                    Number(
                        process.env
                            .CKB_NODE_NANO_CPUS,
                    ) ||
                    1_000_000_000,
            });

        await this.saveContainerRecord(docker, {
            workspaceId: options.workspaceId,
            containerId: container.id,
            name: options.containerName,
            image: this.ckbNodeImage,

            type:
                RuntimeContainerType.CKB_NODE,

            status:
                RuntimeContainerStatus.CREATED,

            internalPort: 8114,
        });

        return container;
    }

    private async createRuntimeContainer(
        docker: DockerClient,
        options: {
            workspaceId: string;
            userId: string;
            networkName: string;
            workspaceVolume: string;
            containerName: string;
        },
    ) {
        const existing =
            await docker.getContainer(
                options.containerName,
            );

        if (existing) {
            const details =
                await existing.inspect();

            await this.saveContainerRecord(docker, {
                workspaceId: options.workspaceId,
                containerId: details.Id,
                name: options.containerName,
                image: this.runtimeImage,
                type: RuntimeContainerType.FIBER_RUNTIME,
                status: details.State.Running
                    ? RuntimeContainerStatus.RUNNING
                    : RuntimeContainerStatus.CREATED,
            });

            return existing;
        }

        const container = await docker.createContainer({
            ...this.runtimeContainerSpec({
                networkName: options.networkName,
                workspaceVolume: options.workspaceVolume,
            }),
            name: options.containerName,
            workspaceId: options.workspaceId,
            containerType: RuntimeContainerType.FIBER_RUNTIME,
        });

        await this.saveContainerRecord(docker, {
            workspaceId: options.workspaceId,
            containerId: container.id,
            name: options.containerName,
            image: this.runtimeImage,
            type: RuntimeContainerType.FIBER_RUNTIME,
            status: RuntimeContainerStatus.CREATED,
        });

        return container;
    }

    /**
     * Settings shared by workspace and pool runtime containers. Nothing here
     * is specific to one workspace or host, so a pooled container can be
     * handed to any workspace (the terminal service sets WORKSPACE_ID per
     * command).
     */
    private runtimeContainerSpec(options: {
        networkName: string;
        workspaceVolume: string;
    }) {
        return {
            image: this.runtimeImage,
            networkName: options.networkName,
            command: ['sh', '-c', 'while true; do sleep 3600; done'],
            workingDirectory: '/workspace',
            binds: [`${options.workspaceVolume}:/workspace`],
            environment: [
                `CKB_RPC_URL=http://${CKB_NODE_ALIAS}:8114`,
                `CKB_PROXY_RPC_URL=http://${CKB_NODE_ALIAS}:28114`,
                'CARGO_TERM_COLOR=always',
                'RUST_BACKTRACE=1',
                // Shared build cache (read-only) behind a local one.
                ...this.buildCache.runtimeEnvironment(),
            ],
            memory: Number(process.env.RUNTIME_MEMORY_BYTES) || 2 * 1024 * 1024 * 1024,
            nanoCpus: Number(process.env.RUNTIME_NANO_CPUS) || 2_000_000_000,
            pidsLimit: 1024,
        };
    }

    private async initializeProject(
        docker: DockerClient,
        options: InitializeProjectOptions,
    ): Promise<void> {
        const projectDirectory =
            `/workspace/${options.projectName}`;

        const markerFile =
            `${projectDirectory}/.fiberdev-initialized`;

        const checkMarker =
            await docker.executeCommand({
                containerId:
                    options.runtimeContainerId,

                command: [
                    'test',
                    '-f',
                    markerFile,
                ],

                workingDirectory: '/workspace',
            });

        if (checkMarker.exitCode === 0) {
            this.logger.log(
                `Workspace project ${options.projectName} is already initialized`,
            );

            return;
        }

        const checkProjectDirectory =
            await docker.executeCommand({
                containerId:
                    options.runtimeContainerId,

                command: [
                    'test',
                    '-d',
                    projectDirectory,
                ],

                workingDirectory: '/workspace',
            });

        if (checkProjectDirectory.exitCode !== 0) {
            const copied = await this.copyBakedTemplate(
                docker,
                options.runtimeContainerId,
                options.projectName,
                options.templateId,
            );

            if (!copied && options.templateId !== DEFAULT_TEMPLATE_ID) {
                throw new RpcException(
                    `This runtime image doesn't include the "${options.templateId}" template. ` +
                    'Rebuild it (docker/ckb-runtime) to use templates.',
                );
            }

            if (!copied) {
                await this.generateProjectFromGitHub(
                    docker,
                    options.runtimeContainerId,
                    options.projectName,
                );
            }
        }

        const contractDirectory =
            `${projectDirectory}/contracts/${options.contractName}`;

        const contractExists =
            await docker.executeCommand({
                containerId:
                    options.runtimeContainerId,

                command: [
                    'test',
                    '-d',
                    contractDirectory,
                ],

                workingDirectory:
                    projectDirectory,
            });

        if (contractExists.exitCode !== 0) {
            this.logger.log(
                `Generating initial contract: ${options.contractName}`,
            );

            const generateContract =
                await docker.executeCommand({
                    containerId:
                        options.runtimeContainerId,

                    command: [
                        'make',
                        'generate',
                        `CRATE=${options.contractName}`,
                    ],

                    workingDirectory:
                        projectDirectory,

                    environment: [
                        'CARGO_TERM_COLOR=always',
                    ],
                });

            if (
                generateContract.exitCode !== 0
            ) {
                throw new RpcException(
                    [
                        'CKB contract generation failed.',
                        generateContract.stderr,
                        generateContract.stdout,
                    ]
                        .filter(Boolean)
                        .join('\n'),
                );
            }
        }

        const createMarker =
            await docker.executeCommand({
                containerId:
                    options.runtimeContainerId,

                command: [
                    'touch',
                    markerFile,
                ],

                workingDirectory:
                    projectDirectory,
            });

        if (createMarker.exitCode !== 0) {
            throw new RpcException(
                `Unable to create project initialization marker: ${createMarker.stderr}`,
            );
        }

        this.logger.log(
            `Workspace project initialized: ${projectDirectory}`,
        );
    }

    /**
     * Copies the project template baked into the runtime image
     * (docker/ckb-runtime/Dockerfile) into the workspace. Takes a second or
     * two, needs no network, and ships with a warm build cache.
     *
     * Returns false when the image has no template for this project (e.g.
     * an image built before templates were baked in).
     */
    private async copyBakedTemplate(
        docker: DockerClient,
        runtimeContainerId: string,
        projectName: string,
        templateId: string,
    ): Promise<boolean> {
        // Images with templates: <dir>/<template>/<project>. Older images
        // baked only the default project, at <dir>/<project>.
        const candidates = [`${this.templateDirectory}/${templateId}/${projectName}`];
        if (templateId === DEFAULT_TEMPLATE_ID) candidates.push(`${this.templateDirectory}/${projectName}`);

        let templateDirectory: string | null = null;
        for (const candidate of candidates) {
            const hasTemplate = await docker.executeCommand({
                containerId: runtimeContainerId,
                command: ['test', '-d', candidate],
                workingDirectory: '/',
            });
            if (hasTemplate.exitCode === 0) {
                templateDirectory = candidate;
                break;
            }
        }

        if (!templateDirectory) {
            this.logger.warn(
                `No baked template ${templateId} in ${this.templateDirectory}; rebuild the runtime image to speed up workspace creation`,
            );

            return false;
        }

        const startedAt = Date.now();

        // -a keeps timestamps, which cargo uses to decide what to rebuild.
        const copy = await docker.executeCommand({
            containerId: runtimeContainerId,
            // "<dir>/." so a symlinked template directory is copied, not the link.
            command: ['sh', '-c', 'mkdir -p "$2" && cp -a "$1/." "$2/"', 'sh', templateDirectory, `/workspace/${projectName}`],
            workingDirectory: '/workspace',
        });

        if (copy.exitCode !== 0) {
            throw new RpcException(
                ['Copying the project template failed.', copy.stderr, copy.stdout]
                    .filter(Boolean)
                    .join('\n'),
            );
        }

        this.logger.log(
            `Copied baked template ${templateId}/${projectName} in ${Date.now() - startedAt}ms`,
        );

        return true;
    }

    /** Legacy path: generate the project from GitHub (slow, needs network). */
    private async generateProjectFromGitHub(
        docker: DockerClient,
        runtimeContainerId: string,
        projectName: string,
    ): Promise<void> {
        this.logger.log(`Generating CKB project from GitHub: ${projectName}`);

        const generateProject = await docker.executeCommand({
            containerId: runtimeContainerId,
            command: [
                'cargo',
                'generate',
                'gh:cryptape/ckb-script-templates',
                'workspace',
                '--name',
                projectName,
            ],
            workingDirectory: '/workspace',
            environment: ['CARGO_TERM_COLOR=always'],
        });

        if (generateProject.exitCode !== 0) {
            throw new RpcException(
                [
                    'CKB project generation failed.',
                    generateProject.stderr,
                    generateProject.stdout,
                ]
                    .filter(Boolean)
                    .join('\n'),
            );
        }
    }

    private async saveContainerRecord(
        docker: DockerClient,
        input: {
            workspaceId: string;
            containerId: string;
            name: string;
            image: string;
            type: RuntimeContainerType;
            status: RuntimeContainerStatus;
            internalPort?: number;
        },
    ) {
        let hostPort: number | null = null;

        if (input.internalPort) {
            try {
                const port =
                    await docker.getContainerPort(
                        input.containerId,
                        input.internalPort,
                    );

                hostPort = port.hostPort;
            } catch {
                hostPort = null;
            }
        }

        return this.prisma.workspaceContainer.upsert(
            {
                where: {
                    workspaceId_type: {
                        workspaceId:
                            input.workspaceId,

                        type: input.type,
                    },
                },

                update: {
                    containerId:
                        input.containerId,

                    name: input.name,
                    image: input.image,
                    status: input.status,

                    internalPort:
                        input.internalPort ?? null,

                    hostPort,
                },

                create: {
                    workspaceId:
                        input.workspaceId,

                    containerId:
                        input.containerId,

                    name: input.name,
                    image: input.image,
                    type: input.type,
                    status: input.status,

                    internalPort:
                        input.internalPort ?? null,

                    hostPort,
                },
            },
        );
    }

    private async setContainerStatus(
        workspaceId: string,
        type: RuntimeContainerType,
        status: RuntimeContainerStatus,
    ): Promise<void> {
        await this.prisma.workspaceContainer.updateMany(
            {
                where: {
                    workspaceId,
                    type,
                },

                data: {
                    status,
                },
            },
        );
    }

    private async markFailedContainers(
        workspaceId: string,
    ): Promise<void> {
        await this.prisma.workspaceContainer.updateMany(
            {
                where: {
                    workspaceId,

                    status: {
                        in: [
                            RuntimeContainerStatus.CREATED,
                            RuntimeContainerStatus.STARTING,
                        ],
                    },
                },

                data: {
                    status:
                        RuntimeContainerStatus.FAILED,
                },
            },
        );
    }

    private async getWorkspace(
        workspaceId: string,
        userId?: string,
    ) {
        const workspace =
            await this.prisma.workspace.findFirst({
                where: {
                    id: workspaceId,

                    ...(userId
                        ? {
                            userId,
                        }
                        : {}),
                },

                include: {
                    containers: true,
                },
            });

        if (!workspace) {
            throw new RpcException(
                'Workspace not found',
            );
        }

        return workspace;
    }

    private safeName(
        value: string,
    ): string {
        return value
            .toLowerCase()
            .replace(/[^a-z0-9_.-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^[-_.]+|[-_.]+$/g, '')
            .slice(0, 48);
    }

    private get ckbNodeImage(): string {
        return (
            process.env.CKB_NODE_IMAGE ??
            'fiberdev/ckb-node:dev'
        );
    }

    private get runtimeImage(): string {
        return (
            process.env.FIBER_RUNTIME_IMAGE ??
            'fiberdev/ckb-runtime:dev'
        );
    }

    /** Minutes without activity before a running workspace is stopped (0 = never). */
    private get idleTimeoutMs(): number {
        const minutes = Number(process.env.WORKSPACE_IDLE_MINUTES ?? 20);
        return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
    }

    /** lazy: devnet starts on request (default). eager: with the workspace. */
    private get devnetMode(): 'lazy' | 'eager' {
        return process.env.DEVNET_MODE === 'eager' ? 'eager' : 'lazy';
    }

    /** Ready runtime containers kept per host for new workspaces (0 disables). */
    private get poolSize(): number {
        const size = Number(process.env.RUNTIME_POOL_SIZE ?? 1);
        return Number.isFinite(size) && size > 0 ? Math.min(Math.floor(size), 10) : 0;
    }

    private get templateDirectory(): string {
        return (
            process.env.CORVEN_TEMPLATE_DIR ??
            '/opt/corven/templates'
        );
    }

    private get defaultProjectName(): string {
        return (
            process.env.DEFAULT_PROJECT_NAME ??
            'ckb-rust-script'
        );
    }

    /** The template's main contract; the default template's is configurable. */
    private mainContractFor(template: WorkspaceTemplate): string {
        return template.id === DEFAULT_TEMPLATE_ID ? this.defaultContractName : template.contracts[0];
    }

    private get defaultContractName(): string {
        return (
            process.env.DEFAULT_CONTRACT_NAME ??
            'hello-world'
        );
    }
}
