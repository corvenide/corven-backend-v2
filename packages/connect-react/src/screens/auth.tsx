// Sign-in screens: method picker, code entry, and wallet creation.

import { useEffect, useMemo, useRef, useState } from 'react';
import { shortAddress, type PhoneChannel } from '@corven/connect';

import { GoogleButton } from '../google';
import * as Icon from '../icons';
import { useConnectContext, type View } from '../provider';
import { BackButton, ErrorText, Footer, Header, Hero, Spinner, Steps, useAction } from '../ui';

export const COUNTRIES = [
    { code: '254', flag: 'KE', name: 'Kenya' },
    { code: '256', flag: 'UG', name: 'Uganda' },
    { code: '255', flag: 'TZ', name: 'Tanzania' },
    { code: '250', flag: 'RW', name: 'Rwanda' },
    { code: '251', flag: 'ET', name: 'Ethiopia' },
    { code: '234', flag: 'NG', name: 'Nigeria' },
    { code: '233', flag: 'GH', name: 'Ghana' },
    { code: '27', flag: 'ZA', name: 'South Africa' },
    { code: '1', flag: 'US', name: 'United States / Canada' },
    { code: '44', flag: 'GB', name: 'United Kingdom' },
    { code: '91', flag: 'IN', name: 'India' },
    { code: '86', flag: 'CN', name: 'China' },
];

const LAST_METHOD_KEY = 'corven-connect:last-method';

function lastMethod(): string | null {
    try {
        return localStorage.getItem(LAST_METHOD_KEY);
    } catch {
        return null;
    }
}

export function rememberMethod(method: string): void {
    try {
        localStorage.setItem(LAST_METHOD_KEY, method);
    } catch {
        /* ignore */
    }
}

/** "0712 345 678" with country 254 -> "+254712345678"; "+…" is kept. */
function fullNumber(country: string, typed: string): string {
    const digits = typed.replace(/[^\d+]/g, '');
    if (digits.startsWith('+')) return digits;
    return `+${country}${digits.replace(/^0+/, '')}`;
}

