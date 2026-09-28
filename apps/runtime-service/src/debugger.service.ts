// apps/runtime-service/src/debugger.service.ts
//
// Cycles and debugging with ckb-debugger.
//
//  - runContract: runs a built binary on its own (`ckb-debugger --bin`),
//    in the runtime container. Quick cycle and exit-code checks.
//  - listTransactions: devnet transactions seen by offckb's RPC proxy
//    (http://ckb-node:28114), including ones the node rejected.
//  - debugTransaction: replays every script of a devnet transaction in the
//    CKB node container and reports each one's exit code, cycles and debug
//    output. Scripts from the user's contracts can be swapped for the latest
//    build, to test a fix against a real transaction without redeploying.
//
// offckb builds the "mock transaction" ckb-debugger needs (the transaction
// plus every input and dep cell) from the devnet RPC.

import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

import { DeployNetwork, RuntimeContainerStatus, RuntimeContainerType } from 'src/generated/prisma/enums';
import { PrismaService } from 'libs/prisma/src/prisma.service';
import { recordWorkspaceActivity } from 'libs/prisma/src/workspace-activity';

import { ContractsService } from './contracts.service';
import { rpcBatch } from './devnet-info';
import type { DockerClient } from './docker/docker.service';

/** offckb's data folder inside the node container (HOME=/ckb-data). */
const OFFCKB_DEVNET = '/ckb-data/.local/share/offckb-nodejs/devnet';
const UPLOAD_DIR = '/tmp/corven-debug';

/** CKB's block cycle limit; ckb-debugger's default ceiling too. */
export const MAX_BLOCK_CYCLES = 3_500_000_000;

const RUN_TIMEOUT_MS = 60_000;
const DUMP_TIMEOUT_MS = 90_000;
const MAX_GROUPS = 24;
const MAX_LOG_LINES = 200;

const HASH = /^0x[0-9a-f]{64}$/;
const TYPE_ID_CODE_HASH = '0x00000000000000000000000000000000000000000000000000545950455f4944';

/** Well-known scripts, by code hash. */
const KNOWN_SCRIPTS: Record<string, string> = {
    '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8': 'secp256k1_blake160 lock',
    '0x5c5069eb0857efc65e1bca0c07df34c31663b3622fd3876c876320fc9634e2a8': 'secp256k1 multisig lock',
    '0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e': 'Nervos DAO',
    [TYPE_ID_CODE_HASH]: 'Type ID',
    // Devnet (offckb) deployments of other system scripts.
    '0xe09352af0066f3162287763ce4ddba9af6bfaeab198dc7ab37f8c71c9e68bb5b': 'anyone-can-pay lock',
    '0x9c6933d977360f115a3e9cd5a2e0e475853681b80d775d93ad0f8969da343e56': 'Omnilock',
    '0x1a1e4fef34f5982906f745b048fe7b1089647e82346074e0f32c2ece26cf6b1e': 'xUDT',
};

/** Error codes of the secp256k1 system locks (ckb-system-scripts). */
const SECP256K1_ERRORS: Record<number, string> = {
    [-1]: 'Wrong length of lock args',
    [-2]: 'Encoding error (malformed witness or data)',
    [-3]: 'Syscall error',
    [-11]: 'Could not recover the public key: the signature is invalid for this transaction',
    [-12]: 'Signature verification failed',
    [-13]: 'Invalid public key',
    [-14]: 'Invalid signature format',
    [-15]: 'Public key serialization failed',
    [-21]: 'Lock script too long',
    [-22]: 'Witness has the wrong size',
    [-31]: 'Public key hash does not match the lock args (signed by the wrong key)',
};

/** Standard ckb-std syscall errors, as the contract template maps them. */
const CKB_STD_ERRORS: Record<number, string> = {
    1: 'IndexOutOfBound: read past the last cell, input or witness',
    2: 'ItemMissing: the cell has no such field (e.g. no type script)',
    3: 'LengthNotEnough: a buffer was too small for the data',
    4: 'Encoding: data is not valid molecule',
};

