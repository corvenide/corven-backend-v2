import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useConnectContext } from './provider';
import { CodeScreen, CreatingScreen, MainScreen } from './screens/auth';
import { SignScreen } from './screens/sign';
import { ExportScreen, ReceiveScreen, SendScreen, WalletScreen } from './screens/wallet';
import { cssVars } from './theme';

export function Modal() {
    const { modal, tokens, mode } = useConnectContext();
    const { view, signature, close } = modal;
    const open = view !== null || signature !== null;
    const dismiss = () => (signature ? signature.resolve({ approved: false }) : close());
    const card = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') dismiss();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    });

    // Move focus into the dialog when it opens or changes screen.
    useEffect(() => {
        if (!open || !card.current) return;
        const scope = card.current.querySelector<HTMLElement>('[data-active-screen]') ?? card.current;
        const first = scope.querySelector<HTMLElement>('[data-autofocus], input, button');
        first?.focus({ preventScroll: true });
    }, [view?.screen, signature]);

    if (!open || typeof document === 'undefined') return null;

    const screen = (() => {
        if (!view) return null;
        switch (view.screen) {
            case 'main':
                return <MainScreen link={view.link} />;
            case 'code':
                return <CodeScreen view={view} />;
            case 'creating':
                return <CreatingScreen />;
            case 'wallet':
                return <WalletScreen initialTab={view.tab} />;
            case 'send':
                return <SendScreen />;
            case 'receive':
                return <ReceiveScreen />;
            case 'export':
                return <ExportScreen />;
        }
    })();
    const current = signature ? 'sign' : view!.screen;

    return createPortal(
        <div className="cc-root" data-theme={mode} style={cssVars(tokens) as React.CSSProperties}>
            <div
                className="cc-overlay"
                onMouseDown={(e) => {
                    if (e.target === e.currentTarget && current !== 'sign' && current !== 'creating') close();
                }}
            >
                <div ref={card} className="cc-card" role="dialog" aria-modal="true" aria-label="Corven Connect" data-screen={current}>
                    {/* The screen under an approval stays mounted (hidden) so its state survives. */}
                    {screen && (
                        <div style={{ display: signature ? 'none' : 'contents' }} data-active-screen={signature ? undefined : ''}>
                            {screen}
                        </div>
                    )}
                    {signature && (
                        <div style={{ display: 'contents' }} data-active-screen="">
                            <SignScreen request={signature.request} resolve={signature.resolve} />
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}