export function MainScreen({ link }: { link?: boolean }) {
    const { connect, config, configError, modal, mode } = useConnectContext();
    const methods = config?.loginMethods ?? [];
    const hasPhone = methods.includes('PHONE');
    const hasEmail = methods.includes('EMAIL');
    const [tab, setTab] = useState<'phone' | 'email'>(hasPhone ? 'phone' : 'email');
    const [country, setCountry] = useState('254');
    const [phone, setPhone] = useState('');
    const [email, setEmail] = useState('');
    const { busy, error, setError, run } = useAction();
    const previous = useMemo(lastMethod, []);

    useEffect(() => {
        if (!hasPhone && hasEmail) setTab('email');
    }, [hasPhone, hasEmail]);

    const sendCode = (channel: PhoneChannel = 'sms') =>
        run('send', async () => {
            const to = tab === 'phone' ? { phone: fullNumber(country, phone), channel } : { email: email.trim() };
            const sent = await connect.sendCode(to);
            modal.setView({ screen: 'code', to, sent, link });
        });

    const google = (credential: string) =>
        run('google', async () => {
            const session = await connect.loginWithGoogle(credential, { link });
            rememberMethod('google');
            modal.finishLogin(session.isNewUser === true);
        });

    const passkey = () =>
        run('passkey', async () => {
            const session = await connect.loginWithPasskey();
            rememberMethod('passkey');
            modal.finishLogin(session.isNewUser === true);
        });

    const canSend = tab === 'phone' ? phone.replace(/\D/g, '').length >= 7 : /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

    return (
        <>
            <Header
                left={link ? <BackButton onClick={() => modal.setView({ screen: 'wallet', tab: 'logins' })} /> : undefined}
                center={
                    <span className="cc-row" style={{ gap: 8, fontSize: 13, color: 'var(--cc-muted)' }}>
                        {config?.logoUrl ? (
                            <img src={config.logoUrl} alt="" width={22} height={22} style={{ borderRadius: 7 }} />
                        ) : (
                            <span
                                style={{
                                    width: 22,
                                    height: 22,
                                    borderRadius: 7,
                                    background: 'var(--cc-chip-bg)',
                                    color: 'var(--cc-chip-text)',
                                    font: '700 11px inherit',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                }}
                            >
                                {(config?.name ?? 'C').slice(0, 1).toUpperCase()}
                            </span>
                        )}
                        {config?.name ?? ''}
                    </span>
                }
                onClose={modal.close}
            />

            <h2 style={{ margin: '26px 0 6px', fontSize: 27, fontWeight: 600, letterSpacing: '-0.03em' }}>
                {link ? 'Add a way to sign in' : 'Sign in'}
            </h2>
            <p style={{ margin: 0, color: 'var(--cc-muted)' }}>
                {link ? 'Link another account to your wallet.' : `to continue to ${config?.name ?? 'the app'}. A CKB wallet is created for you.`}
            </p>

            {configError && <ErrorText error={configError} />}
            {!config && !configError && (
                <div className="cc-row" style={{ justifyContent: 'center', padding: 40, color: 'var(--cc-muted)' }}>
                    <Spinner />
                </div>
            )}

            {config && (
                <>
                    {methods.includes('GOOGLE') && config.googleClientId && (
                        <div style={{ marginTop: 22, position: 'relative' }}>
                            {previous === 'google' && !link && (
                                <span
                                    style={{
                                        position: 'absolute',
                                        top: -9,
                                        right: 10,
                                        zIndex: 1,
                                        padding: '2px 8px',
                                        borderRadius: 999,
                                        background: 'var(--cc-accent)',
                                        color: 'var(--cc-accent-text)',
                                        fontSize: 11,
                                        fontWeight: 600,
                                    }}
                                >
                                    Last used
                                </span>
                            )}
                            <GoogleButton clientId={config.googleClientId} mode={mode} onCredential={google} onError={(m) => setError(m)} />
                            {busy === 'google' && (
                                <div className="cc-row" style={{ justifyContent: 'center', gap: 8, marginTop: 8, color: 'var(--cc-muted)', fontSize: 13 }}>
                                    <Spinner /> Signing in with Google…
                                </div>
                            )}
                        </div>
                    )}

                    {(hasPhone || hasEmail) && (
                        <>
                            {methods.includes('GOOGLE') && config.googleClientId && (
                                <div className="cc-row" style={{ gap: 12, margin: '20px 0 16px', color: 'var(--cc-faint)', fontSize: 12 }}>
                                    <span style={{ flex: 1, height: 1, background: 'var(--cc-border)' }} />
                                    or
                                    <span style={{ flex: 1, height: 1, background: 'var(--cc-border)' }} />
                                </div>
                            )}
                            {!(methods.includes('GOOGLE') && config.googleClientId) && <div style={{ height: 22 }} />}

                            {hasPhone && hasEmail && (
                                <div className="cc-tabs" role="tablist">
                                    <button type="button" role="tab" className="cc-tab" aria-selected={tab === 'phone'} onClick={() => setTab('phone')}>
                                        Phone
                                    </button>
                                    <button type="button" role="tab" className="cc-tab" aria-selected={tab === 'email'} onClick={() => setTab('email')}>
                                        Email
                                    </button>
                                </div>
                            )}

                            <form
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    if (canSend && !busy) void sendCode();
                                }}
                            >
                                {tab === 'phone' ? (
                                    <div className="cc-field" style={{ marginTop: 12 }}>
                                        <div style={{ position: 'relative', height: '100%', borderRight: '1px solid var(--cc-border)' }}>
                                            <select aria-label="Country code" value={country} onChange={(e) => setCountry(e.target.value)}>
                                                {COUNTRIES.map((c) => (
                                                    <option key={c.code + c.flag} value={c.code}>
                                                        {c.flag} +{c.code}
                                                    </option>
                                                ))}
                                            </select>
                                            <span style={{ position: 'absolute', right: 10, top: 20, pointerEvents: 'none', color: 'var(--cc-faint)' }}>
                                                <Icon.Chevron />
                                            </span>
                                        </div>
                                        <input
                                            data-autofocus
                                            aria-label="Phone number"
                                            inputMode="tel"
                                            autoComplete="tel-national"
                                            placeholder="712 345 678"
                                            value={phone}
                                            onChange={(e) => setPhone(e.target.value)}
                                            style={{ flex: 1, padding: '0 14px', fontFamily: 'var(--cc-mono, inherit)' }}
                                            className="cc-mono"
                                        />
                                    </div>
                                ) : (
                                    <div className="cc-field" style={{ marginTop: 12 }}>
                                        <input
                                            data-autofocus
                                            aria-label="Email address"
                                            type="email"
                                            inputMode="email"
                                            autoComplete="email"
                                            placeholder="you@example.com"
                                            value={email}
                                            onChange={(e) => setEmail(e.target.value)}
                                            style={{ flex: 1, padding: '0 16px' }}
                                        />
                                    </div>
                                )}
                                <button type="submit" className="cc-btn cc-btn-primary" style={{ marginTop: 10 }} disabled={!canSend || busy !== null}>
                                    {busy === 'send' ? <Spinner /> : null}
                                    {busy === 'send' ? 'Sending code…' : 'Send code'}
                                </button>
                            </form>
                        </>
                    )}

                    {methods.includes('PASSKEY') && !link && typeof window !== 'undefined' && 'PublicKeyCredential' in window && (
                        <button type="button" className="cc-btn cc-btn-secondary" style={{ marginTop: 10, height: 48 }} onClick={passkey} disabled={busy !== null}>
                            {busy === 'passkey' ? <Spinner /> : <Icon.Passkey />}
                            Sign in with a passkey
                        </button>
                    )}

                    <ErrorText error={error} />
                </>
            )}

            <Footer />
        </>
    );
}

