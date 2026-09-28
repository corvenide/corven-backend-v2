// apps/auth-service/src/wallet-verification.ts
//
// Proves that a signature was produced by the wallet that controls
// `walletAddress`.
//
// `ccc.Signer.verifyMessage` only proves that the signature is valid for
// the key in `signature.identity`. It says nothing about which CKB address
// that key controls. Without the ownership check below, anyone could
// request a challenge for someone else's address, sign it with their own
// key, and log in as that person.

import { ccc } from '@ckb-ccc/core';

export type WalletVerificationFailure =
    | 'invalid_signature'
    | 'address_mismatch'
    | 'unsupported_signer';

export type WalletVerificationResult =
    | { ok: true }
    | { ok: false; reason: WalletVerificationFailure };

export function clientForAddress(address: string): ccc.Client {
    return address.startsWith('ckb1')
        ? new ccc.ClientPublicMainnet()
        : new ccc.ClientPublicTestnet();
}

/** Parses a signature that crossed the wire as plain JSON. */
export function parseSignature(raw: unknown): ccc.Signature | null {
    if (!raw || typeof raw !== 'object') return null;

    const { signature, identity, signType } = raw as Record<string, unknown>;

    if (
        typeof signature !== 'string' ||
        typeof identity !== 'string' ||
        typeof signType !== 'string' ||
        !Object.values(ccc.SignerSignType).includes(signType as ccc.SignerSignType)
    ) {
        return null;
    }

    return new ccc.Signature(signature, identity, signType as ccc.SignerSignType);
}

/**
 * Does the signing key control `claimed`? Everything is derived from the
 * key in the signature, never from what the client says, and without
 * network calls.
 *
 * Returns null when the signer type can't be checked offline.
 */
async function keyControlsScript(
    signature: ccc.Signature,
    claimed: ccc.Script,
    client: ccc.Client,
): Promise<boolean | null> {
    const { identity, signType } = signature;

    switch (signType) {
        case ccc.SignerSignType.CkbSecp256k1: {
            // Mirrors SignerCkbPublicKey: the default secp256k1-blake160 lock,
            // plus anyone-can-pay locks whose args start with the same hash.
            const blake160 = ccc.hashCkbShort(identity);

            const secp = await ccc.Script.fromKnownScript(
                client,
                ccc.KnownScript.Secp256k1Blake160,
                blake160,
            );

            if (claimed.eq(secp)) return true;

            const acp = await ccc.Script.fromKnownScript(
                client,
                ccc.KnownScript.AnyoneCanPay,
                blake160,
            );

            return (
                claimed.codeHash === acp.codeHash &&
                claimed.hashType === acp.hashType &&
                claimed.args.startsWith(acp.args)
            );
        }

        case ccc.SignerSignType.JoyId:
            return joyIdControls(identity, claimed, client);

        case ccc.SignerSignType.EvmPersonal:
            return anyAddressMatches(new ccc.SignerEvmAddressReadonly(client, identity), claimed);

        case ccc.SignerSignType.BtcEcdsa:
            return anyAddressMatches(new ccc.SignerBtcPublicKeyReadonly(client, '', identity), claimed);

        case ccc.SignerSignType.NostrEvent:
            return anyAddressMatches(new ccc.SignerNostrPublicKeyReadonly(client, identity), claimed);

        case ccc.SignerSignType.DogeEcdsa:
            return anyAddressMatches(new ccc.SignerDogeAddressReadonly(client, identity), claimed);

        default:
            return null;
    }
}

async function anyAddressMatches(signer: ccc.Signer, claimed: ccc.Script): Promise<boolean> {
    const addresses = await signer.getAddressObjs();
    return addresses.some((address) => address.script.eq(claimed));
}

/**
 * JoyID main keys: lock args are `0x0001` followed by the 20-byte
 * blake160 hash of the secp256r1 public key. Sub-keys (keyType
 * `sub_key`) are authorised through on-chain COTA cells and can't be
 * checked offline, so they're rejected.
 */
async function joyIdControls(
    identity: string,
    claimed: ccc.Script,
    client: ccc.Client,
): Promise<boolean | null> {
    let parsed: { keyType?: string; publicKey?: string };

    try {
        parsed = JSON.parse(identity);
    } catch {
        return null;
    }

    if (parsed.keyType !== 'main_key' || !parsed.publicKey) {
        return null;
    }

    const pubKeyHash = ccc.hashCkbShort(`0x${parsed.publicKey.replace(/^0x/, '')}`);

    const joyId = await ccc.Script.fromKnownScript(
        client,
        ccc.KnownScript.JoyId,
        `0x0001${pubKeyHash.slice(2)}`,
    );

    return claimed.eq(joyId);
}

export async function verifyWalletOwnership(input: {
    message: string;
    walletAddress: string;
    signature: ccc.Signature;
}): Promise<WalletVerificationResult> {
    let valid = false;

    try {
        valid = await ccc.Signer.verifyMessage(input.message, input.signature);
    } catch {
        valid = false;
    }

    if (!valid) {
        return { ok: false, reason: 'invalid_signature' };
    }

    const client = clientForAddress(input.walletAddress);

    const claimed = await ccc.Address.fromString(input.walletAddress, client);

    let owns: boolean | null;

    try {
        owns = await keyControlsScript(input.signature, claimed.script, client);
    } catch {
        owns = null;
    }

    if (owns === null) {
        return { ok: false, reason: 'unsupported_signer' };
    }

    return owns ? { ok: true } : { ok: false, reason: 'address_mismatch' };
}
