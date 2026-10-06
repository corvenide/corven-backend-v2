// apps/auth-service/src/wallets/wallet-vault.ts
//
// Encryption for the private keys of Corven-held wallets (envelope
// encryption, AES-256-GCM):
//
//   private key --(data key)--> encryptedKey     one random data key per wallet
//   data key    --(master key)--> wrappedDataKey  master key: WALLET_ENCRYPTION_KEY
//
// Both ciphertexts are bound to the wallet (user, network, address) through
// GCM's associated data, so a ciphertext copied onto another row won't
// decrypt. The master key never touches the database. To move the master
// key into a KMS later, only wrap/unwrap of the data key changes.
//
// WALLET_ENCRYPTION_KEY: 32 random bytes, base64 or hex
//   (e.g. `openssl rand -base64 32`). Losing it makes every wallet
//   unrecoverable, so back it up somewhere other than the server.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const CURRENT_KEY_VERSION = 1;

const IV_BYTES = 12;
const TAG_BYTES = 16;

export class WalletVaultError extends Error { }

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

/** Parses WALLET_ENCRYPTION_KEY; null when unset. Throws when malformed. */
export function masterKeyFromEnv(value = process.env.WALLET_ENCRYPTION_KEY): Buffer | null {
    const raw = value?.trim();
    if (!raw) return null;

    const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) {
        throw new WalletVaultError('WALLET_ENCRYPTION_KEY must be 32 bytes (base64 or hex).');
    }
    return key;
}

function aad(binding: WalletBinding, part: 'key' | 'data-key'): Buffer {
    return Buffer.from(`corven-wallet:v1:${part}:${binding.userId}:${binding.network}:${binding.address}`, 'utf8');
}

function seal(key: Buffer, plaintext: Buffer, associated: Buffer): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(associated);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function open(key: Buffer, sealed: string, associated: Buffer): Buffer {
    const raw = Buffer.from(sealed, 'base64');
    if (raw.length <= IV_BYTES + TAG_BYTES) throw new WalletVaultError('Corrupt wallet key.');

    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(associated);
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));

    try {
        return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
    } catch {
        throw new WalletVaultError('Wallet key could not be decrypted (wrong master key or tampered data).');
    }
}

export class WalletVault {
    constructor(private readonly masterKey: Buffer) {
        if (masterKey.length !== 32) throw new WalletVaultError('Master key must be 32 bytes.');
    }

    /** Encrypts a 32-byte private key for one wallet. */
    seal(privateKey: Buffer, binding: WalletBinding): SealedKey {
        if (privateKey.length !== 32) throw new WalletVaultError('Private key must be 32 bytes.');

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

    /**
     * Decrypts a wallet's private key, passes it to `use`, then wipes the
     * buffers. Keep `use` short: sign and return.
     */
    async withPrivateKey<T>(sealed: SealedKey, binding: WalletBinding, use: (privateKeyHex: string) => Promise<T>): Promise<T> {
        if (sealed.keyVersion !== CURRENT_KEY_VERSION) {
            throw new WalletVaultError(`Wallet uses master key version ${sealed.keyVersion}, which isn't loaded.`);
        }

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
