// apps/connect-service/src/wallets/wallets.service.ts
//
// One CKB testnet and one mainnet wallet per Connect user, created on first
// sign-in, except for people who signed up with their own wallet (they sign
// with it). Keys are sealed at rest (vault.ts) and only decrypted to sign.
//
// Signing rules:
//   - The transaction must spend at least one cell of the user's wallet.
//     Input cells are always looked up on chain; anything the caller says
//     about them is ignored.
//   - Testnet: signed with a valid session.
//   - Mainnet: only for apps with mainnetEnabled, only with a fresh step-up
//     (the user re-verified in the last 5 minutes), and the CKB leaving the
//     wallet is capped per 24 hours (CONNECT_MAINNET_DAILY_LIMIT_CKB).
//   - Key export: needs a step-up for export.

import { Injectable, Logger } from '@nestjs/common';
import { ccc } from '@ckb-ccc/core';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { PrismaService } from '@app/prisma';

import { mainnetDailyLimitCkb } from '../config';
import type { ConnectRequestContext } from '../http/app.guard';
import { fail } from '../http/errors';
import { TokensService } from '../auth/tokens.service';
import { EventsService } from '../events/events.service';
import { masterKeyFromEnv, Vault, type SealedKey } from './vault';

export type Network = 'TESTNET' | 'MAINNET';
export const NETWORKS: readonly Network[] = ['TESTNET', 'MAINNET'];
const SHANNONS = 100_000_000n;

interface WalletRow extends SealedKey {
    id: string;
    userId: string;
    network: Network;
    address: string;
    publicKey: string;
    exportedAt: Date | null;
    createdAt: Date;
}

export function parseNetwork(value: unknown): Network {
    const v = String(value ?? '').toUpperCase();
    if (v === 'TESTNET' || v === 'MAINNET') return v;
    throw fail(400, 'Network must be TESTNET or MAINNET.', 'invalid_network');
}