const RESEND_SECONDS = 30;

export function CodeScreen({ view }: { view: Extract<View, { screen: 'code' }> }) {
    const { connect, modal } = useConnectContext();
    const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
    const [sent, setSent] = useState(view.sent);
    const [wait, setWait] = useState(RESEND_SECONDS);
    const inputs = useRef<(HTMLInputElement | null)[]>([]);
    const { busy, error, setError, run } = useAction();
    const isPhone = 'phone' in view.to;

    useEffect(() => {
        if (wait <= 0) return;
        const t = setTimeout(() => setWait((w) => w - 1), 1000);
        return () => clearTimeout(t);
    }, [wait]);

    const verify = (code: string) =>
        run('verify', async () => {
            const session = await connect.verifyCode({ ...view.to, code } as never, { link: view.link });
            rememberMethod(isPhone ? 'phone' : 'email');
            modal.finishLogin(session.isNewUser === true);
        }).then(() => {
            // Wrong code: clear and start over.
            if (connect.authState.status !== 'signed-in' || view.link) {
                setDigits(Array(6).fill(''));
                inputs.current[0]?.focus();
            }
        });

    const resend = (channel?: PhoneChannel) =>
        run(`resend-${channel ?? 'same'}`, async () => {
            const to = isPhone ? { ...(view.to as { phone: string }), channel: channel ?? (view.to as { channel?: PhoneChannel }).channel } : view.to;
            setSent(await connect.sendCode(to));
            setWait(RESEND_SECONDS);
            setDigits(Array(6).fill(''));
            inputs.current[0]?.focus();
        });

    const setDigit = (index: number, value: string) => {
        const clean = value.replace(/\D/g, '');
        if (clean.length > 1) {
            // Pasted or autofilled the whole code.
            const next = clean.slice(0, 6).split('');
            const filled = [...next, ...Array(6 - next.length).fill('')];
            setDigits(filled);
            inputs.current[Math.min(next.length, 5)]?.focus();
            if (next.length === 6) void verify(next.join(''));
            return;
        }
        const next = [...digits];
        next[index] = clean;
        setDigits(next);
        setError(null);
        if (clean && index < 5) inputs.current[index + 1]?.focus();
        if (next.every((d) => d)) void verify(next.join(''));
    };

    const channelLabel = sent.channel === 'whatsapp' ? 'on WhatsApp' : sent.channel === 'call' ? 'by phone call' : sent.channel === 'email' ? 'by email' : 'by SMS';

    return (
        <>
            <Header left={<BackButton onClick={() => modal.setView({ screen: 'main', link: view.link })} />} center={<Steps total={3} current={2} />} onClose={modal.close} />

            <Hero icon={isPhone ? <Icon.Phone /> : <Icon.Mail />} title={isPhone ? 'Check your phone' : 'Check your email'}>
                Enter the 6-digit code we sent {channelLabel} to
                <br />
                <span className="cc-mono" style={{ color: 'var(--cc-text)', fontWeight: 500 }}>
                    {sent.to}
                </span>
                <button type="button" className="cc-link" style={{ marginLeft: 6 }} onClick={() => modal.setView({ screen: 'main', link: view.link })}>
                    Edit
                </button>
            </Hero>

            <div className="cc-otp" style={{ marginTop: 28 }} data-error={!!error}>
                {digits.map((d, i) => (
                    <input
                        key={i}
                        ref={(el) => {
                            inputs.current[i] = el;
                        }}
                        aria-label={`Digit ${i + 1}`}
                        inputMode="numeric"
                        autoComplete={i === 0 ? 'one-time-code' : 'off'}
                        maxLength={i === 0 ? 6 : 1}
                        value={d}
                        disabled={busy === 'verify'}
                        onChange={(e) => setDigit(i, e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Backspace' && !digits[i] && i > 0) inputs.current[i - 1]?.focus();
                            if (e.key === 'ArrowLeft' && i > 0) inputs.current[i - 1]?.focus();
                            if (e.key === 'ArrowRight' && i < 5) inputs.current[i + 1]?.focus();
                        }}
                        data-autofocus={i === 0 ? true : undefined}
                    />
                ))}
            </div>

            <ErrorText error={error} />

            <p style={{ margin: '16px 0 0', fontSize: 13, color: 'var(--cc-muted)', textAlign: 'center' }}>
                {busy === 'verify' ? (
                    <span className="cc-row" style={{ justifyContent: 'center', gap: 8 }}>
                        <Spinner /> Checking…
                    </span>
                ) : wait > 0 ? (
                    <>
                        Didn’t get it? Resend in <span className="cc-mono" style={{ color: 'var(--cc-text)' }}>0:{String(wait).padStart(2, '0')}</span>
                    </>
                ) : (
                    <>
                        Didn’t get it?{' '}
                        <button type="button" className="cc-link" onClick={() => void resend()} disabled={busy !== null}>
                            Send a new code
                        </button>
                    </>
                )}
            </p>

            {isPhone && (
                <div style={{ marginTop: 20, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <button type="button" className="cc-btn-small" disabled={wait > 0 || busy !== null} onClick={() => void resend('whatsapp')}>
                        Send via WhatsApp
                    </button>
                    <button type="button" className="cc-btn-small" disabled={wait > 0 || busy !== null} onClick={() => void resend('call')}>
                        Call me instead
                    </button>
                </div>
            )}

            <div className="cc-note" style={{ marginTop: 'auto' }}>
                <span style={{ flexShrink: 0, marginTop: 2 }}>
                    <Icon.Shield />
                </span>
                <span>Corven will never ask you for this code. If someone does, it’s a scam: don’t share it.</span>
            </div>
        </>
    );
}

export function CreatingScreen() {
    const { state, modal } = useConnectContext();
    const [step, setStep] = useState(1);
    const address = state.user?.wallets.find((w) => w.network === 'TESTNET')?.address ?? state.user?.wallets[0]?.address;

    // The wallet already exists by now; this screen is a short, honest recap.
    useEffect(() => {
        const timers = [setTimeout(() => setStep(2), 500), setTimeout(() => setStep(3), 1000), setTimeout(() => setStep(4), 1500)];
        return () => timers.forEach(clearTimeout);
    }, []);

    const steps = ['Account verified', 'Generating your key', 'Encrypting and backing it up'];
    const done = step > 3;

    return (
        <>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
                <Steps total={3} current={3} />
            </div>

            <div style={{ marginTop: 40, alignSelf: 'center', position: 'relative', width: 136, height: 136 }}>
                {!done && <div className="cc-ring" style={{ position: 'absolute', inset: 0 }} />}
                {done && <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '3px solid var(--cc-accent)' }} />}
                <div
                    style={{
                        position: 'absolute',
                        inset: 22,
                        borderRadius: '50%',
                        background: 'var(--cc-accent-soft)',
                        color: 'var(--cc-accent-ink)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    {done ? <Icon.Check size={36} /> : <Icon.Key size={36} />}
                </div>
            </div>

            <h2 style={{ margin: '28px 0 8px', fontSize: 27, fontWeight: 600, letterSpacing: '-0.03em', textAlign: 'center' }}>
                {done ? 'Your wallet is ready' : 'Creating your CKB wallet'}
            </h2>
            <p style={{ margin: '0 auto', maxWidth: 320, color: 'var(--cc-muted)', textAlign: 'center' }}>No seed phrase, no app to install.</p>

            <ol style={{ margin: '26px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {steps.map((label, i) => {
                    const n = i + 1;
                    const isDone = step > n;
                    const active = step === n;
                    return (
                        <li
                            key={label}
                            className="cc-row"
                            style={{
                                gap: 12,
                                padding: '13px 14px',
                                borderRadius: 14,
                                background: 'var(--cc-surface)',
                                border: active ? '1.5px solid var(--cc-accent)' : '1px solid var(--cc-border)',
                            }}
                        >
                            <span
                                style={{
                                    width: 24,
                                    height: 24,
                                    borderRadius: '50%',
                                    flexShrink: 0,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    background: isDone ? 'var(--cc-accent)' : 'transparent',
                                    color: 'var(--cc-accent-text)',
                                    border: isDone ? 0 : `2px solid ${active ? 'var(--cc-accent)' : 'var(--cc-border-strong)'}`,
                                }}
                            >
                                {isDone ? <Icon.Check size={13} /> : active ? <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--cc-accent)' }} /> : null}
                            </span>
                            <span style={{ flex: 1, color: isDone || active ? 'var(--cc-text)' : 'var(--cc-muted)', fontWeight: active ? 500 : 400 }}>{label}</span>
                        </li>
                    );
                })}
            </ol>

            <div style={{ marginTop: 14, padding: 14, borderRadius: 14, border: '1px dashed var(--cc-border-strong)' }}>
                <div style={{ fontSize: 12, color: 'var(--cc-faint)' }}>Your address</div>
                {done && address ? (
                    <div className="cc-mono" style={{ marginTop: 8, fontSize: 13, fontWeight: 500 }}>
                        {shortAddress(address, 18, 8)}
                    </div>
                ) : (
                    <div className="cc-row" style={{ marginTop: 8, gap: 6 }}>
                        <span className="cc-mono" style={{ fontSize: 13, fontWeight: 500 }}>
                            {address?.slice(0, 8) ?? 'ckt1'}
                        </span>
                        <span className="cc-skel" style={{ flex: 1 }} />
                        <span className="cc-skel" style={{ width: 54 }} />
                    </div>
                )}
            </div>

            <div style={{ marginTop: 'auto', paddingTop: 16 }}>
                {done ? (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 8 }}>
                        <button type="button" className="cc-btn cc-btn-secondary" onClick={() => modal.setView({ screen: 'wallet' })}>
                            View wallet
                        </button>
                        <button type="button" className="cc-btn cc-btn-primary" onClick={modal.close} data-autofocus>
                            Continue
                        </button>
                    </div>
                ) : (
                    <div className="cc-note">
                        <span style={{ flexShrink: 0, marginTop: 2 }}>
                            <Icon.Lock />
                        </span>
                        <span>Your key is encrypted before it’s stored. Export it any time and take it to any CKB wallet.</span>
                    </div>
                )}
            </div>
        </>
    );
}
