// apps/auth-service/src/wallets/wallet.service.ts
//
// Corven-held CKB wallets for people who sign in with Google: one testnet
// and one mainnet wallet each, created on first use. Keys are encrypted at
// rest (wallet-vault.ts) and only decrypted to sign.
//
// What each wallet can do, and the guards:
//   - testnet: send CKB, and sign transactions built in the browser (contract
//     deploys). Testnet CKB has no value.
//   - mainnet: send CKB only. Corven builds that transaction itself; there's
//     no endpoint that signs an arbitrary mainnet transaction. Each send
//     needs a fresh Google confirmation (a new ID token for the same Google
//     account, at most 5 minutes old), so a stolen Corven session alone can't
//     move funds, and sends are capped per 24 hours
//     (WALLET_MAINNET_DAILY_LIMIT_CKB, default 1,000 CKB).
//   - export: hands the user their private key so they can move to a wallet
//     they control. Also needs a fresh Google confirmation.
//
// Settings:
//   WALLET_ENCRYPTION_KEY            required to enable wallets (see wallet-vault.ts)
//   WALLET_MAINNET_DAILY_LIMIT_CKB   default 1000; 0 disables mainnet sends
//   CKB_TESTNET_RPC_URL / CKB_MAINNET_RPC_URL   optional RPC overrides

import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { ccc } from '@ckb-ccc/core';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '@app/prisma';

import { GoogleVerificationError, verifyGoogleCredential } from '../google-verification';
import { masterKeyFromEnv, WalletVault, type SealedKey } from './wallet-vault';
import {
    fail,
    formatCkb,
    mainnetDailyLimit,
    NETWORKS,
    parseCkbAmount,
    parseNetwork,
    SHANNONS,
    type WalletNetwork,
} from './wallet-amounts';

export { parseCkbAmount, parseNetwork, type WalletNetwork };


/** Fresh Google confirmations: the ID token must be at most this old. */
const CONFIRMATION_MAX_AGE_S = 5 * 60;


interface WalletRow extends SealedKey {
    id: string;
    userId: string;
    network: WalletNetwork;
    address: string;
    publicKey: string;
    exportedAt: Date | null;
    createdAt: Date;
}





@Injectable()
export class WalletService {
    private readonly logger = new Logger(WalletService.name);
    private readonly sending = new Set<string>();
    private vaultCache: WalletVault | null | undefined;

    constructor(private readonly prisma: PrismaService) { }

    // ------------------------------------------------------------------ setup

    get enabled(): boolean {
        return this.vault() !== null;
    }

    /** CKB client per network. Overridable for tests. */
    clientFor(network: WalletNetwork): ccc.Client {
        return network === 'MAINNET'
            ? new ccc.ClientPublicMainnet(process.env.CKB_MAINNET_RPC_URL ? { url: process.env.CKB_MAINNET_RPC_URL } : undefined)
            : new ccc.ClientPublicTestnet(process.env.CKB_TESTNET_RPC_URL ? { url: process.env.CKB_TESTNET_RPC_URL } : undefined);
    }

