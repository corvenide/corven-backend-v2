// Wallets the user already has, found through CCC (@ckb-ccc/ccc): JoyID,
// MetaMask and other EVM wallets (EIP-6963), UniSat, OKX, Xverse, UTXO
// Global, Rei, Nostr... CCC is loaded only when the wallet list opens, so
// apps that don't use wallet sign-in don't pay for it.

export interface WalletOption {
    name: string;
    icon: string;
    signers: { name: string; signer: any; openLink: boolean }[];
}

export interface StoredWallet {
    wallet: string;
    signer: string;
}

let cccModule: Promise<any> | null = null;

export function loadCcc(): Promise<any> {
    cccModule ??= import('@ckb-ccc/ccc').catch((error) => {
        cccModule = null;
        throw new Error(
            `Wallet sign-in needs the @ckb-ccc/ccc package. Install it in your app (npm i @ckb-ccc/ccc). (${error instanceof Error ? error.message : error})`,
        );
    });
    return cccModule;
}

/** Watches the installed wallets; `onUpdate` fires as wallets announce themselves. Returns a stop function. */
export async function watchWallets(app: { name: string; icon?: string | null }, onUpdate: (wallets: WalletOption[]) => void): Promise<() => void> {
    const { ccc } = await loadCcc();
    const controller = new ccc.SignersController();
    const client = new ccc.ClientPublicTestnet();

    await controller.refresh(
        client,
        (wallets: { name: string; icon: string; signers: { name: string; signer: any }[] }[]) =>
            onUpdate(
                wallets.map((w) => ({
                    name: w.name,
                    icon: w.icon,
                    signers: onePerChain(w.signers).map((s) => ({ name: s.name, signer: s.signer, openLink: s.signer instanceof ccc.SignerOpenLink })),
                })),
            ),
        { name: app.name, ...(app.icon ? { icon: app.icon } : {}) },
    );
    return () => controller.disconnect();
}

/**
 * Wallets like JoyID offer many signers ("BTC", "BTC Testnet (P2TR)"...).
 * Sign-in only needs one per chain: keep the first CKB, EVM, BTC, Nostr...
 * The stored name stays CCC's, so the same signer is found again later.
 */
function onePerChain<T extends { name: string }>(signers: T[]): T[] {
    const seen = new Set<string>();
    return signers.filter((s) => {
        const chain = s.name.split(/[\s(]/)[0];
        if (seen.has(chain)) return false;
        seen.add(chain);
        return true;
    });
}

export const chainOf = (signerName: string) => signerName.split(/[\s(]/)[0];

const key = (appId: string) => `corven-connect:${appId}:wallet`;

export function rememberWallet(appId: string, value: StoredWallet | null): void {
    try {
        if (value) localStorage.setItem(key(appId), JSON.stringify(value));
        else localStorage.removeItem(key(appId));
    } catch {
        /* ignore */
    }
}

export function rememberedWallet(appId: string): StoredWallet | null {
    try {
        const raw = localStorage.getItem(key(appId));
        return raw ? (JSON.parse(raw) as StoredWallet) : null;
    } catch {
        return null;
    }
}

/** Finds the remembered wallet's signer again (after a reload). `connect` asks the wallet if it isn't connected. */
export async function findRememberedSigner(
    app: { name: string; icon?: string | null },
    stored: StoredWallet,
    { connect, timeoutMs = 2500 }: { connect: boolean; timeoutMs?: number },
): Promise<any | null> {
    let stop: (() => void) | null = null;
    try {
        const signer = await new Promise<any | null>((resolve) => {
            const timer = setTimeout(() => resolve(null), timeoutMs);
            void watchWallets(app, (wallets) => {
                const match = wallets.find((w) => w.name === stored.wallet)?.signers.find((s) => s.name === stored.signer && !s.openLink);
                if (match) {
                    clearTimeout(timer);
                    resolve(match.signer);
                }
            }).then((s) => (stop = s));
        });
        if (!signer) return null;
        if (await signer.isConnected()) return signer;
        if (!connect) return null;
        await signer.connect();
        return (await signer.isConnected()) ? signer : null;
    } finally {
        (stop as (() => void) | null)?.();
    }
}
