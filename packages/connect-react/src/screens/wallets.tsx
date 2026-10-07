// "Connect a wallet": the wallets CCC finds in this browser, like CCC's own
// connector, styled as part of the Corven Connect modal.

import { useEffect, useState } from 'react';

import { chainOf, rememberWallet, watchWallets, type WalletOption } from '../external-wallets';
import * as Icon from '../icons';
import { useConnectContext } from '../provider';
import { BackButton, ErrorText, Footer, Header, Spinner, messageOf } from '../ui';
import { rememberMethod } from './auth';

const SIGNER_LABEL: Record<string, string> = { CKB: 'CKB', EVM: 'EVM', BTC: 'BTC', Nostr: 'Nostr', Doge: 'Doge' };

export function WalletsScreen({ link }: { link?: boolean }) {
    const { connect, config, modal } = useConnectContext();
    const [wallets, setWallets] = useState<WalletOption[] | null>(null);
    const [open, setOpen] = useState<string | null>(null);
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let stop: (() => void) | null = null;
        let cancelled = false;
        watchWallets({ name: config?.name ?? document.title, icon: config?.logoUrl }, (list) => {
            if (!cancelled) setWallets(list);
        })
            .then((s) => {
                stop = s;
                if (cancelled) s();
                setWallets((w) => w ?? []);
            })
            .catch((e) => {
                setError(messageOf(e));
                setWallets([]);
            });
        return () => {
            cancelled = true;
            stop?.();
        };
    }, [config?.name, config?.logoUrl]);

    const choose = async (wallet: WalletOption, info: WalletOption['signers'][number]) => {
        setError(null);
        if (info.openLink) {
            // Not installed: CCC's link signer opens the wallet's install or app page.
            await info.signer.connect();
            return;
        }
        setPending(`${wallet.name}:${info.name}`);
        try {
            if (!(await info.signer.isConnected())) await info.signer.connect();
            const session = await connect.loginWithSigner(info.signer, { walletName: wallet.name, link });
            rememberWallet(connect.appId, { wallet: wallet.name, signer: info.name });
            rememberMethod('wallet');
            modal.finishLogin(session.isNewUser === true);
        } catch (e) {
            setError(messageOf(e));
        } finally {
            setPending(null);
        }
    };

    const installed = (wallets ?? []).filter((w) => w.signers.some((s) => !s.openLink));
    const others = (wallets ?? []).filter((w) => w.signers.every((s) => s.openLink));

    const row = (wallet: WalletOption) => {
        const usable = wallet.signers.filter((s) => !s.openLink);
        const list = usable.length ? usable : wallet.signers;
        const isOpen = open === wallet.name;
        const busyHere = pending?.startsWith(`${wallet.name}:`);
        return (
            <li key={wallet.name} style={{ borderBottom: '1px solid var(--cc-border)' }}>
                <button
                    type="button"
                    className="cc-wallet-row"
                    disabled={pending !== null}
                    onClick={() => (list.length === 1 ? void choose(wallet, list[0]) : setOpen(isOpen ? null : wallet.name))}
                    aria-expanded={list.length > 1 ? isOpen : undefined}
                >
                    <img src={wallet.icon} alt="" width={34} height={34} style={{ borderRadius: 10, flexShrink: 0, background: 'var(--cc-surface)' }} />
                    <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 14, fontWeight: 500 }}>{wallet.name}</span>
                        <span style={{ fontSize: 12, color: 'var(--cc-faint)' }}>
                            {usable.length ? list.map((s) => SIGNER_LABEL[chainOf(s.name)] ?? chainOf(s.name)).join(' · ') : 'Not installed'}
                        </span>
                    </span>
                    {busyHere ? <Spinner /> : usable.length ? list.length > 1 ? <Icon.Chevron size={14} /> : <Icon.ChevronRight /> : <Icon.External />}
                </button>
                {isOpen && list.length > 1 && (
                    <div className="cc-row" style={{ gap: 6, padding: '0 0 12px 46px', flexWrap: 'wrap' }}>
                        {list.map((s) => (
                            <button key={s.name} type="button" className="cc-pill" style={{ fontFamily: 'inherit', height: 30 }} disabled={pending !== null} onClick={() => void choose(wallet, s)}>
                                {pending === `${wallet.name}:${s.name}` ? <Spinner /> : null}
                                Use {SIGNER_LABEL[chainOf(s.name)] ?? chainOf(s.name)}
                            </button>
                        ))}
                    </div>
                )}
            </li>
        );
    };

    return (
        <>
            <Header left={<BackButton onClick={() => modal.setView({ screen: 'main', link })} />} center={<strong style={{ fontSize: 15 }}>Connect a wallet</strong>} onClose={modal.close} />

            <p style={{ margin: '18px 0 0', color: 'var(--cc-muted)', fontSize: 13.5 }}>
                {link ? 'Sign a message with your wallet to link it to this account.' : 'Sign in with a wallet you already have. You’ll sign a message; nothing is sent and there’s no fee.'}
            </p>

            {pending && (
                <div className="cc-note" style={{ marginTop: 14, alignItems: 'center' }}>
                    <Spinner />
                    <span>Approve the request in {pending.split(':')[0]}…</span>
                </div>
            )}

            {wallets === null ? (
                <div className="cc-row" style={{ justifyContent: 'center', padding: 40, color: 'var(--cc-muted)', gap: 8 }}>
                    <Spinner /> Looking for wallets…
                </div>
            ) : (
                <div style={{ marginTop: 10, overflowY: 'auto', minHeight: 0 }}>
                    {installed.length > 0 && (
                        <>
                            <div className="cc-section-label">Detected</div>
                            <ul className="cc-list" style={{ margin: 0 }}>
                                {installed.map(row)}
                            </ul>
                        </>
                    )}
                    {others.length > 0 && (
                        <>
                            <div className="cc-section-label" style={{ marginTop: 10 }}>
                                {installed.length ? 'More wallets' : 'No wallet found in this browser. Get one:'}
                            </div>
                            <ul className="cc-list" style={{ margin: 0 }}>
                                {others.map(row)}
                            </ul>
                        </>
                    )}
                </div>
            )}

            <ErrorText error={error} />
            <Footer />
        </>
    );
}
