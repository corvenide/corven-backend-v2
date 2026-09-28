// apps/runtime-service/src/devnet-tools.service.ts
//
// Devnet accounts and RPC access for the Devnets page.
//
//  - accounts: offckb's pre-funded devnet accounts, with live balances.
//    Their keys are public test keys (they're in offckb's source), so the
//    page shows them; they only hold devnet CKB.
//  - systemScripts: the devnet's system scripts in CCC's format, so the
//    browser can build transactions for this devnet.
//  - rpc: relays a JSON-RPC call to the devnet through offckb's RPC proxy
//    (port 28114), which records sent transactions, so anything sent from
//    the page (including rejected transactions) shows up in the Debug tab.
//    Only chain, indexer and send methods are allowed.

import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

import { ContractsService } from './contracts.service';
import { rpcBatch } from './devnet-info';

/** JSON-RPC methods the browser may call. No admin or node-control methods. */
export const ALLOWED_RPC_METHODS = new Set([
    'get_tip_header',
    'get_tip_block_number',
    'get_block',
    'get_block_by_number',
    'get_block_hash',
    'get_header',
    'get_header_by_number',
    'get_transaction',
    'get_transaction_status',
    'get_live_cell',
    'get_cells',
    'get_cells_capacity',
    'get_transactions',
    'get_indexer_tip',
    'get_blockchain_info',
    'get_consensus',
    'get_current_epoch',
    'get_epoch_by_number',
    'get_block_economic_state',
    'tx_pool_info',
    'get_fee_rate_statistics',
    'get_fee_rate_statics',
    'local_node_info',
    'estimate_cycles',
    'test_tx_pool_accept',
    'send_transaction',
]);

/** Largest JSON-RPC request relayed (a transaction carrying a contract binary fits). */
const MAX_RPC_BYTES = 1_500_000;

/** Account offckb's own `deploy` command pays from. */
const OFFCKB_DEPLOY_ACCOUNT = 19;

export interface DevnetAccount {
    index: number;
    address: string;
    privkey: string;
    lockArgs: string;
    lockScript: { codeHash: string; hashType: string; args: string };
    /** Shannons, as a decimal string. */
    balance: string;
    note: string | null;
}

@Injectable()
export class DevnetToolsService {
    /** System scripts per node container (they never change for a devnet). */
    private readonly scriptsCache = new Map<string, unknown>();

    constructor(private readonly contracts: ContractsService) { }

    async accounts(payload: { workspaceId: string; userId: string }): Promise<DevnetAccount[]> {
        const { client, nodeId } = await this.runningNode(payload);

        const result = await client.executeCommand({
            containerId: nodeId,
            command: ['offckb', '--json', 'accounts', '--show-private-keys'],
            workingDirectory: '/ckb-data',
            environment: ['HOME=/ckb-data', 'NO_COLOR=1'],
        });

        const json = this.lastJson(result.stdout);
        const accounts: any[] = Array.isArray(json?.accounts) ? json.accounts : [];
        if (!accounts.length) throw new RpcException('Could not read the devnet accounts.');

        const balances = await rpcBatch(
            client,
            nodeId,
            accounts.map((a) => ({
                method: 'get_cells_capacity',
                params: [
                    {
                        script: { code_hash: a.lockScript.codeHash, hash_type: a.lockScript.hashType, args: a.lockScript.args },
                        script_type: 'lock',
                    },
                ],
            })),
        ).catch(() => []);

        return accounts.map((a, i) => ({
            index: Number(a.index),
            address: String(a.address),
            privkey: String(a.privkey),
            lockArgs: String(a.lockArg),
            lockScript: a.lockScript,
            balance: balances[i]?.capacity ? BigInt(balances[i].capacity).toString() : '0',
            note: Number(a.index) === OFFCKB_DEPLOY_ACCOUNT ? 'Pays for devnet deploys' : null,
        }));
    }

    async systemScripts(payload: { workspaceId: string; userId: string }) {
        const { client, nodeId } = await this.runningNode(payload);

        const cached = this.scriptsCache.get(nodeId);
        if (cached) return cached;

        const result = await client.executeCommand({
            containerId: nodeId,
            command: ['offckb', 'system-scripts', '--export-style', 'ccc'],
            workingDirectory: '/ckb-data',
            environment: ['HOME=/ckb-data', 'NO_COLOR=1'],
        });

        const scripts = this.lastJson(result.stdout);
        if (!scripts || typeof scripts !== 'object' || !('Secp256k1Blake160' in scripts)) {
            throw new RpcException('Could not read the devnet system scripts.');
        }

        this.scriptsCache.set(nodeId, scripts);
        return scripts;
    }

    async rpc(payload: { workspaceId: string; userId: string; request: unknown }) {
        const request = payload.request as { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };

        if (!request || typeof request !== 'object' || Array.isArray(request)) {
            throw new RpcException('Send one JSON-RPC request object.');
        }
        if (typeof request.method !== 'string' || !ALLOWED_RPC_METHODS.has(request.method)) {
            throw new RpcException(`RPC method not allowed: ${String(request.method)}`);
        }

        const body = JSON.stringify({ jsonrpc: '2.0', id: request.id ?? 1, method: request.method, params: request.params ?? [] });
        if (body.length > MAX_RPC_BYTES) throw new RpcException('RPC request is too large.');

        const { client, nodeId } = await this.runningNode(payload);

        const result = await client.executeCommand({
            containerId: nodeId,
            command: [
                'curl', '--silent', '--show-error', '--max-time', '60',
                '-X', 'POST', '-H', 'Content-Type: application/json',
                '--data-binary', '@-',
                'http://127.0.0.1:28114',
            ],
            workingDirectory: '/',
            input: body,
        });

        if (result.exitCode !== 0) {
            throw new RpcException(`The devnet RPC is not reachable: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
        }

        try {
            return JSON.parse(result.stdout);
        } catch {
            throw new RpcException('The devnet RPC returned an unreadable response.');
        }
    }

    // ------------------------------------------------------------------ helpers

    /** offckb may print notices before its JSON; take the last JSON object. */
    private lastJson(output: string): any {
        const start = output.indexOf('{');
        if (start < 0) return null;
        try {
            return JSON.parse(output.slice(start));
        } catch {
            // Output with a header line then JSON (system-scripts).
            const brace = output.lastIndexOf('\n{');
            try {
                return brace >= 0 ? JSON.parse(output.slice(brace + 1)) : null;
            } catch {
                return null;
            }
        }
    }

    private async runningNode(payload: { workspaceId: string; userId: string }) {
        const { workspace, client } = await this.contracts.runningRuntime(payload.workspaceId, payload.userId);
        const node = workspace.containers.find((c) => c.type === 'CKB_NODE');

        if (!node || node.status !== 'RUNNING') throw new RpcException('Start the devnet first.');

        return { client, nodeId: node.containerId };
    }
}
