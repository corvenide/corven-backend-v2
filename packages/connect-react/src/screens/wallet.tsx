// The wallet: balance, send, receive, top up, export, activity and
// sign-in methods.

import { useCallback, useEffect, useState } from 'react';
import { ccc } from '@ckb-ccc/core';
import { formatCkb, shortAddress, UserRejectedError, type Network, type WalletsResponse } from '@corven/connect';

import * as Icon from '../icons';
import { useConnectContext } from '../provider';
import { BackButton, CopyButton, ErrorText, Header, Spinner, initials, maskPhone, messageOf, useAction } from '../ui';
import { StepUp } from './sign';

const FAUCET_URL = 'https://faucet.nervos.org/';

// Remembered across screens while the modal is open.
let selectedNetwork: Network = 'TESTNET';

function useWallets() {
    const { connect } = useConnectContext();
    const [data, setData] = useState<WalletsResponse | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(() => {
        setError(null);
        connect.getWallets().then(setData, (e) => setError(messageOf(e)));
    }, [connect]);

    useEffect(load, [load]);
    return { data, error, reload: load };
}

/** Balance of the user's own wallet, read through its CCC signer. */
function useExternalBalance(signer: any | null) {
    const [balance, setBalance] = useState<bigint | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!signer) return;
        let cancelled = false;
        signer.getBalance().then(
            (b: bigint) => !cancelled && setBalance(b),
            (e: unknown) => !cancelled && setError(messageOf(e)),
        );
        return () => {
            cancelled = true;
        };
    }, [signer]);
    return { balance, error };
}

/** The address people see and receive to: their own wallet's, or the embedded one. */
export function ownAddress(user: { embeddedWallets: boolean; identities: { kind: string; value: string | null }[]; wallets: { network: string; address: string }[] }, network: Network, external: { address: string } | null): string {
    if (!user.embeddedWallets) return external?.address ?? user.identities.find((i) => i.kind === 'WALLET')?.value ?? '';
    return user.wallets.find((w) => w.network === network)?.address ?? '';
}

function displayName(user: NonNullable<ReturnType<typeof useConnectContext>['state']['user']>): { name: string; detail: string } {
    const phone = user.identities.find((i) => i.kind === 'PHONE')?.value;
    const email = user.identities.find((i) => i.kind === 'EMAIL' || i.kind === 'GOOGLE')?.value;
    const wallet = user.identities.find((i) => i.kind === 'WALLET');
    const name = user.displayName ?? email?.split('@')[0] ?? (!phone && wallet ? (wallet.label ?? 'My wallet') : 'My wallet');
    return { name, detail: phone ? maskPhone(phone) : (email ?? (wallet?.value ? shortAddress(wallet.value, 10, 6) : '')) };
}

