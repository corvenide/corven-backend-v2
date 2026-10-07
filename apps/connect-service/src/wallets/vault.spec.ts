import { randomBytes } from 'node:crypto';

import { masterKeyFromEnv, Vault } from './vault';

describe('Connect vault', () => {
    const binding = { userId: 'u1', network: 'TESTNET', address: 'ckt1abc' };

    it('round-trips a key', async () => {
        const vault = new Vault(randomBytes(32));
        const key = randomBytes(32);
        const sealed = vault.seal(key, binding);
        expect(sealed.encryptedKey).not.toContain(key.toString('hex'));
        await expect(vault.withPrivateKey(sealed, binding, async (k) => k)).resolves.toBe(`0x${key.toString('hex')}`);
    });

    it('refuses a ciphertext moved to another wallet', async () => {
        const vault = new Vault(randomBytes(32));
        const sealed = vault.seal(randomBytes(32), binding);
        await expect(vault.withPrivateKey(sealed, { ...binding, userId: 'u2' }, async (k) => k)).rejects.toThrow(/decrypted/);
    });

    it('refuses the wrong master key', async () => {
        const sealed = new Vault(randomBytes(32)).seal(randomBytes(32), binding);
        await expect(new Vault(randomBytes(32)).withPrivateKey(sealed, binding, async (k) => k)).rejects.toThrow();
    });

    it('parses base64 and hex master keys', () => {
        const raw = randomBytes(32);
        expect(masterKeyFromEnv(raw.toString('base64'))!.equals(raw)).toBe(true);
        expect(masterKeyFromEnv(raw.toString('hex'))!.equals(raw)).toBe(true);
        expect(masterKeyFromEnv('')).toBeNull();
        expect(() => masterKeyFromEnv('short')).toThrow();
    });
});
