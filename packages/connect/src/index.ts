import { ccc } from '@ckb-ccc/core';

import { CorvenConnect } from './client';
import { CorvenConnectError } from './errors';
import { CorvenConnectSigner } from './signer';
import type { Network } from './types';

export { CorvenConnect, createCorvenConnect, DEFAULT_API_URL, type CorvenConnectOptions } from './client';
export { CorvenConnectSigner, describe as describeTransaction } from './signer';
export { CorvenConnectError, UserRejectedError } from './errors';
export { browserStorage, memoryStorage, type TokenStorage } from './storage';
export * from './types';

/** Short display form: ckt1qzda0cr08m85hc…4vk9x3 */
export function shortAddress(address: string, head = 16, tail = 6): string {
    return address.length > head + tail + 1 ? `${address.slice(0, head)}…${address.slice(-tail)}` : address;
}

/** Shannons → "1,250.00" (CKB). */
export function formatCkb(shannons: bigint | string | number, decimals = 2): string {
    const value = BigInt(shannons);
    const negative = value < 0n;
    const abs = negative ? -value : value;
    const whole = abs / 100_000_000n;
    const fraction = (abs % 100_000_000n).toString().padStart(8, '0').slice(0, decimals);
    const text = `${whole.toLocaleString('en-US')}${decimals > 0 ? `.${fraction}` : ''}`;
    return negative ? `-${text}` : text;
}

declare module './client' {
    interface CorvenConnect {
        /**
         * A ccc signer for the signed-in user's wallet. Pass your own ccc client
         * (e.g. a devnet or custom RPC); defaults to the public testnet/mainnet.
         *
         * For people who signed in with their own wallet this is that wallet's
         * CCC signer (testnet), and their wallet shows its own approval prompt.
         */
        getSigner(network?: Network, client?: ccc.Client): ccc.Signer;
    }
}

CorvenConnect.prototype.getSigner = function getSigner(this: CorvenConnect, network: Network = 'TESTNET', client?: ccc.Client): ccc.Signer {
    const user = this.user;
    if (user && !user.embeddedWallets) {
        const external = this.externalWallet;
        if (!external) throw new CorvenConnectError('Reconnect your wallet to sign.', 0, 'wallet_disconnected');
        if (network !== 'TESTNET') throw new CorvenConnectError('Your own wallet is connected on testnet. Switch networks in your wallet app.', 0, 'unsupported_network');
        return external.signer as unknown as ccc.Signer;
    }
    const wallet = user?.wallets.find((w) => w.network === network);
    if (!wallet) throw new CorvenConnectError('Sign in first.', 401, 'unauthorized');
    const ckb = client ?? (network === 'MAINNET' ? new ccc.ClientPublicMainnet() : new ccc.ClientPublicTestnet());
    return new CorvenConnectSigner(ckb, wallet.publicKey, this, network);
};
