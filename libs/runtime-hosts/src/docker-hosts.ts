// libs/runtime-hosts/src/docker-hosts.ts
//
// The Docker hosts that run workspaces. Each workspace lives on one host
// (Workspace.hostId), because its volumes are local to that host.
//
// Configure with DOCKER_HOSTS, either JSON:
//
//   DOCKER_HOSTS='[
//     {"id":"local","endpoint":"unix:///var/run/docker.sock","maxWorkspaces":6},
//     {"id":"eu-1","endpoint":"tcp://10.0.0.12:2376","certPath":"/etc/corven/certs/eu-1","maxWorkspaces":20},
//     {"id":"eu-2","endpoint":"ssh://corven@10.0.0.13","maxWorkspaces":20}
//   ]'
//
// or the short form `id=endpoint,id=endpoint` (capacity from
// HOST_MAX_WORKSPACES). Without DOCKER_HOSTS there is one host, "local",
// on DOCKER_SOCKET_PATH (or Docker's default socket), so single-machine
// setups need no changes.
//
// Endpoints:
//   unix:///path/docker.sock   local socket (Colima, Docker Desktop, Linux)
//   tcp://host:2376            remote daemon; TLS when certPath is set
//                              (a directory holding ca.pem, cert.pem, key.pem)
//   ssh://user@host[:port]     remote daemon over SSH, using SSH_AUTH_SOCK

import Docker from 'dockerode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DockerHostConfig {
    /** Stable id stored on Workspace.hostId. Lowercase letters, digits, dashes. */
    id: string;
    endpoint: string;
    /** Most workspaces running (or starting) on this host at once. */
    maxWorkspaces: number;
    /** For tcp:// endpoints: directory with ca.pem, cert.pem and key.pem. */
    certPath?: string;
}

const HOST_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DEFAULT_MAX_WORKSPACES = 8;

function defaultMax(env: NodeJS.ProcessEnv): number {
    const value = Number(env.HOST_MAX_WORKSPACES);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_WORKSPACES;
}

function normaliseEndpoint(endpoint: string): string {
    const trimmed = endpoint.trim();
    // A bare path is a socket.
    return trimmed.startsWith('/') ? `unix://${trimmed}` : trimmed;
}

/** Reads the host list from the environment. Throws on invalid configuration. */
export function loadDockerHosts(env: NodeJS.ProcessEnv = process.env): DockerHostConfig[] {
    const raw = env.DOCKER_HOSTS?.trim();
    const fallbackMax = defaultMax(env);

    let hosts: DockerHostConfig[];

    if (!raw) {
        const socket = env.DOCKER_SOCKET_PATH?.trim();
        hosts = [
            {
                id: 'local',
                endpoint: socket ? normaliseEndpoint(socket) : 'default',
                maxWorkspaces: fallbackMax,
            },
        ];
    } else if (raw.startsWith('[')) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            throw new Error(`DOCKER_HOSTS is not valid JSON: ${error instanceof Error ? error.message : error}`);
        }

        if (!Array.isArray(parsed)) throw new Error('DOCKER_HOSTS must be a JSON array');

        hosts = parsed.map((item: any, index) => {
            if (!item || typeof item.id !== 'string' || typeof item.endpoint !== 'string') {
                throw new Error(`DOCKER_HOSTS[${index}] needs "id" and "endpoint"`);
            }

            const max = Number(item.maxWorkspaces ?? fallbackMax);

            return {
                id: item.id.trim(),
                endpoint: normaliseEndpoint(item.endpoint),
                maxWorkspaces: Number.isFinite(max) && max > 0 ? Math.floor(max) : fallbackMax,
                certPath: typeof item.certPath === 'string' && item.certPath ? item.certPath : undefined,
            };
        });
    } else {
        hosts = raw
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => {
                const separator = part.indexOf('=');
                if (separator <= 0) throw new Error(`DOCKER_HOSTS entry "${part}" should be id=endpoint`);

                return {
                    id: part.slice(0, separator).trim(),
                    endpoint: normaliseEndpoint(part.slice(separator + 1)),
                    maxWorkspaces: fallbackMax,
                };
            });
    }

    if (!hosts.length) throw new Error('DOCKER_HOSTS lists no hosts');

    const seen = new Set<string>();
    for (const host of hosts) {
        if (!HOST_ID.test(host.id)) {
            throw new Error(`Invalid host id "${host.id}": use lowercase letters, digits and dashes`);
        }
        if (seen.has(host.id)) throw new Error(`Duplicate host id "${host.id}" in DOCKER_HOSTS`);
        seen.add(host.id);
    }

    return hosts;
}

/** Creates a dockerode client for a host. */
export function createDockerClient(host: DockerHostConfig, env: NodeJS.ProcessEnv = process.env): Docker {
    const endpoint = host.endpoint;

    if (endpoint === 'default') return new Docker();

    if (endpoint.startsWith('unix://')) {
        return new Docker({ socketPath: endpoint.slice('unix://'.length) });
    }

    const url = new URL(endpoint);

    if (url.protocol === 'tcp:' || url.protocol === 'http:' || url.protocol === 'https:') {
        const tls = Boolean(host.certPath) || url.protocol === 'https:';
        const certs = host.certPath
            ? {
                  ca: readFileSync(join(host.certPath, 'ca.pem')),
                  cert: readFileSync(join(host.certPath, 'cert.pem')),
                  key: readFileSync(join(host.certPath, 'key.pem')),
              }
            : {};

        return new Docker({
            host: url.hostname,
            port: Number(url.port) || (tls ? 2376 : 2375),
            protocol: tls ? 'https' : 'http',
            ...certs,
        });
    }

    if (url.protocol === 'ssh:') {
        return new Docker({
            protocol: 'ssh',
            host: url.hostname,
            port: Number(url.port) || 22,
            username: decodeURIComponent(url.username) || undefined,
            sshOptions: { agent: env.SSH_AUTH_SOCK },
        } as Docker.DockerOptions);
    }

    throw new Error(`Unsupported Docker endpoint for host "${host.id}": ${endpoint}`);
}

/** The endpoint without credentials, safe to log or store. */
export function describeEndpoint(endpoint: string): string {
    if (endpoint === 'default') return 'default socket';
    if (endpoint.startsWith('unix://')) return endpoint;

    try {
        const url = new URL(endpoint);
        url.password = '';
        return url.toString().replace(/\/$/, '');
    } catch {
        return endpoint;
    }
}

/**
 * Configured hosts and one lazily created client per host. The first host
 * is the default: workspaces created before multi-host support (hostId
 * null) live there.
 */
export class DockerHostRegistry {
    private readonly clients = new Map<string, Docker>();
    private readonly byId: Map<string, DockerHostConfig>;

    constructor(readonly hosts: DockerHostConfig[] = loadDockerHosts()) {
        this.byId = new Map(hosts.map((host) => [host.id, host]));
    }

    get defaultHostId(): string {
        return this.hosts[0].id;
    }

    has(hostId: string | null | undefined): boolean {
        return Boolean(hostId && this.byId.has(hostId));
    }

    config(hostId: string): DockerHostConfig {
        const host = this.byId.get(hostId);
        if (!host) throw new Error(`Unknown workspace host "${hostId}"`);
        return host;
    }

    /** Client for a host; null/undefined means the default host. */
    client(hostId?: string | null): Docker {
        const id = hostId ?? this.defaultHostId;

        let client = this.clients.get(id);
        if (!client) {
            client = createDockerClient(this.config(id));
            this.clients.set(id, client);
        }

        return client;
    }
}
