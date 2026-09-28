// apps/runtime-service/src/build-cache.service.ts
//
// One shared Rust build cache per Docker host (docker/build-cache).
//
// Workspace builds use sccache with two levels (see corven-rustc-wrapper in
// the runtime image):
//   0. a local disk cache inside the workspace's runtime container;
//   1. the host's shared cache, read-only, reached as http://corven-cache:8081.
//
// The shared cache is filled only by the cache warmer: a short-lived
// container, started here, that builds every project template (contracts and
// tests) with trusted inputs and writes the results through the
// token-protected port 8082. Users' own builds never write to it, so one
// user can't plant a compilation result another user's build would use.
//
// The warmer runs once per runtime image per host (tracked with a marker file
// in the cache), so a new image re-warms automatically.
//
// Settings:
//   BUILD_CACHE=off              disable (builds use only the local cache)
//   BUILD_CACHE_IMAGE            default corven/build-cache:dev
//   BUILD_CACHE_WARM=off         don't run the warmer
//   BUILD_CACHE_WARM_CRATES      extra crates to pre-build, space separated
//                                (added to the template contract; best effort)
//   BUILD_CACHE_WRITE_TOKEN      optional; otherwise generated per host

import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import type { DockerClient } from './docker/docker.service';
import { DockerService } from './docker/docker.service';

const CACHE_CONTAINER = 'corven-build-cache';
const CACHE_VOLUME = 'corven-build-cache';
const CACHE_NETWORK = 'corven-cache-network';
const WARMER_CONTAINER = 'corven-cache-warmer';

/** DNS name of the cache on every workspace network. */
export const BUILD_CACHE_ALIAS = 'corven-cache';

/** After a failure, wait this long before trying a host again. */
const RETRY_AFTER_MS = 10 * 60 * 1000;
const WARM_RETRY_AFTER_MS = 60 * 60 * 1000;

interface HostCache {
    containerId: string;
    token: string;
}

@Injectable()
export class BuildCacheService {
    private readonly logger = new Logger(BuildCacheService.name);

    private readonly ready = new Map<string, Promise<HostCache | null>>();
    private readonly failedAt = new Map<string, number>();
    private readonly warming = new Set<string>();
    private readonly warmFailedAt = new Map<string, number>();

    constructor(private readonly docker: DockerService) { }

    get enabled(): boolean {
        return process.env.BUILD_CACHE !== 'off';
    }

    private get image(): string {
        return process.env.BUILD_CACHE_IMAGE ?? 'corven/build-cache:dev';
    }

    /**
     * sccache settings for runtime containers. Host-independent (the cache is
     * reached by its alias), so pooled containers can use them too. If the
     * cache isn't reachable, the wrapper falls back to the local cache.
     */
    runtimeEnvironment(): string[] {
        if (!this.enabled) return [];

        return [
            'SCCACHE_MULTILEVEL_CHAIN=disk,webdav',
            `SCCACHE_WEBDAV_ENDPOINT=http://${BUILD_CACHE_ALIAS}:8081/sccache`,
            'SCCACHE_WEBDAV_RW_MODE=READ_ONLY',
            'SCCACHE_MULTILEVEL_WRITE_ERROR_POLICY=ignore',
        ];
    }

    /**
     * Makes the cache reachable from `networkName` (a workspace or pool
     * network). Never throws: a missing cache only makes builds slower.
     */
    async attach(client: DockerClient, networkName: string): Promise<void> {
        if (!this.enabled) return;

        try {
            const cache = await this.ensure(client);
            if (!cache) return;

            await client.connectToNetwork(networkName, cache.containerId, [BUILD_CACHE_ALIAS]);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            // Connecting twice is fine.
            if (!/already exists|already attached|endpoint with name/i.test(message)) {
                this.logger.warn(`Could not attach build cache to ${networkName} on ${client.hostId}: ${message}`);
            }
        }
    }

    /** Disconnects the cache so the network can be removed. */
    async detach(client: DockerClient, networkName: string): Promise<void> {
        if (!this.enabled) return;
        await client.disconnectFromNetwork(networkName, CACHE_CONTAINER).catch(() => undefined);
    }

