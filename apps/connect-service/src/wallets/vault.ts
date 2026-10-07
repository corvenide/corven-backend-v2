// apps/connect-service/src/wallets/vault.ts
//
// Envelope encryption for Connect wallet keys (AES-256-GCM): each private
// key is sealed with its own random data key, and the data key with the
// master key CONNECT_WALLET_ENCRYPTION_KEY. Both are bound to the wallet
// (app user, network, address) via GCM associated data, so a ciphertext
// copied onto another row won't decrypt.
//
// The master key is separate from the IDE's WALLET_ENCRYPTION_KEY. Back it
// up off the server: losing it makes every Connect wallet unrecoverable.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const CURRENT_KEY_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class VaultError extends Error { }

export interface SealedKey {
    encryptedKey: string;
    wrappedDataKey: string;
    keyVersion: number;
}

export interface WalletBinding {
    userId: string;
    network: string;
    address: string;
}

export function masterKeyFromEnv(value = process.env.CONNECT_WALLET_ENCRYPTION_KEY): Buffer | null {
    const raw = value?.trim();
    if (!raw) return null;
    const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new VaultError('CONNECT_WALLET_ENCRYPTION_KEY must be 32 bytes (base64 or hex).');
    return key;
}

const aad = (b: WalletBinding, part: 'key' | 'data-key') =>
    Buffer.from(`corven-connect:v1:${part}:${b.userId}:${b.network}:${b.address}`, 'utf8');

function seal(key: Buffer, plaintext: Buffer, associated: Buffer): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(associated);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function open(key: Buffer, sealed: string, associated: Buffer): Buffer {
    const raw = Buffer.from(sealed, 'base64');
    if (raw.length <= IV_BYTES + TAG_BYTES) throw new VaultError('Corrupt wallet key.');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(associated);
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    try {
        return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
    } catch {
        throw new VaultError('Wallet key could not be decrypted (wrong master key or tampered data).');
    }
}

export class Vault {
    constructor(private readonly masterKey: Buffer) {
        if (masterKey.length !== 32) throw new VaultError('Master key must be 32 bytes.');
    }

    seal(privateKey: Buffer, binding: WalletBinding): SealedKey {
        if (privateKey.length !== 32) throw new VaultError('Private key must be 32 bytes.');
        const dataKey = randomBytes(32);
        try {
            return {
                encryptedKey: seal(dataKey, privateKey, aad(binding, 'key')),
                wrappedDataKey: seal(this.masterKey, dataKey, aad(binding, 'data-key')),
                keyVersion: CURRENT_KEY_VERSION,
            };
        } finally {
            dataKey.fill(0);
        }
    }

    /** Decrypts the key, hands it to `use`, then wipes the buffers. */
    async withPrivateKey<T>(sealed: SealedKey, binding: WalletBinding, use: (privateKeyHex: string) => Promise<T>): Promise<T> {
        if (sealed.keyVersion !== CURRENT_KEY_VERSION) throw new VaultError(`Key version ${sealed.keyVersion} isn't loaded.`);
        const dataKey = open(this.masterKey, sealed.wrappedDataKey, aad(binding, 'data-key'));
        let privateKey: Buffer | null = null;
        try {
            privateKey = open(dataKey, sealed.encryptedKey, aad(binding, 'key'));
            return await use(`0x${privateKey.toString('hex')}`);
        } finally {
            dataKey.fill(0);
            privateKey?.fill(0);
        }
    }
}
