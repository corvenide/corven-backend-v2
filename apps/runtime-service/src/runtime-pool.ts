// apps/runtime-service/src/runtime-pool.ts
//
// A small set of runtime containers that are already running, with the
// project template copied in, waiting to be handed to a brand-new workspace.
// Claiming one skips creating and booting a container and copying the
// template, so a new workspace is ready in a second or two.
//
// Size comes from RUNTIME_POOL_SIZE (default 1; 0 disables). Pool state is
// in memory; containers left over from a previous run are re-adopted at
// startup (see RuntimeServiceService.adoptPool).

import type { Logger } from '@nestjs/common';

export interface PoolEntry {
    containerId: string;
    containerName: string;
    /** Named volume mounted at /workspace; becomes the workspace's volume. */
    volume: string;
}

interface PoolOptions {
    size: number;
    create: () => Promise<PoolEntry>;
    discard: (entry: PoolEntry) => Promise<void>;
    logger: Pick<Logger, 'log' | 'warn'>;
}

export class RuntimePool {
    private readonly ready: PoolEntry[] = [];
    private filling: Promise<void> | null = null;
    private consecutiveFailures = 0;

    constructor(private readonly options: PoolOptions) { }

    get available(): number {
        return this.ready.length;
    }

    get enabled(): boolean {
        return this.options.size > 0;
    }

    /** Removes and returns a ready container, or undefined if none. */
    take(): PoolEntry | undefined {
        return this.ready.shift();
    }

    /** Registers containers found at startup; extras beyond the size are discarded. */
    adopt(entries: PoolEntry[]): void {
        for (const entry of entries) {
            if (this.ready.length < this.options.size) {
                this.ready.push(entry);
            } else {
                void this.options.discard(entry).catch(() => undefined);
            }
        }

        if (entries.length) {
            this.options.logger.log(`Runtime pool: adopted ${Math.min(entries.length, this.options.size)} container(s)`);
        }
    }

    /**
     * Tops the pool up to its size, one container at a time so a small
     * machine isn't hit by several builds at once. Concurrent calls share
     * one run.
     */
    fill(): Promise<void> {
        if (!this.enabled) return Promise.resolve();

        this.filling ??= this.fillSequentially().finally(() => {
            this.filling = null;
        });

        return this.filling;
    }

    private async fillSequentially(): Promise<void> {
        // Back off after repeated failures (e.g. the runtime image is missing),
        // instead of retrying on every maintenance tick.
        if (this.consecutiveFailures >= 3) {
            this.consecutiveFailures -= 1;
            return;
        }

        while (this.ready.length < this.options.size) {
            try {
                const entry = await this.options.create();
                this.ready.push(entry);
                this.consecutiveFailures = 0;
                this.options.logger.log(`Runtime pool: ${this.ready.length}/${this.options.size} ready`);
            } catch (error) {
                this.consecutiveFailures += 1;
                this.options.logger.warn(
                    `Runtime pool: could not prepare a container: ${error instanceof Error ? error.message : error}`,
                );
                return;
            }
        }
    }
}