    /** Creates or starts the cache container on a host. Null if unavailable. */
    ensure(client: DockerClient): Promise<HostCache | null> {
        const hostId = client.hostId;

        const failedAt = this.failedAt.get(hostId);
        if (failedAt && Date.now() - failedAt < RETRY_AFTER_MS) return Promise.resolve(null);

        let pending = this.ready.get(hostId);
        if (!pending) {
            pending = this.startCache(client).catch((error) => {
                this.failedAt.set(hostId, Date.now());
                this.ready.delete(hostId);
                this.logger.warn(
                    `Build cache unavailable on ${hostId}: ${error instanceof Error ? error.message : error}`,
                );
                return null;
            });
            this.ready.set(hostId, pending);
        }

        return pending;
    }

    private async startCache(client: DockerClient): Promise<HostCache> {
        if (!(await client.imageId(this.image))) {
            throw new Error(
                `image ${this.image} not found; build it with: docker build -t ${this.image} docker/build-cache`,
            );
        }

        await client.createNetwork(CACHE_NETWORK);
        await client.createVolume(CACHE_VOLUME);

        const existing = await client.getContainer(CACHE_CONTAINER);

        let containerId: string;
        let token: string;

        if (existing) {
            const details = await existing.inspect();
            containerId = details.Id;
            token =
                (details.Config.Env ?? [])
                    .find((entry) => entry.startsWith('CACHE_WRITE_TOKEN='))
                    ?.slice('CACHE_WRITE_TOKEN='.length) ?? '';

            if (!details.State.Running) await client.startContainer(containerId);
        } else {
            token = process.env.BUILD_CACHE_WRITE_TOKEN?.replace(/[^A-Za-z0-9]/g, '') || randomBytes(24).toString('hex');

            const container = await client.createContainer({
                name: CACHE_CONTAINER,
                image: this.image,
                networkName: CACHE_NETWORK,
                workspaceId: 'shared',
                containerType: 'BUILD_CACHE',
                networkAliases: [BUILD_CACHE_ALIAS],
                binds: [`${CACHE_VOLUME}:/cache`],
                environment: [`CACHE_WRITE_TOKEN=${token}`],
                memory: 256 * 1024 * 1024,
                nanoCpus: 1_000_000_000,
                pidsLimit: 256,
                restartPolicy: 'unless-stopped',
                labels: { 'corven.build-cache': 'true' },
            });

            containerId = container.id;
            await client.startContainer(containerId);
        }

        if (!token) throw new Error(`${CACHE_CONTAINER} has no write token; remove the container to recreate it`);

        this.failedAt.delete(client.hostId);
        this.logger.log(`Build cache ready on ${client.hostId}`);

        return { containerId, token };
    }

    // =====================================================================
    // Warmer
    // =====================================================================

