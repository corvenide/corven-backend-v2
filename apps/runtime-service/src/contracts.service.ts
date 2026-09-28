// apps/runtime-service/src/contracts.service.ts
//
// Built contracts and their deployments.
//
//  - listContracts: binaries in build/release of the workspace project.
//  - readBinary:    a binary as base64, for wallet-signed testnet deploys
//                   (built and signed in the browser with CCC).
//  - deployDevnet:  deploys to the workspace devnet with offckb, inside the
//                   CKB node container, using offckb's pre-funded account.
//                   Deployment records live on the node's data volume, so a
//                   Type ID redeploy upgrades the same cell.
//  - recordDeployment: stores a wallet-signed testnet deploy.

import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

import {
    DeployNetwork,
    RuntimeContainerStatus,
    RuntimeContainerType,
    WorkspaceStatus,
} from 'src/generated/prisma/enums';
import { PrismaService } from 'libs/prisma/src/prisma.service';
import { recordWorkspaceActivity } from 'libs/prisma/src/workspace-activity';

import { DockerService, type DockerClient } from './docker/docker.service';

/** Largest binary we deploy (a CKB transaction must fit in a block). */
export const MAX_CONTRACT_BYTES = 500 * 1024;

/** offckb's deployment records, on the node's persistent data volume. */
const DEPLOYMENT_DIR = '/ckb-data/corven-deployments';
const UPLOAD_DIR = '/tmp/corven-deploy';

const DEPLOY_TIMEOUT_MS = 150_000;

const CONTRACT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const HEX = /^0x([0-9a-f]{2})*$/;

export interface BuiltContract {
    name: string;
    sizeBytes: number;
    /** When the binary was last built (ISO). */
    builtAt: string;
}

export interface RecordDeploymentInput {
    workspaceId: string;
    userId: string;
    network: 'testnet';
    contractName: string;
    txHash: string;
    outputIndex: number;
    codeHash: string;
    hashType: 'type' | 'data1' | 'data2' | 'data';
    typeId?: string | null;
    typeArgs?: string | null;
    dataHash: string;
    sizeBytes: number;
    capacity: string;
    deployerAddress: string;
}

/** Removes terminal colour codes from CLI output. */
function plain(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*m/g, '');
}

@Injectable()
export class ContractsService {
    private readonly logger = new Logger(ContractsService.name);

    /** Workspaces with a devnet deploy in progress. */
    private readonly deploying = new Set<string>();

    constructor(
        private readonly prisma: PrismaService,
        private readonly docker: DockerService,
    ) { }

    // ------------------------------------------------------------------ built contracts

