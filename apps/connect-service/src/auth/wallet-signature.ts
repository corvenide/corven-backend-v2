// apps/connect-service/src/auth/wallet-signature.ts
//
// Sign-in with a wallet the user already has (JoyID, MetaMask and other
// EVM wallets, UniSat/OKX/Xverse and other BTC wallets, Nostr, UTXO Global,
// Rei...). The SDK gets those signers from CCC.
//
// A valid signature only proves control of the key in `signature.identity`.
// Wallet ownership also needs that key to control the claimed CKB address,
// otherwise anyone could sign a challenge for someone else's address. The
// check derives addresses from the key only, offline. (Same approach as the
// IDE's wallet sign-in, kept separate so Connect can change on its own.)
//
// Identities are CKB *testnet* addresses: one stable id per wallet.

import { ccc } from '@ckb-ccc/core';

import { fail } from '../http/errors';

const testnet = new ccc.ClientPublicTestnet();

/** Parses and normalizes a testnet address; rejects mainnet and junk. */
export async function normalizeWalletAddress(value: unknown): Promise<string> {
    const text = String(value ?? '').trim();
    if (text.startsWith('ckb1')) throw fail(400, 'Use your wallet\'s testnet (ckt1…) address to sign in.', 'invalid_address');
    try {
        const address = await ccc.Address.fromString(text, testnet);
        return address.toString();
    } catch {
        throw fail(400, 'That isn\'t a valid CKB address.', 'invalid_address');
    }
}

export function parseSignature(raw: unknown): ccc.Signature | null {
    if (!raw || typeof raw !== 'object') return null;
    const { signature, identity, signType } = raw as Record<string, unknown>;
    if (
        typeof signature !== 'string' ||
        typeof identity !== 'string' ||
        typeof signType !== 'string' ||
        signature.length > 10_000 ||
        identity.length > 4_000 ||
        !Object.values(ccc.SignerSignType).includes(signType as ccc.SignerSignType)
    ) {
        return null;
    }
    return new ccc.Signature(signature, identity, signType as ccc.SignerSignType);
}

async function anyAddressMatches(signer: ccc.Signer, claimed: ccc.Script): Promise<boolean> {
    return (await signer.getAddressObjs()).some((a) => a.script.eq(claimed));
}

/** Does the signing key control `claimed`? null when the signer type can't be checked offline. */
async function keyControls(signature: ccc.Signature, claimed: ccc.Script): Promise<boolean | null> {
    const { identity, signType } = signature;

    switch (signType) {
        case ccc.SignerSignType.CkbSecp256k1: {
            const blake160 = ccc.hashCkbShort(identity);
            const secp = await ccc.Script.fromKnownScript(testnet, ccc.KnownScript.Secp256k1Blake160, blake160);
            if (claimed.eq(secp)) return true;
            const acp = await ccc.Script.fromKnownScript(testnet, ccc.KnownScript.AnyoneCanPay, blake160);
            return claimed.codeHash === acp.codeHash && claimed.hashType === acp.hashType && claimed.args.startsWith(acp.args);
        }
        case ccc.SignerSignType.JoyId: {
            let parsed: { keyType?: string; publicKey?: string };
            try {
                parsed = JSON.parse(identity);
            } catch {
                return null;
            }
            // Sub-keys are authorised by on-chain COTA cells: not checkable offline.
            if (parsed.keyType !== 'main_key' || !parsed.publicKey) return null;
            const hash = ccc.hashCkbShort(`0x${parsed.publicKey.replace(/^0x/, '')}`);
            const joyId = await ccc.Script.fromKnownScript(testnet, ccc.KnownScript.JoyId, `0x0001${hash.slice(2)}`);
            return claimed.eq(joyId);
        }
        case ccc.SignerSignType.EvmPersonal:
            return anyAddressMatches(new ccc.SignerEvmAddressReadonly(testnet, identity), claimed);
        case ccc.SignerSignType.BtcEcdsa:
            return anyAddressMatches(new ccc.SignerBtcPublicKeyReadonly(testnet, '', identity), claimed);
        case ccc.SignerSignType.NostrEvent:
            return anyAddressMatches(new ccc.SignerNostrPublicKeyReadonly(testnet, identity), claimed);
        case ccc.SignerSignType.DogeEcdsa:
            return anyAddressMatches(new ccc.SignerDogeAddressReadonly(testnet, identity), claimed);
        default:
            return null;
    }
}

/** Throws unless `signature` signs `message` with a key that controls `address`. */
export async function verifyWalletSignature(message: string, address: string, rawSignature: unknown): Promise<void> {
    const signature = parseSignature(rawSignature);
    if (!signature) throw fail(400, 'Malformed wallet signature.', 'invalid_signature');

    let valid = false;
    try {
        valid = await ccc.Signer.verifyMessage(message, signature);
    } catch {
        valid = false;
    }
    if (!valid) throw fail(401, 'The wallet signature didn\'t check out. Try again.', 'invalid_signature');

    const claimed = await ccc.Address.fromString(address, testnet);
    let owns: boolean | null;
    try {
        owns = await keyControls(signature, claimed.script);
    } catch {
        owns = null;
    }
    if (owns === null) throw fail(400, 'This wallet type can\'t be used to sign in yet.', 'unsupported_signer');
    if (!owns) throw fail(401, 'That signature is from a different wallet than the address.', 'address_mismatch');
}

export function walletMessage(data: { host: string; appName: string; address: string; nonce: string; purpose: 'sign-in' | 'confirm' }): string {
    const lines =
        data.purpose === 'sign-in'
            ? [`${data.host} wants you to sign in to ${data.appName} with your CKB wallet:`, data.address]
            : [`${data.host} asks you to confirm a sensitive action in ${data.appName} with your CKB wallet:`, data.address];
    return [...lines, '', 'This request will not send a transaction or cost any fees.', '', `Nonce: ${data.nonce}`, `Issued At: ${new Date().toISOString()}`].join('\n');
}
