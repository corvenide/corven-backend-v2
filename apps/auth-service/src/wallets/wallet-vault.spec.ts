// apps/auth-service/src/wallets/wallet-vault.spec.ts

import { randomBytes } from 'node:crypto';

import { masterKeyFromEnv, WalletVault } from './wallet-vault';
import { parseCkbAmount } from './wallet-amounts';

const binding = { userId: 'user-1', network: 'TESTNET', address: 'ckt1qexample' };

describe('WalletVault', () => {
    const vault = new WalletVault(randomBytes(32));

    it('round-trips a private key', async () => {
        const key = randomBytes(32);
        const sealed = vault.seal(key, binding);

        expect(sealed.encryptedKey).not.toContain(key.toString('hex'));
        await expect(vault.withPrivateKey(sealed, binding, async (hex) => hex)).resolves.toBe(`0x${key.toString('hex')}`);
    });

    it('uses a fresh data key and IV every time', () => {
        const key = randomBytes(32);
        const a = vault.seal(key, binding);
        const b = vault.seal(key, binding);
        expect(a.encryptedKey).not.toBe(b.encryptedKey);
        expect(a.wrappedDataKey).not.toBe(b.wrappedDataKey);
    });

    it('refuses another master key, another wallet, or tampered data', async () => {
        const sealed = vault.seal(randomBytes(32), binding);
        const use = async () => 'decrypted';

        await expect(new WalletVault(randomBytes(32)).withPrivateKey(sealed, binding, use)).rejects.toThrow(/could not be decrypted/);
        await expect(vault.withPrivateKey(sealed, { ...binding, userId: 'user-2' }, use)).rejects.toThrow(/could not be decrypted/);
        await expect(vault.withPrivateKey(sealed, { ...binding, network: 'MAINNET' }, use)).rejects.toThrow(/could not be decrypted/);

        const raw = Buffer.from(sealed.encryptedKey, 'base64');
        raw[raw.length - 1] ^= 1;
        await expect(vault.withPrivateKey({ ...sealed, encryptedKey: raw.toString('base64') }, binding, use)).rejects.toThrow(/could not be decrypted/);
    });

    it('reads WALLET_ENCRYPTION_KEY as base64 or hex', () => {
        const key = randomBytes(32);
        expect(masterKeyFromEnv(key.toString('base64'))?.equals(key)).toBe(true);
        expect(masterKeyFromEnv(key.toString('hex'))?.equals(key)).toBe(true);
        expect(masterKeyFromEnv('')).toBeNull();
        expect(() => masterKeyFromEnv('too-short')).toThrow(/32 bytes/);
    });
});

describe('parseCkbAmount', () => {
    it('parses CKB to shannons', () => {
        expect(parseCkbAmount('100')).toBe(10_000_000_000n);
        expect(parseCkbAmount('12.5')).toBe(1_250_000_000n);
        expect(parseCkbAmount('0.00000001')).toBe(1n);
    });

    it('rejects bad amounts', () => {
        for (const bad of ['', '0', '-1', '1.123456789', '1e3', 'abc']) {
            expect(() => parseCkbAmount(bad)).toThrow();
        }
    });
});