export function formatCkb(shannons: bigint): string {
    const whole = shannons / SHANNONS;
    const fraction = (shannons % SHANNONS).toString().padStart(8, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : `${whole}`;
}

@Injectable()
export class WalletsService {
    private readonly logger = new Logger('ConnectWallets');
    private vaultCache: Vault | null | undefined;

    constructor(
        private readonly prisma: PrismaService,
        private readonly tokens: TokensService,
        private readonly events: EventsService,
    ) { }

    get enabled(): boolean {
        return this.vault() !== null;
    }

    /**
     * CKB client per network. For local development against a devnet
     * (offckb), point CONNECT_CKB_TESTNET_RPC_URL at it and set
     * CONNECT_CKB_SCRIPTS_FILE to a JSON file of the devnet's known scripts.
     */
    clientFor(network: Network): ccc.Client {
        const url = network === 'MAINNET' ? process.env.CONNECT_CKB_MAINNET_RPC_URL : process.env.CONNECT_CKB_TESTNET_RPC_URL;
        const config = { ...(url ? { url } : {}), ...(this.devnetScripts() ? { scripts: this.devnetScripts() } : {}) };
        return network === 'MAINNET' ? new ccc.ClientPublicMainnet(config as never) : new ccc.ClientPublicTestnet(config as never);
    }

    private scriptsCache: unknown;
    private devnetScripts(): any {
        const file = process.env.CONNECT_CKB_SCRIPTS_FILE;
        if (!file) return undefined;
        if (this.scriptsCache === undefined) {
            const parsed = JSON.parse(readFileSync(file, 'utf8'));
            this.scriptsCache = parsed.scripts ?? parsed;
        }
        return this.scriptsCache;
    }

    /** Creates any missing wallets for a user (none for people who use their own wallet). */
    async ensureWallets(userId: string): Promise<void> {
        const vault = this.vault();
        if (!vault) return;

        const user = await this.prisma.connectUser.findUnique({ where: { id: userId }, select: { embeddedWallets: true } });
        if (!user?.embeddedWallets) return;

        const have = new Set(
            (await this.prisma.connectWallet.findMany({ where: { userId }, select: { network: true } })).map((w) => w.network),
        );

        for (const network of NETWORKS) {
            if (have.has(network)) continue;
            const { privateKey, publicKey, address } = await this.generateKey(network);
            try {
                const sealed = vault.seal(privateKey, { userId, network, address });
                await this.prisma.connectWallet.create({ data: { userId, network, address, publicKey, ...sealed } });
            } catch (error) {
                if ((error as { code?: string })?.code !== 'P2002') throw error; // raced: already created
            } finally {
                privateKey.fill(0);
            }
        }
    }

    /** Addresses only (no network calls). */
    async addresses(userId: string) {
        const rows = await this.prisma.connectWallet.findMany({
            where: { userId },
            select: { network: true, address: true, publicKey: true, createdAt: true, exportedAt: true },
        });
        return rows.sort(testnetFirst);
    }

    async list(userId: string) {
        if (!this.enabled) return { enabled: false, wallets: [], activity: [] };
        await this.ensureWallets(userId);

        const rows = ((await this.prisma.connectWallet.findMany({ where: { userId } })) as WalletRow[]).sort(testnetFirst);
        const wallets = await Promise.all(
            rows.map(async (w) => ({
                network: w.network,
                address: w.address,
                publicKey: w.publicKey,
                createdAt: w.createdAt,
                exportedAt: w.exportedAt,
                balance: await this.balanceOf(w).catch(() => null),
            })),
        );

        const activity = await this.prisma.connectSignature.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: { network: true, txHash: true, outflow: true, origin: true, createdAt: true },
        });

        return {
            enabled: true,
            wallets,
            activity,
            mainnetDailyLimitCkb: mainnetDailyLimitCkb().toString(),
        };
    }

    async sign(userId: string, ctx: ConnectRequestContext, body: { network?: unknown; transaction?: unknown; stepUpToken?: unknown }) {
        const network = parseNetwork(body.network);
        const wallet = await this.walletOf(userId, network);

        if (network === 'MAINNET') {
            if (!ctx.app.mainnetEnabled) throw fail(403, 'This app can only use testnet.', 'mainnet_disabled');
            if (mainnetDailyLimitCkb() === 0n) throw fail(403, 'Mainnet signing is turned off on this server.', 'mainnet_disabled');
        }

        let tx: ccc.Transaction;
        try {
            tx = ccc.Transaction.from(body.transaction as ccc.TransactionLike);
        } catch {
            throw fail(400, 'Malformed transaction.', 'invalid_transaction');
        }
        if (tx.inputs.length === 0 || tx.inputs.length > 200 || tx.outputs.length > 200) {
            throw fail(400, 'Transaction has no inputs, or too many inputs or outputs.', 'invalid_transaction');
        }

        // Never trust caller-supplied input cells: look each one up on chain.
        tx.inputs = tx.inputs.map((i) => ccc.CellInput.from({ previousOutput: i.previousOutput, since: i.since }));

        const client = this.clientFor(network);
        const outflow = await this.outflow(tx, wallet, client);

        if (network === 'MAINNET') {
            this.tokens.consumeStepUp(body.stepUpToken, userId, ctx.app.id, 'sign');
            const limit = mainnetDailyLimitCkb() * SHANNONS;
            const spent = await this.mainnetOutflowLastDay(userId);
            if (spent + outflow > limit) {
                throw fail(
                    429,
                    `That would go over the mainnet limit of ${formatCkb(limit)} CKB per 24 hours (${formatCkb(spent)} CKB used so far).`,
                    'daily_limit',
                );
            }
        }

        const signed = await this.vault()!.withPrivateKey(wallet, binding(wallet), async (key) => {
            const signer = new ccc.SignerCkbPrivateKey(client, key);
            try {
                return await signer.signOnlyTransaction(tx);
            } catch (error) {
                throw fail(400, `Could not sign: ${error instanceof Error ? error.message : error}`, 'sign_failed');
            }
        });

        const txHash = signed.hash();
        await this.prisma.connectSignature.create({
            data: { userId, walletId: wallet.id, network, txHash, outflow: outflow.toString(), origin: ctx.origin },
        });
        this.events.record(ctx.app.id, 'TX_SIGNED', network);
        this.logger.log(`Signed ${network} tx ${txHash} for ${userId} (${formatCkb(outflow)} CKB out)`);

        return { transaction: JSON.parse(ccc.stringify(signed)), txHash, outflow: outflow.toString() };
    }

    async exportKey(userId: string, ctx: ConnectRequestContext, body: { network?: unknown; stepUpToken?: unknown }) {
        const network = parseNetwork(body.network);
        const wallet = await this.walletOf(userId, network);
        this.tokens.consumeStepUp(body.stepUpToken, userId, ctx.app.id, 'export');

        const privateKey = await this.vault()!.withPrivateKey(wallet, binding(wallet), async (key) => key);
        await this.prisma.connectWallet.update({ where: { id: wallet.id }, data: { exportedAt: new Date() } });
        this.logger.warn(`Connect user ${userId} exported their ${network} key`);
        return { network, address: wallet.address, privateKey };
    }

    // ---------------------------------------------------------------- helpers

    /** CKB leaving the wallet: its input cells minus outputs back to it. */
    private async outflow(tx: ccc.Transaction, wallet: WalletRow, client: ccc.Client): Promise<bigint> {
        const signer = new ccc.SignerCkbPublicKey(client, wallet.publicKey);
        const own = (await signer.getAddressObjSecp256k1()).script;
        const acp = await ccc.Script.fromKnownScript(client, ccc.KnownScript.AnyoneCanPay, own.args).catch(() => null);
        const isOwn = (lock: ccc.Script) =>
            lock.eq(own) || (acp !== null && lock.codeHash === acp.codeHash && lock.hashType === acp.hashType && lock.args.startsWith(acp.args));

        let spent = 0n;
        for (const input of tx.inputs) {
            await input.completeExtraInfos(client);
            if (!input.cellOutput) throw fail(400, 'An input cell doesn\'t exist or was already spent.', 'unknown_input');
            if (isOwn(input.cellOutput.lock)) spent += input.cellOutput.capacity;
        }
        if (spent === 0n) throw fail(400, 'This transaction spends nothing from your wallet.', 'not_your_inputs');

        const back = tx.outputs.filter((o) => isOwn(o.lock)).reduce((sum, o) => sum + o.capacity, 0n);
        return spent > back ? spent - back : 0n;
    }

    private async mainnetOutflowLastDay(userId: string): Promise<bigint> {
        const rows = await this.prisma.connectSignature.findMany({
            where: { userId, network: 'MAINNET', createdAt: { gte: new Date(Date.now() - 86_400_000) } },
            select: { outflow: true },
        });
        return rows.reduce((sum, r) => sum + BigInt(r.outflow), 0n);
    }

    private vault(): Vault | null {
        if (this.vaultCache === undefined) {
            const key = masterKeyFromEnv();
            this.vaultCache = key ? new Vault(key) : null;
            if (!key) this.logger.warn('CONNECT_WALLET_ENCRYPTION_KEY is not set; Connect wallets are disabled');
        }
        return this.vaultCache;
    }

    private async generateKey(network: Network) {
        const client = this.clientFor(network);
        for (;;) {
            const privateKey = randomBytes(32);
            try {
                const signer = new ccc.SignerCkbPrivateKey(client, privateKey);
                return { privateKey, publicKey: signer.publicKey, address: await signer.getRecommendedAddress() };
            } catch {
                privateKey.fill(0);
            }
        }
    }

    private async walletOf(userId: string, network: Network): Promise<WalletRow> {
        if (!this.enabled) throw fail(503, 'Wallets are not set up on this server.', 'wallets_disabled');
        await this.ensureWallets(userId);
        const wallet = await this.prisma.connectWallet.findUnique({ where: { userId_network: { userId, network } } });
        if (!wallet) throw fail(404, 'This account signs with its own wallet, not a Corven wallet.', 'wallet_not_found');
        return wallet as WalletRow;
    }

    private async balanceOf(wallet: WalletRow): Promise<string> {
        const client = this.clientFor(wallet.network);
        const { script } = await ccc.Address.fromString(wallet.address, client);
        return (await client.getBalance([script])).toString();
    }
}

const testnetFirst = (a: { network: string }, b: { network: string }) => NETWORKS.indexOf(a.network as Network) - NETWORKS.indexOf(b.network as Network);

const binding = (w: WalletRow) => ({ userId: w.userId, network: w.network, address: w.address });