export interface ScriptRun {
    exitCode: number | null;
    /** VM error when the script didn't exit normally (out of memory bounds, cycles exceeded…). */
    vmError: string | null;
    cycles: number | null;
    logs: string[];
    /** What the exit code means, when known. */
    meaning: string | null;
}

export interface ScriptGroupResult extends ScriptRun {
    label: string;
    groupType: 'lock' | 'type';
    cellType: 'input' | 'output';
    cellIndex: number;
    codeHash: string;
    hashType: string;
    args: string;
    /** Friendly name: a system script or one of the user's contracts. */
    name: string | null;
    contract: string | null;
    /** Ran with the latest build instead of the deployed code. */
    replaced: boolean;
    skipped: string | null;
}

/** Parses ckb-debugger's output. */
export function parseDebuggerOutput(output: string): Omit<ScriptRun, 'meaning'> {
    const logs: string[] = [];
    let exitCode: number | null = null;
    let vmError: string | null = null;
    let cycles: number | null = null;

    for (const raw of output.split('\n')) {
        const line = raw.trimEnd();

        if (line.startsWith('Script log: ')) {
            if (logs.length < MAX_LOG_LINES) logs.push(line.slice('Script log: '.length));
            continue;
        }

        const result = /^Run result: (.*)$/.exec(line);
        if (result) {
            const value = result[1].trim();
            if (/^-?\d+$/.test(value)) exitCode = Number(value);
            else vmError = value;
            continue;
        }

        const cyclesMatch = /^All cycles: (\d+)/.exec(line);
        if (cyclesMatch) {
            cycles = Number(cyclesMatch[1]);
            continue;
        }

        if (/^Error:/i.test(line) && !vmError) vmError = line.replace(/^Error:\s*/i, '');
    }

    return { exitCode, vmError, cycles, logs };
}

/**
 * Reads a contract's `pub enum Error { … }` (template layout: explicit
 * `Name = N` values, or implicit ones counting up).
 */
