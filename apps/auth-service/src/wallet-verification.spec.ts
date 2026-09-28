import { ccc } from '@ckb-ccc/core';

import { parseSignature, verifyWalletOwnership } from './wallet-verification';

// Fixed test keys; they hold nothing on any network.
const ALICE_KEY = '0x' + '11'.repeat(32);
const BOB_KEY = '0x' + '22'.repeat(32);

const MESSAGE = 'Corven wants you to sign in with your CKB wallet.\n\nNonce: 7f3a9c';

const client = new ccc.ClientPublicTestnet();

async function wallet(privateKey: string) {
    const signer = new ccc.SignerCkbPrivateKey(client, privateKey);
    return {
        address: await signer.getRecommendedAddress(),
        sign: (message: string) => signer.signMessage(message),
    };
}

describe('verifyWalletOwnership', () => {
    it('accepts a signature from the wallet that owns the address', async () => {
        const alice = await wallet(ALICE_KEY);

        await expect(
            verifyWalletOwnership({
                message: MESSAGE,
                walletAddress: alice.address,
                signature: await alice.sign(MESSAGE),
            }),
        ).resolves.toEqual({ ok: true });
    });

    it("rejects a valid signature from a different wallet claiming someone else's address", async () => {
        const alice = await wallet(ALICE_KEY);
        const bob = await wallet(BOB_KEY);

        // Bob asks to sign in as Alice and signs the challenge with his own key.
        await expect(
            verifyWalletOwnership({
                message: MESSAGE,
                walletAddress: alice.address,
                signature: await bob.sign(MESSAGE),
            }),
        ).resolves.toEqual({ ok: false, reason: 'address_mismatch' });
    });

    it('rejects a signature for a different message (e.g. an old challenge)', async () => {
        const alice = await wallet(ALICE_KEY);

        await expect(
            verifyWalletOwnership({
                message: MESSAGE,
                walletAddress: alice.address,
                signature: await alice.sign(MESSAGE.replace('7f3a9c', '000000')),
            }),
        ).resolves.toEqual({ ok: false, reason: 'invalid_signature' });
    });

    it('rejects a tampered signature', async () => {
        const alice = await wallet(ALICE_KEY);
        const signature = await alice.sign(MESSAGE);
        // Change one byte of r (the last byte is the recovery id, which the
        // check doesn't need because the public key is known).
        const byte = signature.signature.slice(10, 12);
        const flipped =
            signature.signature.slice(0, 10) + (byte === 'ff' ? '00' : 'ff') + signature.signature.slice(12);

        await expect(
            verifyWalletOwnership({
                message: MESSAGE,
                walletAddress: alice.address,
                signature: new ccc.Signature(flipped, signature.identity, signature.signType),
            }),
        ).resolves.toMatchObject({ ok: false });
    });
});

describe('parseSignature', () => {
    it('rebuilds a signature sent as JSON', async () => {
        const alice = await wallet(ALICE_KEY);
        const signature = await alice.sign(MESSAGE);

        const parsed = parseSignature(JSON.parse(JSON.stringify(signature)));

        expect(parsed).toBeInstanceOf(ccc.Signature);
        expect(parsed).toMatchObject({
            signature: signature.signature,
            identity: signature.identity,
            signType: signature.signType,
        });
    });

    it.each([
        null,
        'a string',
        {},
        { signature: '0x00', identity: '0x00' },
        { signature: '0x00', identity: '0x00', signType: 'NotARealType' },
        { signature: 1, identity: '0x00', signType: ccc.SignerSignType.CkbSecp256k1 },
    ])('returns null for %j', (raw) => {
        expect(parseSignature(raw)).toBeNull();
    });
});