    /** Creates the missing wallets of a Google user. No-op for other users or when disabled. */
    async ensureWallets(userId: string): Promise<void> {
        const vault = this.vault();
        if (!vault) return;

        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { authProvider: true } });
        if (user?.authProvider !== 'GOOGLE') return;

        const existing = await this.prisma.userWallet.findMany({ where: { userId }, select: { network: true } });
        const have = new Set(existing.map((w: { network: string }) => w.network));

        for (const network of NETWORKS) {
            if (have.has(network)) continue;

            const { privateKey, signer } = this.generateKey(network);
            try {
                const address = await signer.getRecommendedAddress();
                const sealed = vault.seal(privateKey, { userId, network, address });

                await this.prisma.userWallet.create({
                    data: { userId, network, address, publicKey: signer.publicKey, ...sealed },
                });
                this.logger.log(`Created ${network} wallet for user ${userId}`);
            } catch (error) {
                // Two requests racing: the other one created it.
                if ((error as { code?: string })?.code !== 'P2002') throw error;
            } finally {
                privateKey.fill(0);
            }
        }
    }

    // ------------------------------------------------------------------ queries

    async list(data: { userId: string }) {
        if (!this.enabled) return { enabled: false, wallets: [], mainnetDailyLimit: '0', mainnetSentToday: '0' };

        await this.ensureWallets(data.userId);
        const wallets: WalletRow[] = await this.prisma.userWallet.findMany({
            where: { userId: data.userId },
            orderBy: { network: 'desc' }, // TESTNET first
        });

        const withBalances = await Promise.all(
            wallets.map(async (w) => ({
                network: w.network,
                address: w.address,
                publicKey: w.publicKey,
                exportedAt: w.exportedAt,
                createdAt: w.createdAt,
                balance: await this.balanceOf(w).catch(() => null),
            })),
        );

        const transfers = await this.prisma.walletTransfer.findMany({
            where: { userId: data.userId },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: { network: true, toAddress: true, amount: true, txHash: true, createdAt: true },
        });

        return {
            enabled: true,
            wallets: withBalances,
            transfers,
            mainnetDailyLimit: mainnetDailyLimit().toString(),
            mainnetSentToday: (await this.sentInLastDay(data.userId)).toString(),
        };
    }

    // ------------------------------------------------------------------ actions

    async transfer(data: { userId: string; network: unknown; to: unknown; amountCkb: unknown; confirmation?: unknown }) {
        const network = parseNetwork(data.network);
        const amount = parseCkbAmount(data.amountCkb);
        const wallet = await this.walletOf(data.userId, network);

        const client = this.clientFor(network);
        const toText = String(data.to ?? '').trim();
        const otherPrefix = client.addressPrefix === 'ckb' ? 'ckt1' : 'ckb1';
        if (toText.startsWith(otherPrefix)) {
            throw fail(400, `That address is for ${otherPrefix === 'ckb1' ? 'mainnet' : 'testnet'}, not ${network.toLowerCase()}.`);
        }
        let to: ccc.Address;
        try {
            to = await ccc.Address.fromString(toText, client);
        } catch {
            throw fail(400, `That isn't a valid CKB ${network === 'MAINNET' ? 'mainnet (ckb1…)' : 'testnet (ckt1…)'} address.`);
        }

        if (network === 'MAINNET') {
            await this.confirmWithGoogle(data.userId, data.confirmation);

            const limit = mainnetDailyLimit();
            if (limit === 0n) throw fail(403, 'Mainnet sends are turned off on this server.');
            const sent = await this.sentInLastDay(data.userId);
            if (sent + amount > limit) {
                throw fail(
                    429,
                    `That would go over the mainnet limit of ${limit / SHANNONS} CKB per 24 hours (${formatCkb(sent)} CKB sent so far).`,
                );
            }
        }

        if (amount < 61n * SHANNONS) {
            throw fail(400, 'Send at least 61 CKB: that is the smallest cell a CKB address can receive.');
        }

        const lockKey = `${data.userId}:${network}`;
        if (this.sending.has(lockKey)) throw fail(409, 'Another send from this wallet is still in progress.');
        this.sending.add(lockKey);

        try {
            const txHash = await this.vault()!.withPrivateKey(wallet, this.binding(wallet), async (key) => {
                const signer = new ccc.SignerCkbPrivateKey(client, key);
                const tx = ccc.Transaction.from({
                    outputs: [{ lock: to.script, capacity: amount }],
                    outputsData: ['0x'],
                });

                try {
                    await tx.completeInputsByCapacity(signer);
                    await tx.completeFeeBy(signer);
                } catch (error) {
                    throw fail(400, describeBuildError(error));
                }

                try {
                    return await signer.sendTransaction(tx);
                } catch (error) {
                    throw fail(400, `The network rejected the transaction: ${error instanceof Error ? error.message : error}`);
                }
            });

            await this.prisma.walletTransfer.create({
                data: {
                    userId: data.userId,
                    walletId: wallet.id,
                    network,
                    toAddress: toText,
                    amount: amount.toString(),
                    txHash,
                },
            });

            this.logger.log(`User ${data.userId} sent ${formatCkb(amount)} CKB on ${network}: ${txHash}`);
            return { txHash, network, amount: amount.toString(), to: toText };
        } finally {
            this.sending.delete(lockKey);
        }
    }

    /**
     * Signs a transaction built in the browser (e.g. a contract deploy).
     * Testnet only: on mainnet Corven only signs transactions it built.
     */
    async signTestnetTransaction(data: { userId: string; transaction: unknown }) {
        const wallet = await this.walletOf(data.userId, 'TESTNET');

        let tx: ccc.Transaction;
        try {
            tx = ccc.Transaction.from(data.transaction as ccc.TransactionLike);
        } catch {
            throw fail(400, 'Malformed transaction.');
        }
        if (tx.inputs.length === 0 || tx.inputs.length > 200 || tx.outputs.length > 200) {
            throw fail(400, 'Transaction has no inputs, or too many inputs or outputs.');
        }

        const client = this.clientFor('TESTNET');

        const signed = await this.vault()!.withPrivateKey(wallet, this.binding(wallet), async (key) => {
            const signer = new ccc.SignerCkbPrivateKey(client, key);
            const before = tx.witnesses.join();
            try {
                const out = await signer.signOnlyTransaction(tx);
                if (out.witnesses.join() === before) throw fail(400, 'This transaction spends nothing from your Corven wallet.');
                return out;
            } catch (error) {
                if (error instanceof RpcException) throw error;
                throw fail(400, `Could not sign: ${error instanceof Error ? error.message : error}`);
            }
        });

        return JSON.parse(ccc.stringify(signed));
    }

    async exportKey(data: { userId: string; network: unknown; confirmation?: unknown }) {
        const network = parseNetwork(data.network);
        const wallet = await this.walletOf(data.userId, network);
        await this.confirmWithGoogle(data.userId, data.confirmation);

        const privateKey = await this.vault()!.withPrivateKey(wallet, this.binding(wallet), async (key) => key);
        await this.prisma.userWallet.update({ where: { id: wallet.id }, data: { exportedAt: new Date() } });

        this.logger.warn(`User ${data.userId} exported their ${network} wallet key`);
        return { network, address: wallet.address, privateKey };
    }

    // ------------------------------------------------------------------ helpers

    private vault(): WalletVault | null {
        if (this.vaultCache === undefined) {
            const key = masterKeyFromEnv();
            this.vaultCache = key ? new WalletVault(key) : null;
            if (!key) this.logger.warn('WALLET_ENCRYPTION_KEY is not set; Corven wallets are disabled');
        }
        return this.vaultCache;
    }

    private generateKey(network: WalletNetwork): { privateKey: Buffer; signer: ccc.SignerCkbPublicKey } {
        const client = this.clientFor(network);
        for (;;) {
            const privateKey = randomBytes(32);
            try {
                // Throws for the (astronomically rare) bytes that aren't a valid key.
                const signer = new ccc.SignerCkbPrivateKey(client, privateKey);
                return { privateKey, signer: new ccc.SignerCkbPublicKey(client, signer.publicKey) };
            } catch {
                privateKey.fill(0);
            }
        }
    }

    private binding(wallet: WalletRow) {
        return { userId: wallet.userId, network: wallet.network, address: wallet.address };
    }

    private async walletOf(userId: string, network: WalletNetwork): Promise<WalletRow> {
        if (!this.enabled) throw fail(503, 'Corven wallets are not set up on this server.');

        await this.ensureWallets(userId);
        const wallet = await this.prisma.userWallet.findUnique({ where: { userId_network: { userId, network } } });
        if (!wallet) throw fail(404, 'Corven wallets are only for accounts that sign in with Google.');
        return wallet as WalletRow;
    }

    private async balanceOf(wallet: WalletRow): Promise<string> {
        const client = this.clientFor(wallet.network);
        const { script } = await ccc.Address.fromString(wallet.address, client);
        return (await client.getBalance([script])).toString();
    }

    private async sentInLastDay(userId: string): Promise<bigint> {
        const rows = await this.prisma.walletTransfer.findMany({
            where: { userId, network: 'MAINNET', createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
            select: { amount: true },
        });
        return rows.reduce((sum: bigint, r: { amount: string }) => sum + BigInt(r.amount), 0n);
    }

    /** The user just confirmed with the same Google account (fresh ID token). */
    private async confirmWithGoogle(userId: string, confirmation: unknown): Promise<void> {
        if (typeof confirmation !== 'string' || !confirmation) {
            throw fail(401, 'Confirm with Google to continue.');
        }

        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { googleId: true } });

        let identity;
        try {
            identity = await verifyGoogleCredential(confirmation);
        } catch (error) {
            const reason = error instanceof GoogleVerificationError ? error.reason : 'invalid_token';
            throw fail(reason === 'not_configured' ? 503 : 401, 'Google confirmation failed. Please try again.');
        }

        if (!user?.googleId || identity.sub !== user.googleId) {
            throw fail(401, 'Confirm with the Google account you signed in with.');
        }
        if (Date.now() / 1000 - identity.issuedAt > CONFIRMATION_MAX_AGE_S) {
            throw fail(401, 'That Google confirmation is too old. Confirm again.');
        }
    }
}


function describeBuildError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/insufficient|not enough|capacity/i.test(message)) {
        return 'Not enough CKB in this wallet for that amount plus the fee. A new cell also needs at least 61 CKB.';
    }
    return `Could not build the transaction: ${message}`;
}
