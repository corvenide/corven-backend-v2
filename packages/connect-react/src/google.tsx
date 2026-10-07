// The "Sign in with Google" button, rendered by Google Identity Services so
// it's the real, trusted Google button. It returns an ID token that the
// Connect API verifies.

import { useEffect, useRef, useState } from 'react';

declare global {
    interface Window {
        google?: any;
    }
}

let loader: Promise<void> | null = null;

function loadGis(): Promise<void> {
    if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
    if (window.google?.accounts?.id) return Promise.resolve();
    loader ??= new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => {
            loader = null;
            reject(new Error('Google sign-in could not load.'));
        };
        document.head.appendChild(script);
    });
    return loader;
}

export function GoogleButton({
    clientId,
    mode,
    onCredential,
    onError,
}: {
    clientId: string;
    mode: 'dark' | 'light';
    onCredential: (credential: string) => void;
    onError: (message: string) => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const callback = useRef(onCredential);
    callback.current = onCredential;
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        loadGis()
            .then(() => {
                if (cancelled || !ref.current) return;
                window.google.accounts.id.initialize({
                    client_id: clientId,
                    callback: (response: { credential?: string }) => {
                        if (response.credential) callback.current(response.credential);
                    },
                    ux_mode: 'popup',
                    auto_select: false,
                    use_fedcm_for_button: true,
                });
                window.google.accounts.id.renderButton(ref.current, {
                    type: 'standard',
                    theme: mode === 'dark' ? 'filled_black' : 'outline',
                    size: 'large',
                    shape: 'pill',
                    text: 'continue_with',
                    logo_alignment: 'center',
                    width: Math.min(392, ref.current.clientWidth || 392),
                });
            })
            .catch((error: Error) => {
                if (cancelled) return;
                setFailed(true);
                onError(error.message);
            });
        return () => {
            cancelled = true;
        };
    }, [clientId, mode]);

    if (failed) return null;
    return <div ref={ref} style={{ minHeight: 44, display: 'flex', justifyContent: 'center' }} data-testid="cc-google" />;
}
