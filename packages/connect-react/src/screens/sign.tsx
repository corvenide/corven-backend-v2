// Approving a transaction, and the "confirm it's you" step that mainnet
// signing and key export need.

import { useMemo, useState } from 'react';
import { formatCkb, shortAddress, type SignApproval, type SignRequest, type StepUpPurpose } from '@corven/connect';

import { GoogleButton } from '../google';
import * as Icon from '../icons';
import { useConnectContext } from '../provider';
import { ErrorText, Header, Spinner, maskPhone, useAction } from '../ui';

type Method = 'PASSKEY' | 'PHONE' | 'EMAIL' | 'GOOGLE' | 'WALLET';

/** Re-verify with a passkey, a code to the user's phone/email, or Google. Calls onToken with a step-up token. */
export function StepUp({ purpose, onToken, compact }: { purpose: StepUpPurpose; onToken: (token: string) => void; compact?: boolean }) {
    const { connect, state, config, mode } = useConnectContext();
    const user = state.user;
    const host = typeof window !== 'undefined' ? window.location.hostname : '';

    const available = useMemo(() => {
        const list: { method: Method; label: string; detail?: string }[] = [];
        if (user?.passkeys.some((p) => p.rpId === host)) list.push({ method: 'PASSKEY', label: 'Passkey' });
        const phone = user?.identities.find((i) => i.kind === 'PHONE');
        if (phone?.value) list.push({ method: 'PHONE', label: 'SMS code', detail: maskPhone(phone.value) });
        const email = user?.identities.find((i) => i.kind === 'EMAIL');
        if (email?.value) list.push({ method: 'EMAIL', label: 'Email code', detail: email.value });
        if (user?.identities.some((i) => i.kind === 'GOOGLE') && config?.googleClientId) list.push({ method: 'GOOGLE', label: 'Google' });
        const ext = connect.externalWallet;
        if (ext && user?.identities.some((i) => i.kind === 'WALLET' && i.value === ext.address)) list.push({ method: 'WALLET', label: 'Wallet', detail: ext.walletName });
        return list;
    }, [user, config, host, connect]);

    const [method, setMethod] = useState<Method | null>(available[0]?.method ?? null);
    const [sentTo, setSentTo] = useState<string | null>(null);
    const [code, setCode] = useState('');
    const [done, setDone] = useState(false);
    const { busy, error, run } = useAction();

    const finish = (token: string) => {
        setDone(true);
        onToken(token);
    };

    if (done) {
        return (
            <div className="cc-row" style={{ gap: 10, padding: '11px 14px', borderRadius: 14, background: 'var(--cc-accent-soft)', color: 'var(--cc-ok-text)', fontSize: 13 }}>
                <Icon.Ok /> Confirmed. You have 5 minutes.
            </div>
        );
    }

    if (available.length === 0) {
        return <ErrorText error="Add a phone number, email or passkey to your account to confirm this." />;
    }

    return (
        <div style={{ padding: compact ? 14 : 16, borderRadius: 16, border: '1px solid var(--cc-border)', background: 'var(--cc-surface)' }}>
            <div className="cc-between">
                <strong style={{ fontSize: 13.5, fontWeight: 600 }}>Confirm it’s you</strong>
                {available.length > 1 && (
                    <div className="cc-row" style={{ gap: 4 }}>
                        {available.map((a) => (
                            <button
                                key={a.method}
                                type="button"
                                className="cc-pill"
                                style={{
                                    height: 26,
                                    borderColor: a.method === method ? 'var(--cc-accent)' : 'var(--cc-border)',
                                    color: a.method === method ? 'var(--cc-text)' : 'var(--cc-muted)',
                                    fontFamily: 'inherit',
                                }}
                                onClick={() => {
                                    setMethod(a.method);
                                    setSentTo(null);
                                    setCode('');
                                }}
                            >
                                {a.label}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <div style={{ marginTop: 12 }}>
                {method === 'PASSKEY' && (
                    <button
                        type="button"
                        className="cc-btn cc-btn-secondary"
                        style={{ height: 44 }}
                        disabled={busy !== null}
                        onClick={() => void run('passkey', async () => finish((await connect.stepUpWithPasskey(purpose)).stepUpToken))}
                    >
                        {busy ? <Spinner /> : <Icon.Passkey />} Use your passkey
                    </button>
                )}

                {(method === 'PHONE' || method === 'EMAIL') &&
                    (sentTo === null ? (
                        <button
                            type="button"
                            className="cc-btn cc-btn-secondary"
                            style={{ height: 44 }}
                            disabled={busy !== null}
                            onClick={() => void run('send', async () => setSentTo((await connect.sendStepUpCode(method)).to))}
                        >
                            {busy ? <Spinner /> : method === 'PHONE' ? <Icon.Phone size={16} /> : <Icon.Mail size={16} />}
                            Send a code to {available.find((a) => a.method === method)?.detail}
                        </button>
                    ) : (
                        <form
                            className="cc-row"
                            style={{ gap: 8 }}
                            onSubmit={(e) => {
                                e.preventDefault();
                                void run('verify', async () => finish((await connect.verifyStepUp(purpose, { method, code })).stepUpToken));
                            }}
                        >
                            <div className="cc-field" style={{ flex: 1, height: 44 }}>
                                <input
                                    aria-label="Confirmation code"
                                    inputMode="numeric"
                                    autoComplete="one-time-code"
                                    placeholder={`Code sent to ${sentTo}`}
                                    value={code}
                                    maxLength={6}
                                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                                    className="cc-mono"
                                    style={{ flex: 1, padding: '0 12px', fontSize: 14 }}
                                    autoFocus
                                />
                            </div>
                            <button type="submit" className="cc-btn cc-btn-primary" style={{ width: 96, height: 44 }} disabled={code.length !== 6 || busy !== null}>
                                {busy ? <Spinner /> : 'Confirm'}
                            </button>
                        </form>
                    ))}

                {method === 'WALLET' && connect.externalWallet && (
                    <button
                        type="button"
                        className="cc-btn cc-btn-secondary"
                        style={{ height: 44 }}
                        disabled={busy !== null}
                        onClick={() => void run('wallet', async () => finish((await connect.stepUpWithSigner(purpose, connect.externalWallet!.signer)).stepUpToken))}
                    >
                        {busy ? <Spinner /> : <Icon.Wallet size={16} />} Sign with {connect.externalWallet.walletName}
                    </button>
                )}

                {method === 'GOOGLE' && config?.googleClientId && (
                    <GoogleButton
                        clientId={config.googleClientId}
                        mode={mode}
                        onCredential={(credential) => void run('google', async () => finish((await connect.verifyStepUp(purpose, { method: 'GOOGLE', credential })).stepUpToken))}
                        onError={() => undefined}
                    />
                )}
            </div>
            <ErrorText error={error} />
        </div>
    );
}

export function SignScreen({ request, resolve }: { request: SignRequest; resolve: (approval: SignApproval) => void }) {
    const { config, state } = useConnectContext();
    const [stepUpToken, setStepUpToken] = useState<string | null>(null);
    const mainnet = request.network === 'MAINNET';
    const from = state.user?.wallets.find((w) => w.network === request.network)?.address ?? '';
    const origin = typeof window !== 'undefined' ? window.location.host : '';
    const canApprove = !mainnet || stepUpToken !== null;

    return (
        <>
            <Header
                left={
                    <span className="cc-row" style={{ height: 32, padding: '0 12px 0 6px', borderRadius: 999, background: 'var(--cc-surface)', border: '1px solid var(--cc-border)', gap: 8, fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>
                        <span style={{ width: 22, height: 22, borderRadius: 7, background: 'var(--cc-chip-bg)', color: 'var(--cc-chip-text)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {(config?.name ?? 'A').slice(0, 1).toUpperCase()}
                        </span>
                        {config?.name}
                        <span className="cc-mono" style={{ fontSize: 12, color: 'var(--cc-faint)', fontWeight: 400 }}>
                            {origin}
                        </span>
                    </span>
                }
                onClose={() => resolve({ approved: false })}
            />

            <div className="cc-row" style={{ marginTop: 24, gap: 14 }}>
                <span style={{ width: 52, height: 52, flexShrink: 0, borderRadius: 16, background: 'var(--cc-accent-soft)', color: 'var(--cc-accent-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon.Cube size={24} />
                </span>
                <div>
                    <h2 style={{ margin: 0, fontSize: 23, fontWeight: 600, letterSpacing: '-0.03em' }}>Approve this transaction?</h2>
                    <p style={{ margin: '4px 0 0', fontSize: 13.5, color: 'var(--cc-muted)' }}>
                        {config?.name ?? 'This app'} wants your wallet to sign it.
                    </p>
                </div>
            </div>

            <div className="cc-card-surface" style={{ marginTop: 20, padding: '16px 18px' }}>
                <div style={{ fontSize: 12.5, color: 'var(--cc-muted)' }}>Leaves your wallet</div>
                <div className="cc-row" style={{ marginTop: 4, gap: 8, alignItems: 'baseline' }}>
                    <span style={{ fontSize: 34, fontWeight: 600, letterSpacing: '-0.035em' }}>{formatCkb(request.outflow)}</span>
                    <span style={{ fontSize: 15, color: 'var(--cc-muted)', fontWeight: 500 }}>CKB</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--cc-faint)' }}>Including the network fee. Capacity stored in new cells comes back when they are spent.</div>
            </div>

            <dl className="cc-dl" style={{ marginTop: 10 }}>
                {request.recipients.slice(0, 3).map((r, i) => (
                    <div key={i}>
                        <dt>To</dt>
                        <dd>
                            {shortAddress(r.address, 10, 6)} · {formatCkb(r.capacity)}
                        </dd>
                    </div>
                ))}
                {request.recipients.length > 3 && (
                    <div>
                        <dt>And</dt>
                        <dd>{request.recipients.length - 3} more outputs</dd>
                    </div>
                )}
                <div>
                    <dt>Network fee</dt>
                    <dd>{request.fee === null ? '—' : `${formatCkb(request.fee, 8).replace(/0+$/, '').replace(/\.$/, '')} CKB`}</dd>
                </div>
                <div>
                    <dt>From</dt>
                    <dd>{shortAddress(from, 8, 6)}</dd>
                </div>
                <div>
                    <dt>Network</dt>
                    <dd className="cc-row" style={{ gap: 6, justifyContent: 'flex-end', fontFamily: 'inherit' }}>
                        <span className="cc-dot" style={mainnet ? { background: '#f0b429' } : undefined} />
                        {mainnet ? 'CKB Mainnet' : 'CKB Testnet'}
                    </dd>
                </div>
            </dl>

            {mainnet && (
                <div style={{ marginTop: 10 }}>
                    <StepUp purpose="sign" onToken={setStepUpToken} compact />
                </div>
            )}

            <details style={{ marginTop: 10 }}>
                <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--cc-muted)', listStyle: 'none' }} className="cc-row">
                    <Icon.ChevronRight /> Show raw transaction
                </summary>
                <pre className="cc-mono" style={{ margin: '8px 0 0', maxHeight: 160, overflow: 'auto', padding: 12, borderRadius: 12, background: 'var(--cc-surface)', fontSize: 11, color: 'var(--cc-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    {JSON.stringify(request.transaction, null, 2)}
                </pre>
            </details>

            <div style={{ marginTop: 'auto', paddingTop: 16, display: 'grid', gridTemplateColumns: '1fr 1.5fr', gap: 8 }}>
                <button type="button" className="cc-btn cc-btn-secondary" onClick={() => resolve({ approved: false })}>
                    Reject
                </button>
                <button
                    type="button"
                    className="cc-btn cc-btn-primary"
                    disabled={!canApprove}
                    onClick={() => resolve({ approved: true, stepUpToken: stepUpToken ?? undefined })}
                    data-autofocus={!mainnet || undefined}
                >
                    Approve
                </button>
            </div>
            {!mainnet && (
                <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--cc-faint)', textAlign: 'center' }}>Testnet CKB has no value.</p>
            )}
        </>
    );
}
