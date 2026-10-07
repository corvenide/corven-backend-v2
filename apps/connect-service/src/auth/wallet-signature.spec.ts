import { ccc } from '@ckb-ccc/core';

import { normalizeWalletAddress, verifyWalletSignature, walletMessage } from './wallet-signature';

const client = new ccc.ClientPublicTestnet();
const keyA = '0x' + '11'.repeat(32);
const keyB = '0x' + '22'.repeat(32);

describe('wallet sign-in signatures', () => {
    it('accepts a signature from the address owner', async () => {
        const signer = new ccc.SignerCkbPrivateKey(client, keyA);
        const address = await signer.getRecommendedAddress();
        const message = walletMessage({ host: 'app.example', appName: 'Demo', address, nonce: 'n1', purpose: 'sign-in' });
        const signature = await signer.signMessage(message);
        await expect(verifyWalletSignature(message, address, signature)).resolves.toBeUndefined();
    });

    it('refuses a valid signature from a different key', async () => {
        const victim = await new ccc.SignerCkbPrivateKey(client, keyA).getRecommendedAddress();
        const attacker = new ccc.SignerCkbPrivateKey(client, keyB);
        const message = walletMessage({ host: 'app.example', appName: 'Demo', address: victim, nonce: 'n2', purpose: 'sign-in' });
        await expect(verifyWalletSignature(message, victim, await attacker.signMessage(message))).rejects.toMatchObject({ status: 401 });
    });

    it('refuses a signature over another message', async () => {
        const signer = new ccc.SignerCkbPrivateKey(client, keyA);
        const address = await signer.getRecommendedAddress();
        const signature = await signer.signMessage('something else');
        await expect(verifyWalletSignature('the real message', address, signature)).rejects.toMatchObject({ status: 401 });
    });

    it('refuses malformed signatures and mainnet addresses', async () => {
        await expect(verifyWalletSignature('m', 'ckt1x', { signature: 1 })).rejects.toMatchObject({ status: 400 });
        const mainnet = await new ccc.SignerCkbPrivateKey(new ccc.ClientPublicMainnet(), keyA).getRecommendedAddress();
        await expect(normalizeWalletAddress(mainnet)).rejects.toMatchObject({ status: 400 });
        await expect(normalizeWalletAddress('nonsense')).rejects.toMatchObject({ status: 400 });
    });

    it('says what the signature is for', () => {
        const m = walletMessage({ host: 'app.example', appName: 'Demo', address: 'ckt1abc', nonce: 'n', purpose: 'sign-in' });
        expect(m).toContain('app.example wants you to sign in to Demo');
        expect(m).toContain('will not send a transaction');
    });
});