    async listContracts(payload: { workspaceId: string; userId: string }): Promise<BuiltContract[]> {
        const { client, runtimeId } = await this.runningRuntime(payload.workspaceId, payload.userId);

        const result = await client.executeCommand({
            containerId: runtimeId,
            command: [
                'sh', '-c',
                `cd "${this.buildDirectory}" 2>/dev/null || exit 0; find . -maxdepth 1 -type f -printf '%f\\t%s\\t%T@\\n'`,
            ],
            workingDirectory: '/workspace',
        });

        return result.stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const [name, size, mtime] = line.split('\t');
                return { name, sizeBytes: Number(size), builtAt: new Date(Number(mtime) * 1000).toISOString() };
            })
            // Contract binaries have no extension (skip .debug and friends).
            .filter((c) => CONTRACT_NAME.test(c.name) && !c.name.includes('.') && c.sizeBytes > 0)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    async readBinary(payload: { workspaceId: string; userId: string; contract: string }) {
        const name = this.checkName(payload.contract);
        const { client, runtimeId } = await this.runningRuntime(payload.workspaceId, payload.userId);

        const base64 = await this.readBase64(client, runtimeId, name);
        return { name, base64, sizeBytes: Buffer.from(base64, 'base64').length };
    }

    // ------------------------------------------------------------------ devnet deploy

    async deployDevnet(payload: { workspaceId: string; userId: string; contract: string; upgradable?: boolean }) {
        const name = this.checkName(payload.contract);
        const { workspace, client, runtimeId } = await this.runningRuntime(payload.workspaceId, payload.userId);

        const node = workspace.containers.find((c) => c.type === RuntimeContainerType.CKB_NODE);
        if (!node || node.status !== RuntimeContainerStatus.RUNNING) {
            throw new RpcException('Start the devnet before deploying to it.');
        }

        if (this.deploying.has(workspace.id)) {
            throw new RpcException('A deploy is already running for this workspace.');
        }

        this.deploying.add(workspace.id);

        try {
            await recordWorkspaceActivity(this.prisma, workspace.id, 0);

            const base64 = await this.readBase64(client, runtimeId, name);
            const target = `${UPLOAD_DIR}/${name}`;

            const upload = await client.executeCommand({
                containerId: node.containerId,
                command: ['sh', '-c', `mkdir -p ${UPLOAD_DIR} && base64 -d > "$1"`, 'upload', target],
                workingDirectory: '/',
                input: base64,
            });

            if (upload.exitCode !== 0) {
                throw new RpcException(`Could not copy the contract to the devnet node: ${upload.stderr.trim()}`);
            }

            const args = ['offckb', 'deploy', '--network', 'devnet', '--target', target, '--output', DEPLOYMENT_DIR, '-y'];
            if (payload.upgradable !== false) args.push('--type-id');

            const deploy = await Promise.race([
                client.executeCommand({
                    containerId: node.containerId,
                    command: args,
                    workingDirectory: '/ckb-data',
                    environment: ['HOME=/ckb-data', 'NO_COLOR=1'],
                }),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new RpcException('The deploy took too long. Check that the devnet is producing blocks.')), DEPLOY_TIMEOUT_MS),
                ),
            ]);

            const output = plain(`${deploy.stdout}\n${deploy.stderr}`);

            if (deploy.exitCode !== 0 || !/deployed, tx hash/i.test(output)) {
                const detail = output.split('\n').filter((l) => l.trim() && !/DeprecationWarning|trace-deprecation/.test(l)).slice(-8).join('\n');
                throw new RpcException(`Deploy failed.\n${detail}`.trim());
            }

            const record = await this.readDeploymentRecord(client, node.containerId, name);
            const sizeBytes = Buffer.from(base64, 'base64').length;

            const previous = record.typeId
                ? await this.prisma.contractDeployment.findFirst({
                      where: { workspaceId: workspace.id, network: DeployNetwork.DEVNET, typeId: record.typeId },
                      orderBy: { createdAt: 'desc' },
                      select: { id: true },
                  })
                : null;

            const saved = await this.prisma.contractDeployment.create({
                data: {
                    workspaceId: workspace.id,
                    userId: workspace.userId,
                    network: DeployNetwork.DEVNET,
                    contractName: name,
                    txHash: record.txHash,
                    outputIndex: record.index,
                    codeHash: record.codeHash,
                    hashType: record.hashType,
                    typeId: record.typeId,
                    dataHash: record.dataHash,
                    sizeBytes,
                    capacity: record.capacity,
                    upgradeOfId: previous?.id ?? null,
                },
            });

            this.logger.log(`Deployed ${name} to devnet of ${workspace.id}: ${record.txHash}`);
            return saved;
        } finally {
            this.deploying.delete(workspace.id);
        }
    }

    /** Reads offckb's newest migration file and scripts.json for a contract. */
    private async readDeploymentRecord(client: DockerClient, nodeId: string, name: string) {
        const read = await client.executeCommand({
            containerId: nodeId,
            command: [
                'sh', '-c',
                'latest=$(ls -1t "$1"/devnet/"$2"/migrations/*.json 2>/dev/null | head -n 1); [ -n "$latest" ] || exit 3; cat "$latest"; printf "\\n--corven-split--\\n"; cat "$1"/scripts.json',
                'read', DEPLOYMENT_DIR, name,
            ],
            workingDirectory: '/',
        });

        if (read.exitCode !== 0) {
            throw new RpcException('The contract was deployed, but its deployment record could not be read.');
        }

        const [migrationText, scriptsText] = read.stdout.split('--corven-split--');
        const recipe = JSON.parse(migrationText)?.cell_recipes?.find((r: any) => r.name === name) ?? JSON.parse(migrationText)?.cell_recipes?.[0];
        const script = JSON.parse(scriptsText)?.devnet?.[name];

        if (!recipe?.tx_hash || !script?.codeHash) {
            throw new RpcException('The deployment record is incomplete.');
        }

        return {
            txHash: String(recipe.tx_hash),
            index: Number(recipe.index ?? 0),
            dataHash: String(recipe.data_hash),
            typeId: recipe.type_id ? String(recipe.type_id) : null,
            capacity: String(recipe.occupied_capacity ?? 0),
            codeHash: String(script.codeHash),
            hashType: String(script.hashType),
        };
    }

    // ------------------------------------------------------------------ wallet deploys

    async recordDeployment(input: RecordDeploymentInput) {
        const workspace = await this.prisma.workspace.findFirst({
            where: { id: input.workspaceId, userId: input.userId },
            select: { id: true, userId: true },
        });
        if (!workspace) throw new RpcException('Workspace not found');

        if (input.network !== 'testnet') throw new RpcException('Only testnet deployments can be recorded');

        const name = this.checkName(input.contractName);
        const lower = (v?: string | null) => (v ? v.toLowerCase() : null);

        const txHash = lower(input.txHash)!;
        const codeHash = lower(input.codeHash)!;
        const dataHash = lower(input.dataHash)!;
        const typeId = lower(input.typeId);
        const typeArgs = lower(input.typeArgs);

        if (!HASH.test(txHash) || !HASH.test(codeHash) || !HASH.test(dataHash)) throw new RpcException('Invalid hash');
        if (typeId && !HASH.test(typeId)) throw new RpcException('Invalid type id');
        if (typeArgs && !HEX.test(typeArgs)) throw new RpcException('Invalid type args');
        if (!['type', 'data', 'data1', 'data2'].includes(input.hashType)) throw new RpcException('Invalid hash type');
        if (!Number.isInteger(input.outputIndex) || input.outputIndex < 0) throw new RpcException('Invalid output index');
        if (!/^\d{1,20}$/.test(String(input.capacity))) throw new RpcException('Invalid capacity');
        if (!/^ck[bt]1[0-9a-z]{20,}$/.test(input.deployerAddress ?? '')) throw new RpcException('Invalid deployer address');

        const existing = await this.prisma.contractDeployment.findFirst({
            where: { workspaceId: workspace.id, network: DeployNetwork.TESTNET, txHash },
        });
        if (existing) return existing;

        const previous = typeId
            ? await this.prisma.contractDeployment.findFirst({
                  where: { workspaceId: workspace.id, network: DeployNetwork.TESTNET, typeId },
                  orderBy: { createdAt: 'desc' },
                  select: { id: true },
              })
            : null;

        return this.prisma.contractDeployment.create({
            data: {
                workspaceId: workspace.id,
                userId: workspace.userId,
                network: DeployNetwork.TESTNET,
                contractName: name,
                txHash,
                outputIndex: input.outputIndex,
                codeHash,
                hashType: input.hashType,
                typeId,
                typeArgs,
                dataHash,
                sizeBytes: Math.max(0, Math.floor(input.sizeBytes)),
                capacity: String(input.capacity),
                deployerAddress: input.deployerAddress,
                upgradeOfId: previous?.id ?? null,
            },
        });
    }

    async listDeployments(payload: { workspaceId: string; userId: string }) {
        const workspace = await this.prisma.workspace.findFirst({
            where: { id: payload.workspaceId, userId: payload.userId },
            select: { id: true },
        });
        if (!workspace) throw new RpcException('Workspace not found');

        return this.prisma.contractDeployment.findMany({
            where: { workspaceId: workspace.id },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });
    }

    // ------------------------------------------------------------------ helpers

    checkName(name: unknown): string {
        if (typeof name !== 'string' || !CONTRACT_NAME.test(name)) {
            throw new RpcException('Invalid contract name');
        }
        return name;
    }

    async readBase64(client: DockerClient, runtimeId: string, name: string): Promise<string> {
        const path = `${this.buildDirectory}/${name}`;

        const result = await client.executeCommand({
            containerId: runtimeId,
            command: [
                'sh', '-c',
                'f="$1"; [ -f "$f" ] || exit 3; s=$(wc -c < "$f"); [ "$s" -le "$2" ] || exit 4; base64 -w0 -- "$f"',
                'read', path, String(MAX_CONTRACT_BYTES),
            ],
            workingDirectory: '/workspace',
        });

        if (result.exitCode === 3) throw new RpcException(`No built contract named "${name}". Run a build first.`);
        if (result.exitCode === 4) throw new RpcException(`"${name}" is larger than ${MAX_CONTRACT_BYTES / 1024} KB, too big for one transaction.`);
        if (result.exitCode !== 0) throw new RpcException(`Could not read "${name}": ${result.stderr.trim()}`);

        return result.stdout.trim();
    }

    async runningRuntime(workspaceId: string, userId: string) {
        const workspace = await this.prisma.workspace.findFirst({
            where: { id: workspaceId, userId },
            include: { containers: true },
        });

        if (!workspace) throw new RpcException('Workspace not found');
        if (workspace.status !== WorkspaceStatus.RUNNING) throw new RpcException('Start the workspace first.');

        const runtime = workspace.containers.find((c) => c.type === RuntimeContainerType.FIBER_RUNTIME);
        if (!runtime) throw new RpcException('Runtime container not found');

        return { workspace, client: this.docker.on(workspace.hostId), runtimeId: runtime.containerId };
    }

    get buildDirectory(): string {
        return `/workspace/${process.env.DEFAULT_PROJECT_NAME ?? 'ckb-rust-script'}/build/release`;
    }
}