    /**
     * Fills the host's shared cache from the project template, once per
     * runtime image. Runs in the background; safe to call often.
     */
    async warm(
        client: DockerClient,
        options: { runtimeImage: string; projectName: string; contractName: string; memory: number; nanoCpus: number },
    ): Promise<void> {
        const hostId = client.hostId;

        if (!this.enabled || process.env.BUILD_CACHE_WARM === 'off' || this.warming.has(hostId)) return;

        const failedAt = this.warmFailedAt.get(hostId);
        if (failedAt && Date.now() - failedAt < WARM_RETRY_AFTER_MS) return;

        this.warming.add(hostId);

        try {
            const cache = await this.ensure(client);
            if (!cache) return;

            const imageId = await client.imageId(options.runtimeImage);
            if (!imageId) return;

            const marker = `.warmed-${imageId.replace(/^sha256:/, '').slice(0, 16)}`;

            const hasMarker = await client.executeCommand({
                containerId: cache.containerId,
                command: ['test', '-f', `/cache/sccache/${marker}`],
                workingDirectory: '/',
            });

            if (hasMarker.exitCode === 0) return;

            this.logger.log(`Warming build cache on ${hostId}`);
            const startedAt = Date.now();

            await client.removeContainer(WARMER_CONTAINER).catch(() => undefined);

            const warmer = await client.createContainer({
                name: WARMER_CONTAINER,
                image: options.runtimeImage,
                networkName: CACHE_NETWORK,
                workspaceId: 'shared',
                containerType: 'CACHE_WARMER',
                command: ['sh', '-c', 'sleep 7200'],
                workingDirectory: '/workspace',
                environment: [
                    // sccache directly (not the wrapper): a warm with no cache is pointless.
                    'RUSTC_WRAPPER=sccache',
                    `SCCACHE_WEBDAV_ENDPOINT=http://${BUILD_CACHE_ALIAS}:8082/sccache`,
                    `SCCACHE_WEBDAV_TOKEN=${cache.token}`,
                    `CORVEN_PROJECT=${options.projectName}`,
                    `CORVEN_CONTRACT=${options.contractName}`,
                    `CORVEN_WARM_CRATES=${(process.env.BUILD_CACHE_WARM_CRATES ?? '').replace(/[^A-Za-z0-9_@. -]/g, '')}`,
                    `CORVEN_MARKER=${marker}`,
                    'CARGO_TERM_COLOR=never',
                ],
                memory: options.memory,
                nanoCpus: options.nanoCpus,
                pidsLimit: 2048,
            });

            try {
                await client.startContainer(warmer.id);

                const result = await client.executeCommand({
                    containerId: warmer.id,
                    command: ['bash', '-c', WARM_SCRIPT],
                    workingDirectory: '/workspace',
                });

                if (result.exitCode !== 0) {
                    throw new Error(
                        `warmer exited with ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(-800)}`,
                    );
                }

                this.warmFailedAt.delete(hostId);
                this.logger.log(`Build cache on ${hostId} warmed in ${Math.round((Date.now() - startedAt) / 1000)}s`);
            } finally {
                await client.removeContainer(warmer.id).catch(() => undefined);
            }
        } catch (error) {
            this.warmFailedAt.set(hostId, Date.now());
            this.logger.warn(`Warming the build cache on ${hostId} failed: ${error instanceof Error ? error.message : error}`);
        } finally {
            this.warming.delete(hostId);
        }
    }
}

/**
 * Runs inside the warmer. Builds at /workspace/<project>, the same path as in
 * workspaces, so cache keys match theirs. Extra crates are best effort.
 */
const WARM_SCRIPT = String.raw`
set -euo pipefail

project="/workspace/$CORVEN_PROJECT"

# Every baked template (<dir>/<template>/<project>); older images baked only
# the default project at <dir>/<project>. (No shell brace expansions here:
# this script lives in a JS template literal.)
templates=""
for dir in "$CORVEN_TEMPLATE_DIR"/*/"$CORVEN_PROJECT"; do
    [ -d "$dir" ] && templates="$templates $dir"
done
[ -n "$templates" ] || templates="$CORVEN_TEMPLATE_DIR/$CORVEN_PROJECT"

for template in $templates; do
    echo "warm: $template"
    rm -rf "$project"
    mkdir -p "$project"
    cp -a "$template/." "$project/"
    cd "$project"
    rm -rf target build
    make build
    cargo test --no-run
    cd /workspace
done

# Extra crates, added to the default template's contract.
default="$CORVEN_TEMPLATE_DIR/hello-world/$CORVEN_PROJECT"
[ -d "$default" ] || default="$CORVEN_TEMPLATE_DIR/$CORVEN_PROJECT"
rm -rf "$project"
mkdir -p "$project"
cp -a "$default/." "$project/"
cd "$project"

for crate in $CORVEN_WARM_CRATES; do
    (
        set +e
        cp contracts/$CORVEN_CONTRACT/Cargo.toml /tmp/Cargo.toml.bak
        if cargo add -p "$CORVEN_CONTRACT" "$crate" >/dev/null 2>&1; then
            make build >/dev/null 2>&1 || echo "warm: $crate did not build for the contract target" >&2
        fi
        cp /tmp/Cargo.toml.bak contracts/$CORVEN_CONTRACT/Cargo.toml
    )
done

sccache --show-stats || true

curl -fsS -X PUT \
    -H "Authorization: Bearer $SCCACHE_WEBDAV_TOKEN" \
    --data "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$SCCACHE_WEBDAV_ENDPOINT/$CORVEN_MARKER"
`;
