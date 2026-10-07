// Small building blocks shared by the screens.

import { useEffect, useState, type ReactNode } from 'react';
import { CorvenConnectError } from '@corven/connect';

import * as Icon from './icons';

export function Header({ left, center, onClose }: { left?: ReactNode; center?: ReactNode; onClose?: () => void }) {
    return (
        <div className="cc-between" style={{ minHeight: 36 }}>
            <div style={{ minWidth: 36 }}>{left}</div>
            <div>{center}</div>
            <div style={{ minWidth: 36, display: 'flex', justifyContent: 'flex-end' }}>
                {onClose && (
                    <button type="button" className="cc-icon-btn" aria-label="Close" onClick={onClose}>
                        <Icon.Close />
                    </button>
                )}
            </div>
        </div>
    );
}

export function BackButton({ onClick }: { onClick: () => void }) {
    return (
        <button type="button" className="cc-icon-btn" aria-label="Back" onClick={onClick}>
            <Icon.Back />
        </button>
    );
}

export function Steps({ total, current }: { total: number; current: number }) {
    return (
        <div className="cc-dots" aria-label={`Step ${current} of ${total}`}>
            {Array.from({ length: total }, (_, i) => (
                <span key={i} data-on={i < current} />
            ))}
        </div>
    );
}

export function Hero({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
    return (
        <>
            <div
                style={{
                    marginTop: 40,
                    alignSelf: 'center',
                    width: 72,
                    height: 72,
                    borderRadius: 22,
                    background: 'var(--cc-accent-soft)',
                    color: 'var(--cc-accent-ink)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                {icon}
            </div>
            <h2 style={{ margin: '22px 0 8px', fontSize: 27, fontWeight: 600, letterSpacing: '-0.03em', textAlign: 'center' }}>{title}</h2>
            {children && <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--cc-muted)', textAlign: 'center' }}>{children}</p>}
        </>
    );
}

export function ErrorText({ error }: { error: string | null }) {
    if (!error) return null;
    return (
        <div className="cc-error" role="alert">
            {error}
        </div>
    );
}

export function Spinner() {
    return <span className="cc-spin" aria-hidden="true" />;
}

export function Footer() {
    return (
        <div style={{ marginTop: 'auto', paddingTop: 18, textAlign: 'center', fontSize: 12, color: 'var(--cc-faint)' }}>
            <span className="cc-row" style={{ justifyContent: 'center', gap: 6 }}>
                <Icon.Lock />
                Secured by <strong style={{ color: 'var(--cc-muted)', fontWeight: 600 }}>Corven Connect</strong>
            </span>
        </div>
    );
}

export function CopyButton({ value, label, children, className = 'cc-icon-btn' }: { value: string; label: string; children?: ReactNode; className?: string }) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const t = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(t);
    }, [copied]);

    return (
        <button
            type="button"
            className={className}
            aria-label={copied ? 'Copied' : label}
            onClick={() => {
                void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined);
            }}
        >
            {children}
            {copied ? <Icon.Check /> : <Icon.Copy />}
        </button>
    );
}

export function messageOf(error: unknown): string {
    if (error instanceof CorvenConnectError) return error.message;
    if (error instanceof Error) return error.message;
    return 'Something went wrong. Try again.';
}

/** Runs an async action with busy/error state. */
export function useAction() {
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const run = async <T,>(key: string, action: () => Promise<T>): Promise<T | undefined> => {
        setBusy(key);
        setError(null);
        try {
            return await action();
        } catch (e) {
            setError(messageOf(e));
            return undefined;
        } finally {
            setBusy(null);
        }
    };

    return { busy, error, setError, run };
}

export function initials(name: string | null | undefined, fallback: string): string {
    const source = (name ?? '').trim() || fallback;
    const words = source.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
    const text = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2);
    return text.toUpperCase() || '?';
}

/** "+254712345678" -> "+254 712 ••• 678" */
export function maskPhone(phone: string): string {
    if (phone.length < 9) return phone;
    const cc = phone.startsWith('+254') ? '+254' : phone.slice(0, phone.length - 9);
    const rest = phone.slice(cc.length);
    return `${cc} ${rest.slice(0, 3)} ••• ${rest.slice(-3)}`;
}
