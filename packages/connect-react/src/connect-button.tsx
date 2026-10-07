// A ready-made button: "Sign in" when signed out, the wallet address
// (opens the wallet) when signed in.

import { shortAddress, type Network } from '@corven/connect';

import * as Icon from './icons';
import { useConnectContext, useCorvenConnect } from './provider';
import { cssVars } from './theme';

export function ConnectButton({ label = 'Sign in', network = 'TESTNET', className }: { label?: string; network?: Network; className?: string }) {
    const { tokens } = useConnectContext();
    const { ready, authenticated, user, login, openWallet } = useCorvenConnect();
    const address = user?.wallets.find((w) => w.network === network)?.address;

    const style = {
        ...(cssVars(tokens) as React.CSSProperties),
        background: authenticated ? tokens.surface : tokens.accent,
        color: authenticated ? tokens.text : tokens.accentText,
        border: authenticated ? `1px solid ${tokens.borderStrong}` : 0,
        opacity: ready ? 1 : 0.6,
    };

    return (
        <button type="button" className={`cc-root cc-connect-btn ${className ?? ''}`} style={style} disabled={!ready} onClick={authenticated ? openWallet : login}>
            {authenticated ? (
                <>
                    <span className="cc-dot" style={{ background: tokens.accent }} />
                    <span className="cc-mono" style={{ fontSize: 13 }}>
                        {address ? shortAddress(address, 8, 4) : 'Wallet'}
                    </span>
                </>
            ) : (
                <>
                    <Icon.Wallet />
                    {label}
                </>
            )}
        </button>
    );
}