export function WalletScreen({ initialTab }: { initialTab?: 'activity' | 'logins' }) {
    const { state, config, modal, connect } = useConnectContext();
    const external = state.user?.embeddedWallets === false;
    const [tab, setTab] = useState<'activity' | 'logins'>(external ? 'logins' : (initialTab ?? 'activity'));
    const ext = connect.externalWallet;
    const extBalance = useExternalBalance(external ? (ext?.signer ?? null) : null);
    const [reconnecting, setReconnecting] = useState<string | null>(null);
    const [network, setNetworkState] = useState<Network>(config?.networks.includes(selectedNetwork) ? selectedNetwork : 'TESTNET');
    const { data, error, reload } = useWallets();
    const user = state.user;
    if (!user) return null;

    const setNetwork = (n: Network) => {
        selectedNetwork = n;
        setNetworkState(n);
    };
    const networks = external ? (['TESTNET'] as Network[]) : (config?.networks ?? ['TESTNET']);
    const wallet = data?.wallets.find((w) => w.network === network);
    const address = ownAddress(user, network, ext);
    const balance = external ? (extBalance.balance === null ? null : extBalance.balance.toString()) : (wallet?.balance ?? null);
    const balanceSettled = external ? extBalance.balance !== null || extBalance.error !== null || !ext : !!(data || error);
    const reconnect = async () => {
        setReconnecting('');
        try {
            const { findRememberedSigner, rememberedWallet } = await import('../external-wallets');
            const stored = rememberedWallet(connect.appId);
            const signer = stored && config ? await findRememberedSigner({ name: config.name, icon: config.logoUrl }, stored, { connect: true, timeoutMs: 5000 }) : null;
            if (!signer) throw new Error('Couldn’t reach your wallet. Open it and try again, or sign out and back in.');
            await connect.useExternalSigner(signer, stored!.wallet);
            setReconnecting(null);
        } catch (e) {
            setReconnecting(messageOf(e));
        }
    };
    const { name, detail } = displayName(user);
    const activity = (data?.activity ?? []).filter((a) => a.network === network);

    return (
        <>
            <div className="cc-between">
                <div className="cc-row" style={{ gap: 10, minWidth: 0 }}>
                    <span style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--cc-accent-soft)', color: 'var(--cc-accent-ink)', fontWeight: 600, fontSize: 13.5, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        {user.displayName || user.identities.some((i) => i.kind !== 'PHONE') ? initials(user.displayName, name) : <Icon.Wallet size={17} />}
                    </span>
                    <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
                        <div className="cc-mono" style={{ fontSize: 12, color: 'var(--cc-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {detail}
                        </div>
                    </div>
                </div>
                <button type="button" className="cc-icon-btn" aria-label="Close" onClick={modal.close}>
                    <Icon.Close />
                </button>
            </div>

            <div className="cc-card-surface" style={{ marginTop: 20 }}>
                <div className="cc-between">
                    <span style={{ fontSize: 12.5, color: 'var(--cc-muted)' }}>Total balance</span>
                    {networks.length > 1 ? (
                        <label className="cc-pill" style={{ position: 'relative', cursor: 'pointer' }}>
                            <span className="cc-dot" style={network === 'MAINNET' ? { background: '#f0b429' } : undefined} />
                            {network === 'MAINNET' ? 'CKB Mainnet' : 'CKB Testnet'}
                            <Icon.Chevron />
                            <select
                                aria-label="Network"
                                value={network}
                                onChange={(e) => setNetwork(e.target.value as Network)}
                                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
                            >
                                {networks.map((n) => (
                                    <option key={n} value={n}>
                                        {n === 'MAINNET' ? 'CKB Mainnet' : 'CKB Testnet'}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ) : (
                        <span className="cc-pill">
                            <span className="cc-dot" /> CKB Testnet
                        </span>
                    )}
                </div>
                <div className="cc-row" style={{ marginTop: 8, gap: 8, alignItems: 'baseline' }} data-testid="cc-balance">
                    {balance != null ? (
                        <span style={{ fontSize: 40, fontWeight: 600, letterSpacing: '-0.035em' }}>{formatCkb(balance)}</span>
                    ) : balanceSettled ? (
                        <span style={{ fontSize: 40, fontWeight: 600, letterSpacing: '-0.035em', color: 'var(--cc-faint)' }}>—</span>
                    ) : (
                        <span className="cc-skel" style={{ width: 170, height: 38, borderRadius: 10, margin: '4px 0' }} />
                    )}
                    <span style={{ fontSize: 17, color: 'var(--cc-muted)', fontWeight: 500 }}>CKB</span>
                </div>
                {external ? (
                    <div style={{ fontSize: 12.5, color: 'var(--cc-faint)', marginTop: 2 }}>
                        {ext ? `Your own wallet: ${ext.walletName}. It asks you to approve each transaction.` : 'Your own wallet isn’t connected in this tab.'}
                    </div>
                ) : (
                    network === 'TESTNET' && <div style={{ fontSize: 12.5, color: 'var(--cc-faint)', marginTop: 2 }}>Testnet CKB has no value.</div>
                )}
                <CopyButton value={address} label="Copy address" className="cc-field cc-copy">
                    <span className="cc-mono" style={{ flex: 1, textAlign: 'left', fontSize: 13, color: 'var(--cc-muted)' }}>
                        {shortAddress(address)}
                    </span>
                </CopyButton>
            </div>

            {external && !ext && (
                <>
                    <button type="button" className="cc-btn cc-btn-primary" style={{ marginTop: 10, height: 46 }} onClick={() => void reconnect()} disabled={reconnecting === ''}>
                        {reconnecting === '' ? <Spinner /> : <Icon.Wallet />} Reconnect your wallet
                    </button>
                    {reconnecting && <ErrorText error={reconnecting} />}
                </>
            )}

            <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: `repeat(${external ? 3 : 4}, minmax(0, 1fr))`, gap: 8 }}>
                <button type="button" className="cc-action cc-action-primary" disabled={external && !ext} onClick={() => modal.setView({ screen: 'send' })}>
                    <Icon.Send />
                    Send
                </button>
                <button type="button" className="cc-action" onClick={() => modal.setView({ screen: 'receive' })}>
                    <Icon.Receive />
                    Receive
                </button>
                {network === 'TESTNET' ? (
                    <a className="cc-action" href={FAUCET_URL} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }} onClick={() => setTimeout(reload, 15_000)}>
                        <Icon.Plus />
                        Top up
                    </a>
                ) : (
                    <button type="button" className="cc-action" onClick={() => modal.setView({ screen: 'receive' })}>
                        <Icon.Plus />
                        Top up
                    </button>
                )}
                {!external && (
                    <button type="button" className="cc-action" onClick={() => modal.setView({ screen: 'export' })}>
                        <Icon.Key />
                        Export
                    </button>
                )}
            </div>

            <div role="tablist" className="cc-utabs" style={{ marginTop: 18 }}>
                {!external && (
                    <button type="button" role="tab" className="cc-utab" aria-selected={tab === 'activity'} onClick={() => setTab('activity')}>
                        Activity
                    </button>
                )}
                <button type="button" role="tab" className="cc-utab" aria-selected={tab === 'logins'} onClick={() => setTab('logins')}>
                    Sign-in methods
                </button>
            </div>

            <div style={{ minHeight: 150 }}>
                {tab === 'activity' ? (
                    activity.length === 0 ? (
                        <p style={{ margin: '22px 0', textAlign: 'center', color: 'var(--cc-faint)', fontSize: 13 }}>
                            {data ? 'Transactions you approve show up here.' : error ? error : 'Loading…'}
                        </p>
                    ) : (
                        <ul className="cc-list">
                            {activity.slice(0, 4).map((a) => (
                                <li key={a.txHash}>
                                    <span className="cc-tile">
                                        <Icon.Cube />
                                    </span>
                                    <span style={{ flex: 1, minWidth: 0 }}>
                                        <span className="cc-mono" style={{ display: 'block', fontSize: 13.5 }}>
                                            {a.txHash.slice(0, 10)}…{a.txHash.slice(-6)}
                                        </span>
                                        <span style={{ fontSize: 12, color: 'var(--cc-faint)' }}>
                                            {a.origin ? new URL(a.origin).host : 'Signed'} · {timeAgo(a.createdAt)}
                                        </span>
                                    </span>
                                    <span className="cc-mono" style={{ fontSize: 13, fontWeight: 500 }}>
                                        -{formatCkb(a.outflow)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )
                ) : (
                    <LoginsTab />
                )}
            </div>

            <div className="cc-between" style={{ marginTop: 'auto', paddingTop: 14, borderTop: '1px solid var(--cc-border)', fontSize: 13 }}>
                <span className="cc-row" style={{ gap: 8, color: 'var(--cc-faint)' }}>
                    <span className="cc-dot" />
                    Connected to {config?.name}
                </span>
                <button
                    type="button"
                    style={{ height: 34, padding: '0 12px', borderRadius: 10, border: '1px solid var(--cc-danger-border)', background: 'transparent', color: 'var(--cc-danger-text)', fontSize: 13, fontWeight: 500 }}
                    onClick={() => {
                        modal.close();
                        void connect.logout();
                    }}
                >
                    Disconnect
                </button>
            </div>
        </>
    );
}

function LoginsTab() {
    const { state, config, connect, modal } = useConnectContext();
    const { busy, error, run } = useAction();
    const user = state.user!;
    const host = typeof window !== 'undefined' ? window.location.hostname : '';
    const total = user.identities.length + user.passkeys.length;
    const has = (kind: string) => user.identities.some((i) => i.kind === kind);
    const methods = config?.loginMethods ?? [];

    const label: Record<string, string> = { PHONE: 'Phone', EMAIL: 'Email', GOOGLE: 'Google', WALLET: 'Wallet' };

    return (
        <>
            <ul className="cc-list">
                {user.identities.map((i) => (
                    <li key={i.id}>
                        <span className="cc-tile">
                            {i.kind === 'PHONE' ? <Icon.Phone size={16} /> : i.kind === 'GOOGLE' ? <Icon.GoogleG /> : i.kind === 'WALLET' ? <Icon.Wallet size={16} /> : <Icon.Mail size={16} />}
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: 'block', fontSize: 14 }}>{i.kind === 'WALLET' ? (i.label ?? 'Wallet') : label[i.kind]}</span>
                            <span className="cc-mono" style={{ fontSize: 12, color: 'var(--cc-faint)' }}>
                                {i.kind === 'PHONE' && i.value ? maskPhone(i.value) : i.kind === 'WALLET' && i.value ? shortAddress(i.value, 12, 6) : i.value}
                            </span>
                        </span>
                        {total > 1 && (
                            <button type="button" className="cc-icon-btn" style={{ width: 32, height: 32 }} aria-label={`Remove ${label[i.kind]}`} disabled={busy !== null} onClick={() => void run(i.id, () => connect.removeIdentity(i.id))}>
                                <Icon.Trash />
                            </button>
                        )}
                    </li>
                ))}
                {user.passkeys.map((p) => (
                    <li key={p.id}>
                        <span className="cc-tile">
                            <Icon.Passkey size={16} />
                        </span>
                        <span style={{ flex: 1 }}>
                            <span style={{ display: 'block', fontSize: 14 }}>{p.name ?? 'Passkey'}</span>
                            <span className="cc-mono" style={{ fontSize: 12, color: 'var(--cc-faint)' }}>
                                {p.rpId}
                            </span>
                        </span>
                        {total > 1 && (
                            <button type="button" className="cc-icon-btn" style={{ width: 32, height: 32 }} aria-label="Remove passkey" disabled={busy !== null} onClick={() => void run(p.id, () => connect.removePasskey(p.id))}>
                                <Icon.Trash />
                            </button>
                        )}
                    </li>
                ))}
            </ul>

            <div className="cc-row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                {methods.includes('PASSKEY') && !user.passkeys.some((p) => p.rpId === host) && typeof window !== 'undefined' && 'PublicKeyCredential' in window && (
                    <button type="button" className="cc-pill" style={{ fontFamily: 'inherit', height: 32 }} disabled={busy !== null} onClick={() => void run('passkey', () => connect.addPasskey())}>
                        {busy === 'passkey' ? <Spinner /> : <Icon.Plus size={14} />} Add passkey
                    </button>
                )}
                {((methods.includes('PHONE') && !has('PHONE')) || (methods.includes('EMAIL') && !has('EMAIL')) || (methods.includes('GOOGLE') && !has('GOOGLE') && config?.googleClientId)) && (
                    <button type="button" className="cc-pill" style={{ fontFamily: 'inherit', height: 32 }} onClick={() => modal.setView({ screen: 'main', link: true })}>
                        <Icon.Plus size={14} /> Link {[!has('PHONE') && methods.includes('PHONE') && 'phone', !has('EMAIL') && methods.includes('EMAIL') && 'email', !has('GOOGLE') && methods.includes('GOOGLE') && config?.googleClientId && 'Google'].filter(Boolean).join(' / ')}
                    </button>
                )}
                {methods.includes('WALLET') && (
                    <button type="button" className="cc-pill" style={{ fontFamily: 'inherit', height: 32 }} onClick={() => modal.setView({ screen: 'wallets', link: true })}>
                        <Icon.Plus size={14} /> Link a wallet
                    </button>
                )}
            </div>
            <ErrorText error={error} />
        </>
    );
}