export function parseErrorEnum(source: string): Record<number, string> {
    const block = /enum\s+Error\s*\{([\s\S]*?)\}/.exec(source)?.[1];
    if (!block) return {};

    const codes: Record<number, string> = {};
    let next = 0;

    for (const raw of block.split(/,|\n/)) {
        const line = raw.replace(/\/\/.*$/, '').replace(/#\[[^\]]*\]/g, '').trim();
        const match = /^([A-Za-z_]\w*)\s*(?:=\s*(-?\d+))?$/.exec(line);
        if (!match) continue;

        const value = match[2] !== undefined ? Number(match[2]) : next;
        codes[value] = match[1];
        next = value + 1;
    }

    return codes;
}

function describeExit(exitCode: number | null, knownName: string | null, contractErrors: Record<number, string> | null): string | null {
    if (exitCode === null) return null;
    if (exitCode === 0) return 'Success';

    if (knownName?.startsWith('secp256k1')) return SECP256K1_ERRORS[exitCode] ?? null;

    if (contractErrors?.[exitCode]) {
        const name = contractErrors[exitCode];
        const standard = Object.values(CKB_STD_ERRORS).find((d) => d.startsWith(`${name}:`));
        return standard ?? `Error::${name} (from your error.rs)`;
    }

    if (contractErrors) return CKB_STD_ERRORS[exitCode] ?? null;
    return null;
}

interface Script {
    code_hash: string;
    hash_type: string;
    args: string;
}

@Injectable()
export class DebuggerService {
    private readonly logger = new Logger(DebuggerService.name);
    private readonly busy = new Set<string>();

    constructor(
        private readonly prisma: PrismaService,
        private readonly contracts: ContractsService,
    ) { }

    // ------------------------------------------------------------------ run a binary

    async runContract(payload: { workspaceId: string; userId: string; contract: string }) {
        const name = this.contracts.checkName(payload.contract);
        const { workspace, client, runtimeId } = await this.contracts.runningRuntime(payload.workspaceId, payload.userId);

        await recordWorkspaceActivity(this.prisma, workspace.id, 0);

        const result = await this.withTimeout(
            client.executeCommand({
                containerId: runtimeId,
                command: ['ckb-debugger', '--bin', `${this.contracts.buildDirectory}/${name}`, '--max-cycles', String(MAX_BLOCK_CYCLES)],
                workingDirectory: '/workspace',
            }),
            'The contract did not finish within a minute.',
        );

        const output = `${result.stdout}\n${result.stderr}`;
        if (/No such file|not found/i.test(result.stderr) && !/Run result/.test(output)) {
            throw new RpcException(`No built contract named "${name}". Run a build first.`);
        }

        const parsed = parseDebuggerOutput(output);
        const errors = await this.readErrorEnum(client, runtimeId, name);

        return {
            contract: name,
            ...parsed,
            meaning: describeExit(parsed.exitCode, null, errors ?? {}),
            raw: output.trim().split('\n').slice(-60).join('\n'),
            note: 'Runs the binary without a transaction, so syscalls that read cells or witnesses fail. Debug a real transaction to see realistic cycles.',
        };
    }

    // ------------------------------------------------------------------ transactions

    async listTransactions(payload: { workspaceId: string; userId: string }) {
        const { client, nodeId } = await this.runningNode(payload.workspaceId, payload.userId);

        const listing = await client.executeCommand({
            containerId: nodeId,
            command: [
                'sh', '-c',
                `find "${OFFCKB_DEVNET}/transactions" -maxdepth 1 -name '0x*.json' -printf '%T@\\t%f\\n' 2>/dev/null | sort -rn | head -n 25`,
            ],
            workingDirectory: '/',
        });

        const items = listing.stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const [mtime, file] = line.split('\t');
                return { txHash: file.replace(/\.json$/, ''), recordedAt: new Date(Number(mtime) * 1000).toISOString() };
            })
            .filter((item) => HASH.test(item.txHash));

        if (!items.length) return [];

        const statuses = await rpcBatch(
            client,
            nodeId,
            items.map((item) => ({ method: 'get_transaction_status', params: [item.txHash] })),
        ).catch(() => null);

        // Older nodes lack get_transaction_status; fall back to get_transaction.
        const results =
            statuses && statuses.some(Boolean)
                ? statuses
                : await rpcBatch(
                      client,
                      nodeId,
                      items.map((item) => ({ method: 'get_transaction', params: [item.txHash, '0x1'] })),
                  ).catch(() => []);

        return items.map((item, i) => {
            const status = results[i]?.tx_status?.status ?? results[i]?.status ?? 'unknown';
            return { ...item, status: status === 'unknown' ? 'not-on-chain' : status };
        });
    }

    async debugTransaction(payload: { workspaceId: string; userId: string; txHash: string; replace?: string[] }) {
        const txHash = String(payload.txHash ?? '').trim().toLowerCase();
        if (!HASH.test(txHash)) throw new RpcException('Enter a transaction hash (0x followed by 64 hex characters).');

        const { workspace, client, nodeId, runtimeId } = await this.runningNode(payload.workspaceId, payload.userId);

        if (this.busy.has(workspace.id)) throw new RpcException('A debug run is already in progress for this workspace.');
        this.busy.add(workspace.id);

        try {
            await recordWorkspaceActivity(this.prisma, workspace.id, 0);

            const mockTx = await this.loadMockTransaction(client, nodeId, txHash);
            const mockFile = `${OFFCKB_DEVNET}/full-transactions/${txHash}.json`;

            // The user's devnet contracts, by code hash (and data hash, for
            // scripts referenced by data hash).
            const deployments = await this.prisma.contractDeployment.findMany({
                where: { workspaceId: workspace.id, network: DeployNetwork.DEVNET },
                select: { contractName: true, codeHash: true, dataHash: true },
            });
            const contractByHash = new Map<string, string>();
            for (const d of deployments) {
                contractByHash.set(d.codeHash, d.contractName);
                contractByHash.set(d.dataHash, d.contractName);
            }

            // Latest builds to run in place of the deployed code.
            const replace = new Set((payload.replace ?? []).map((n) => this.contracts.checkName(n)));
            const uploaded = new Map<string, string>();

            for (const name of replace) {
                const base64 = await this.contracts.readBase64(client, runtimeId, name);
                const target = `${UPLOAD_DIR}/${name}`;
                const upload = await client.executeCommand({
                    containerId: nodeId,
                    command: ['sh', '-c', `mkdir -p ${UPLOAD_DIR} && base64 -d > "$1"`, 'upload', target],
                    workingDirectory: '/',
                    input: base64,
                });
                if (upload.exitCode !== 0) throw new RpcException(`Could not copy ${name} to the devnet node.`);
                uploaded.set(name, target);
            }

            const errorEnums = new Map<string, Record<number, string> | null>();
            const groups = this.scriptGroups(mockTx).slice(0, MAX_GROUPS);
            const results: ScriptGroupResult[] = [];

            for (const group of groups) {
                const codeHash = group.script.code_hash;
                const contract = contractByHash.get(codeHash) ?? null;
                const knownName = KNOWN_SCRIPTS[codeHash] ?? null;

                const base = {
                    label: group.label,
                    groupType: group.groupType,
                    cellType: group.cellType,
                    cellIndex: group.cellIndex,
                    codeHash,
                    hashType: group.script.hash_type,
                    args: group.script.args,
                    name: contract ?? knownName,
                    contract,
                    replaced: Boolean(contract && uploaded.has(contract)),
                };

                if (codeHash === TYPE_ID_CODE_HASH) {
                    results.push({
                        ...base,
                        exitCode: null, vmError: null, cycles: null, logs: [], meaning: null,
                        skipped: 'Type ID is built into CKB; ckb-debugger does not run it.',
                    });
                    continue;
                }

                const args = [
                    'ckb-debugger',
                    '--tx-file', mockFile,
                    '--cell-index', String(group.cellIndex),
                    '--cell-type', group.cellType,
                    '--script-group-type', group.groupType,
                    '--max-cycles', String(MAX_BLOCK_CYCLES),
                ];
                if (base.replaced && contract) args.push('--bin', uploaded.get(contract)!);

                let run: Omit<ScriptRun, 'meaning'>;
                try {
                    const result = await this.withTimeout(
                        client.executeCommand({ containerId: nodeId, command: args, workingDirectory: '/' }),
                        'timed out',
                    );
                    run = parseDebuggerOutput(`${result.stdout}\n${result.stderr}`);
                    if (run.exitCode === null && !run.vmError) {
                        run.vmError = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ') || 'ckb-debugger failed';
                    }
                } catch (error) {
                    run = { exitCode: null, vmError: error instanceof Error ? error.message : String(error), cycles: null, logs: [] };
                }

                if (contract && !errorEnums.has(contract)) {
                    errorEnums.set(contract, await this.readErrorEnum(client, runtimeId, contract));
                }

                results.push({
                    ...base,
                    ...run,
                    meaning: describeExit(run.exitCode, knownName, contract ? errorEnums.get(contract) ?? {} : null),
                    skipped: null,
                });
            }

            const [statusResult] = await rpcBatch(client, nodeId, [{ method: 'get_transaction', params: [txHash, '0x1'] }]).catch(() => [null]);
            const status = statusResult?.tx_status?.status;

            return {
                txHash,
                status: !status || status === 'unknown' ? 'not-on-chain' : status,
                inputs: mockTx.mock_info?.inputs?.length ?? 0,
                outputs: mockTx.tx?.outputs?.length ?? 0,
                totalCycles: results.reduce((sum, r) => sum + (r.cycles ?? 0), 0),
                failed: results.filter((r) => !r.skipped && (r.exitCode !== 0 || r.vmError)).length,
                groups: results,
                truncated: this.scriptGroups(mockTx).length > MAX_GROUPS,
            };
        } finally {
            this.busy.delete(workspace.id);
        }
    }

    // ------------------------------------------------------------------ helpers

    /** Has offckb fetch the transaction and its cells into a mock transaction file. */
    private async loadMockTransaction(client: DockerClient, nodeId: string, txHash: string): Promise<any> {
        const file = `${OFFCKB_DEVNET}/full-transactions/${txHash}.json`;

        const exists = await client.executeCommand({ containerId: nodeId, command: ['test', '-f', file], workingDirectory: '/' });

        if (exists.exitCode !== 0) {
            // `offckb debug` writes the mock transaction, then runs one script;
            // only the file matters here.
            await this.withTimeout(
                client.executeCommand({
                    containerId: nodeId,
                    command: ['offckb', 'debug', '--tx-hash', txHash, '--single-script', 'input[0].lock'],
                    workingDirectory: '/ckb-data',
                    environment: ['HOME=/ckb-data', 'NO_COLOR=1'],
                }),
                'Loading the transaction took too long.',
                DUMP_TIMEOUT_MS,
            ).catch(() => undefined);
        }

        const read = await client.executeCommand({ containerId: nodeId, command: ['cat', file], workingDirectory: '/' });

        if (read.exitCode !== 0) {
            throw new RpcException(
                'That transaction isn’t on this workspace’s devnet, and it wasn’t sent through its RPC proxy (http://ckb-node:28114). Only devnet transactions can be debugged.',
            );
        }

        try {
            return JSON.parse(read.stdout);
        } catch {
            throw new RpcException('The transaction data could not be read.');
        }
    }

    /** One entry per script group: locks of inputs, types of inputs and outputs. */
    private scriptGroups(mockTx: any) {
        const groups: Array<{ label: string; script: Script; groupType: 'lock' | 'type'; cellType: 'input' | 'output'; cellIndex: number }> = [];
        const seen = new Set<string>();

        const add = (script: Script | null | undefined, groupType: 'lock' | 'type', cellType: 'input' | 'output', cellIndex: number) => {
            if (!script?.code_hash) return;
            const key = `${groupType}:${script.code_hash}:${script.hash_type}:${script.args}`;
            if (seen.has(key)) return;
            seen.add(key);
            const label = `${cellType === 'input' ? 'Input' : 'Output'}[${cellIndex}].${groupType === 'lock' ? 'Lock' : 'Type'}`;
            groups.push({ label, script, groupType, cellType, cellIndex });
        };

        const inputs: any[] = mockTx.mock_info?.inputs ?? [];
        inputs.forEach((input, i) => add(input.output?.lock, 'lock', 'input', i));
        inputs.forEach((input, i) => add(input.output?.type, 'type', 'input', i));
        (mockTx.tx?.outputs ?? []).forEach((output: any, i: number) => add(output?.type, 'type', 'output', i));

        return groups;
    }

    private async readErrorEnum(client: DockerClient, runtimeId: string, contract: string): Promise<Record<number, string> | null> {
        const project = `/workspace/${process.env.DEFAULT_PROJECT_NAME ?? 'ckb-rust-script'}`;
        const result = await client
            .executeCommand({
                containerId: runtimeId,
                command: ['sh', '-c', 'cat "$1"/contracts/"$2"/src/error.rs 2>/dev/null', 'read', project, contract],
                workingDirectory: '/',
            })
            .catch(() => null);

        if (!result || result.exitCode !== 0 || !result.stdout) return null;
        const parsed = parseErrorEnum(result.stdout);
        return Object.keys(parsed).length ? parsed : null;
    }

    private async runningNode(workspaceId: string, userId: string) {
        const { workspace, client, runtimeId } = await this.contracts.runningRuntime(workspaceId, userId);
        const node = workspace.containers.find((c) => c.type === RuntimeContainerType.CKB_NODE);

        if (!node || node.status !== RuntimeContainerStatus.RUNNING) {
            throw new RpcException('Start the devnet to debug its transactions.');
        }

        return { workspace, client, runtimeId, nodeId: node.containerId };
    }

    private withTimeout<T>(promise: Promise<T>, message: string, ms = RUN_TIMEOUT_MS): Promise<T> {
        return Promise.race([
            promise,
            new Promise<never>((_, reject) => setTimeout(() => reject(new RpcException(message)), ms)),
        ]);
    }
}
