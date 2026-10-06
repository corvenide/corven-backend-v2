// apps/auth-service/src/wallets/wallet-amounts.ts
//
// Pure helpers for Corven wallets: networks, CKB amounts, limits.

import { RpcException } from '@nestjs/microservices';

export type WalletNetwork = 'TESTNET' | 'MAINNET';

export const NETWORKS: readonly WalletNetwork[] = ['TESTNET', 'MAINNET'];

export const SHANNONS = 100_000_000n;

export function fail(statusCode: number, message: string): RpcException {
    return new RpcException({ statusCode, message });
}

export function parseNetwork(value: unknown): WalletNetwork {
    if (value === 'TESTNET' || value === 'MAINNET') return value;
    throw fail(400, 'Network must be TESTNET or MAINNET.');
}

/** "12.5" → 1_250_000_000n shannons. At most 8 decimals, positive. */
export function parseCkbAmount(value: unknown): bigint {
    const text = String(value ?? '').trim();
    if (!/^\d+(\.\d{1,8})?$/.test(text)) throw fail(400, 'Enter an amount in CKB, e.g. 100 or 12.5.');

    const [whole, fraction = ''] = text.split('.');
    const shannons = BigInt(whole) * SHANNONS + BigInt(fraction.padEnd(8, '0'));
    if (shannons <= 0n) throw fail(400, 'Amount must be more than 0.');
    return shannons;
}

export function mainnetDailyLimit(): bigint {
    const raw = process.env.WALLET_MAINNET_DAILY_LIMIT_CKB;
    const value = raw === undefined || raw.trim() === '' ? 1000 : Number(raw);
    return Number.isFinite(value) && value > 0 ? BigInt(Math.floor(value)) * SHANNONS : 0n;
}

export function formatCkb(shannons: bigint): string {
    const whole = shannons / SHANNONS;
    const fraction = (shannons % SHANNONS).toString().padStart(8, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : `${whole}`;
}
