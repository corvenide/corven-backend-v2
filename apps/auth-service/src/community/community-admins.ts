// apps/auth-service/src/community/community-admins.ts
//
// Which wallets may publish news and moderate the community board.
//
// Set COMMUNITY_ADMIN_WALLETS to a comma-separated list of CKB addresses.
// Addresses are compared by the lock script they encode, not as strings, so
// the short and full encodings of the same wallet both match.

import { ccc } from '@ckb-ccc/core';

/** Corven's donation wallet. It is also the default community admin. */
export const DEFAULT_COMMUNITY_ADMIN =
    'ckt1qrejnmlar3r452tcg57gvq8patctcgy8acync0hxfnyka35ywafvkqgjnwwhj6rdh5x73h663l9zdnxpntqzu5enqq9f6ccr';

function clientFor(address: string): ccc.Client {
    return address.startsWith('ckb1') ? new ccc.ClientPublicMainnet() : new ccc.ClientPublicTestnet();
}

/** The lock script an address encodes, or null if it isn't a valid address. */
async function lockOf(address: string): Promise<ccc.Script | null> {
    try {
        return (await ccc.Address.fromString(address.trim(), clientFor(address.trim()))).script;
    } catch {
        return null;
    }
}

export function adminAddressesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
    const raw = env.COMMUNITY_ADMIN_WALLETS?.trim();
    const list = raw ? raw.split(',') : [DEFAULT_COMMUNITY_ADMIN];
    return list.map((address) => address.trim()).filter(Boolean);
}

export class CommunityAdmins {
    private locks: Promise<ccc.Script[]> | null = null;

    constructor(private readonly addresses: string[] = adminAddressesFromEnv()) { }

    private adminLocks(): Promise<ccc.Script[]> {
        this.locks ??= Promise.all(this.addresses.map(lockOf)).then((locks) =>
            locks.filter((lock): lock is ccc.Script => lock !== null),
        );
        return this.locks;
    }

    /** Whether this wallet address belongs to an admin. */
    async isAdmin(walletAddress: string | null | undefined): Promise<boolean> {
        if (!walletAddress) return false;

        const lock = await lockOf(walletAddress);
        if (!lock) return false;

        return (await this.adminLocks()).some((admin) => admin.eq(lock));
    }
}