export function SendScreen() {
    const { connect, modal, clients, config } = useConnectContext();
    const { state } = useConnectContext();
    const [network] = useState<Network>(state.user?.embeddedWallets === false ? 'TESTNET' : config?.networks.includes(selectedNetwork) ? selectedNetwork : 'TESTNET');
    const [to, setTo] = useState('');
    const [amount, setAmount] = useState('');
    const [txHash, setTxHash] = useState<string | null>(null);
    const { busy, error, setError, run } = useAction();
    const prefix = network === 'MAINNET' ? 'ckb1' : 'ckt1';
    const valid = to.trim().startsWith(prefix) && /^\d+(\.\d{1,8})?$/.test(amount.trim()) && Number(amount) >= 61;

    const send = () =>
        run('send', async () => {
            const signer = connect.getSigner(network, state.user?.embeddedWallets === false ? undefined : clients[network]);
            const { script } = await ccc.Address.fromString(to.trim(), signer.client);
            const tx = ccc.Transaction.from({ outputs: [{ lock: script, capacity: ccc.fixedPointFrom(amount.trim()) }], outputsData: ['0x'] });
            try {
                await tx.completeInputsByCapacity(signer);
                await tx.completeFeeBy(signer);
            } catch {
                throw new Error('Not enough CKB for that amount plus the fee.');
            }
            try {
                setTxHash(await signer.sendTransaction(tx));
            } catch (e) {
                if (e instanceof UserRejectedError) return;
                throw e;
            }
        });

    if (txHash) {
        return (
            <>
                <Header left={<BackButton onClick={() => modal.setView({ screen: 'wallet' })} />} onClose={modal.close} />
                <div style={{ marginTop: 40, alignSelf: 'center', width: 72, height: 72, borderRadius: '50%', background: 'var(--cc-accent-soft)', color: 'var(--cc-accent-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon.Check size={32} />
                </div>
                <h2 style={{ margin: '22px 0 8px', fontSize: 27, fontWeight: 600, letterSpacing: '-0.03em', textAlign: 'center' }}>Sent</h2>
                <p style={{ margin: 0, color: 'var(--cc-muted)', textAlign: 'center' }}>
                    {amount} CKB is on its way. It confirms in about 10 seconds.
                </p>
                <div className="cc-field" style={{ marginTop: 22, padding: '0 14px', justifyContent: 'space-between' }}>
                    <span className="cc-mono" style={{ fontSize: 12.5, color: 'var(--cc-muted)' }} data-testid="cc-tx-hash">
                        {txHash.slice(0, 18)}…{txHash.slice(-8)}
                    </span>
                    <CopyButton value={txHash} label="Copy transaction hash" />
                </div>
                <button type="button" className="cc-btn cc-btn-primary" style={{ marginTop: 'auto' }} onClick={() => modal.setView({ screen: 'wallet' })} data-autofocus>
                    Done
                </button>
            </>
        );
    }

    return (
        <>
            <Header left={<BackButton onClick={() => modal.setView({ screen: 'wallet' })} />} center={<strong style={{ fontSize: 15 }}>Send CKB</strong>} onClose={modal.close} />
            <form
                style={{ display: 'contents' }}
                onSubmit={(e) => {
                    e.preventDefault();
                    if (valid && !busy) void send();
                }}
            >
                <label style={{ marginTop: 24, fontSize: 13, color: 'var(--cc-muted)' }}>To</label>
                <div className="cc-field" style={{ marginTop: 6 }}>
                    <input
                        data-autofocus
                        aria-label="Recipient address"
                        placeholder={`${prefix}…`}
                        value={to}
                        onChange={(e) => {
                            setTo(e.target.value);
                            setError(null);
                        }}
                        className="cc-mono"
                        style={{ flex: 1, padding: '0 14px', fontSize: 13 }}
                        spellCheck={false}
                    />
                </div>
                {to.trim() && !to.trim().startsWith(prefix) && (
                    <span style={{ marginTop: 6, fontSize: 12.5, color: 'var(--cc-danger-text)' }}>
                        {network === 'MAINNET' ? 'Mainnet' : 'Testnet'} addresses start with {prefix}.
                    </span>
                )}
                <label style={{ marginTop: 16, fontSize: 13, color: 'var(--cc-muted)' }}>Amount</label>
                <div className="cc-field" style={{ marginTop: 6 }}>
                    <input aria-label="Amount in CKB" inputMode="decimal" placeholder="100" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} style={{ flex: 1, padding: '0 14px', fontSize: 18, fontWeight: 600 }} />
                    <span style={{ padding: '0 14px', color: 'var(--cc-muted)', fontWeight: 500 }}>CKB</span>
                </div>
                <span style={{ marginTop: 6, fontSize: 12.5, color: 'var(--cc-faint)' }}>At least 61 CKB: the smallest cell an address can hold.</span>
                <ErrorText error={error} />
                <button type="submit" className="cc-btn cc-btn-primary" style={{ marginTop: 'auto' }} disabled={!valid || busy !== null}>
                    {busy ? <Spinner /> : null}
                    {busy ? 'Preparing…' : 'Review'}
                </button>
            </form>
        </>
    );
}

export function ReceiveScreen() {
    const { state, modal, config, connect } = useConnectContext();
    const network: Network = state.user?.embeddedWallets === false ? 'TESTNET' : config?.networks.includes(selectedNetwork) ? selectedNetwork : 'TESTNET';
    const address = state.user ? ownAddress(state.user, network, connect.externalWallet) : '';

    return (
        <>
            <Header left={<BackButton onClick={() => modal.setView({ screen: 'wallet' })} />} center={<strong style={{ fontSize: 15 }}>Receive</strong>} onClose={modal.close} />
            <div style={{ marginTop: 34, alignSelf: 'center', width: 72, height: 72, borderRadius: 22, background: 'var(--cc-accent-soft)', color: 'var(--cc-accent-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon.Wallet size={30} />
            </div>
            <h2 style={{ margin: '22px 0 8px', fontSize: 24, fontWeight: 600, letterSpacing: '-0.03em', textAlign: 'center' }}>Your {network === 'MAINNET' ? 'mainnet' : 'testnet'} address</h2>
            <p style={{ margin: 0, color: 'var(--cc-muted)', textAlign: 'center' }}>Send only CKB {network === 'MAINNET' ? 'on mainnet' : 'testnet coins'} to this address.</p>
            <div className="cc-card-surface cc-mono" style={{ marginTop: 22, fontSize: 13.5, lineHeight: 1.6, wordBreak: 'break-all' }} data-testid="cc-address">
                {address}
            </div>
            <CopyButton value={address} label="Copy address" className="cc-btn cc-btn-secondary cc-copy-wide">
                Copy address{' '}
            </CopyButton>
            {network === 'TESTNET' && (
                <a href={FAUCET_URL} target="_blank" rel="noreferrer" className="cc-row" style={{ marginTop: 14, justifyContent: 'center', gap: 6, color: 'var(--cc-accent-ink)', fontSize: 13, fontWeight: 500 }}>
                    Get free testnet CKB from the faucet <Icon.External />
                </a>
            )}
        </>
    );
}

export function ExportScreen() {
    const { connect, modal, config } = useConnectContext();
    const network: Network = config?.networks.includes(selectedNetwork) ? selectedNetwork : 'TESTNET';
    const [understood, setUnderstood] = useState(false);
    const [key, setKey] = useState<string | null>(null);
    const { busy, error, run } = useAction();

    return (
        <>
            <Header left={<BackButton onClick={() => modal.setView({ screen: 'wallet' })} />} center={<strong style={{ fontSize: 15 }}>Export private key</strong>} onClose={modal.close} />

            <div className="cc-warn" style={{ marginTop: 24 }}>
                <span style={{ flexShrink: 0, marginTop: 2 }}>
                    <Icon.Warn />
                </span>
                <span>
                    Your private key controls this {network === 'MAINNET' ? 'mainnet' : 'testnet'} wallet. Anyone who sees it can take your CKB. Never share it or paste it into a website.
                </span>
            </div>

            {key ? (
                <>
                    <div className="cc-card-surface cc-mono" style={{ marginTop: 14, fontSize: 13, lineHeight: 1.6, wordBreak: 'break-all', filter: 'none' }} data-testid="cc-private-key">
                        {key}
                    </div>
                    <CopyButton value={key} label="Copy private key" className="cc-btn cc-btn-secondary cc-copy-wide">
                        Copy key{' '}
                    </CopyButton>
                    <button type="button" className="cc-btn cc-btn-primary" style={{ marginTop: 'auto' }} onClick={() => setKey(null)}>
                        Hide key
                    </button>
                </>
            ) : (
                <>
                    <label className="cc-row" style={{ marginTop: 16, gap: 10, fontSize: 13.5, cursor: 'pointer', alignItems: 'flex-start' }}>
                        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} style={{ marginTop: 3, accentColor: 'var(--cc-accent)' }} />
                        I understand that anyone with this key can move my funds.
                    </label>
                    {understood && (
                        <div style={{ marginTop: 14 }}>
                            <StepUp purpose="export" onToken={(token) => void run('export', async () => setKey((await connect.exportPrivateKey(network, token)).privateKey))} />
                        </div>
                    )}
                    {busy && (
                        <div className="cc-row" style={{ marginTop: 12, gap: 8, color: 'var(--cc-muted)' }}>
                            <Spinner /> Decrypting…
                        </div>
                    )}
                    <ErrorText error={error} />
                </>
            )}
        </>
    );
}

function timeAgo(iso: string): string {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
}
