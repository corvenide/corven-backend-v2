// apps/runtime-service/src/devnet-info.ts
//
// Reads live facts from a workspace's CKB devnet by calling its JSON-RPC
// from inside the node container (curl to 127.0.0.1:8114). Nothing is
// exposed on the host, and it works on any Docker host.

import type { DockerClient } from './docker/docker.service';

/** Blocks listed on the Nodes page. */
const RECENT_BLOCKS = 10;

export interface DevnetBlock {
    number: number;
    hash: string;
    timestamp: number;
    transactions: number;
}

export interface DevnetInfo {
    chain: string | null;
    nodeVersion: string | null;
    nodeId: string | null;
    tip: { number: number; hash: string; timestamp: number; epoch: string } | null;
    txPool: { pending: number; proposed: number; orphan: number } | null;
    peers: number;
    recentBlocks: DevnetBlock[];
}

function hexToNumber(value: unknown): number {
    return typeof value === 'string' && value.startsWith('0x') ? Number.parseInt(value, 16) : 0;
}

/** CKB epochs are packed as (length << 40) | (index << 24) | number. */
export function formatEpoch(value: unknown): string {
    if (typeof value !== 'string' || !value.startsWith('0x')) return '';
    const packed = BigInt(value);
    const number = packed & 0xffffffn;
    const index = (packed >> 24n) & 0xffffn;
    const length = (packed >> 40n) & 0xffffn;
    return `${number} (${index}/${length})`;
}

export async function rpcBatch(
    client: DockerClient,
    containerId: string,
    calls: Array<{ method: string; params: unknown[] }>,
): Promise<any[]> {
    const body = JSON.stringify(
        calls.map((call, id) => ({ id, jsonrpc: '2.0', method: call.method, params: call.params })),
    );

    const result = await client.executeCommand({
        containerId,
        command: [
            'curl', '--fail', '--silent', '--show-error', '--max-time', '5',
            '-X', 'POST', '-H', 'Content-Type: application/json',
            '--data-binary', '@-',
            'http://127.0.0.1:8114',
        ],
        workingDirectory: '/',
        input: body,
    });

    if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `RPC failed with exit code ${result.exitCode}`);
    }

    const parsed = JSON.parse(result.stdout);
    const responses: any[] = Array.isArray(parsed) ? parsed : [parsed];

    // Batch responses may come back in any order.
    const byId = new Map(responses.map((response) => [response.id, response]));
    return calls.map((_, id) => byId.get(id)?.result ?? null);
}

export async function readDevnetInfo(client: DockerClient, containerId: string): Promise<DevnetInfo> {
    const [tipHeader, localNode, blockchain, txPool, peers] = await rpcBatch(client, containerId, [
        { method: 'get_tip_header', params: [] },
        { method: 'local_node_info', params: [] },
        { method: 'get_blockchain_info', params: [] },
        { method: 'tx_pool_info', params: [] },
        { method: 'get_peers', params: [] },
    ]);

    const tipNumber = hexToNumber(tipHeader?.number);

    const numbers: number[] = [];
    for (let n = tipNumber; n >= 0 && numbers.length < RECENT_BLOCKS; n--) numbers.push(n);

    const blocks = tipHeader
        ? await rpcBatch(
              client,
              containerId,
              numbers.map((n) => ({ method: 'get_block_by_number', params: [`0x${n.toString(16)}`] })),
          )
        : [];

    return {
        chain: blockchain?.chain ?? null,
        nodeVersion: localNode?.version ?? null,
        nodeId: localNode?.node_id ?? null,
        tip: tipHeader
            ? {
                  number: tipNumber,
                  hash: tipHeader.hash,
                  timestamp: hexToNumber(tipHeader.timestamp),
                  epoch: formatEpoch(tipHeader.epoch),
              }
            : null,
        txPool: txPool
            ? {
                  pending: hexToNumber(txPool.pending),
                  proposed: hexToNumber(txPool.proposed),
                  orphan: hexToNumber(txPool.orphan),
              }
            : null,
        peers: Array.isArray(peers) ? peers.length : 0,
        recentBlocks: blocks
            .filter(Boolean)
            .map((block: any) => ({
                number: hexToNumber(block.header?.number),
                hash: block.header?.hash ?? '',
                timestamp: hexToNumber(block.header?.timestamp),
                transactions: Array.isArray(block.transactions) ? block.transactions.length : 0,
            })),
    };
}
