// <CorvenConnectProvider> creates the Connect client, restores the session,
// renders the modal, and shows the approval screen whenever the app signs
// with the user's wallet.

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactNode,
} from 'react';
import type { ccc } from '@ckb-ccc/core';
import {
    CorvenConnect,
    type AppConfig,
    type AuthState,
    type CodeSent,
    type CorvenConnectSigner,
    type Network,
    type SignApproval,
    type SignRequest,
    type User,
} from '@corven/connect';

import { Modal } from './modal';
import { injectStyles } from './styles';
import { tokens, type ThemeMode, type Tokens } from './theme';

export type View =
    | { screen: 'main'; link?: boolean }
    | { screen: 'code'; to: { phone: string; channel?: 'sms' | 'whatsapp' | 'call' } | { email: string }; sent: CodeSent; link?: boolean }
    | { screen: 'creating' }
    | { screen: 'wallet'; tab?: 'activity' | 'logins' }
    | { screen: 'send' }
    | { screen: 'receive' }
    | { screen: 'export' };

export interface PendingSignature {
    request: SignRequest;
    resolve: (approval: SignApproval) => void;
}

export interface CorvenConnectProviderProps {
    /** Your app id (app_…). */
    appId: string;
    /** Defaults to Corven's hosted API. */
    apiUrl?: string;
    /** 'dark', 'light', or 'auto' (follows the OS). Default 'dark'. */
    theme?: ThemeMode | 'auto';
    /** Brand colour for buttons and highlights. Default Corven green. */
    accent?: string;
    /** Loads the Geist font from Google Fonts. Default true. */
    loadFonts?: boolean;
    /** ccc clients to use for each network (e.g. your own RPC or a devnet). */
    clients?: Partial<Record<Network, ccc.Client>>;
    /** Pass your own client instead of appId/apiUrl. */
    client?: CorvenConnect;
    /** Called after every successful sign-in. */
    onLogin?: (user: User, info: { isNewUser: boolean }) => void;
    children?: ReactNode;
}

export interface ModalController {
    view: View | null;
    /** A transaction waiting for approval; shown on top of `view`. */
    signature: PendingSignature | null;
    setView: (view: View | null) => void;
    close: () => void;
    finishLogin: (isNewUser: boolean) => void;
}

interface ContextValue {
    connect: CorvenConnect;
    state: AuthState;
    config: AppConfig | null;
    configError: string | null;
    mode: ThemeMode;
    tokens: Tokens;
    clients: Partial<Record<Network, ccc.Client>>;
    modal: ModalController;
}

const Context = createContext<ContextValue | null>(null);

export function useConnectContext(): ContextValue {
    const value = useContext(Context);
    if (!value) throw new Error('Corven Connect: wrap your app in <CorvenConnectProvider>.');
    return value;
}

function useSystemMode(enabled: boolean): ThemeMode {
    const query = typeof window !== 'undefined' && enabled ? window.matchMedia('(prefers-color-scheme: light)') : null;
    return useSyncExternalStore(
        (cb) => {
            query?.addEventListener('change', cb);
            return () => query?.removeEventListener('change', cb);
        },
        () => (query?.matches ? 'light' : 'dark'),
        () => 'dark',
    );
}

export function CorvenConnectProvider(props: CorvenConnectProviderProps) {
    const { appId, apiUrl, theme = 'dark', accent = '#3cc68a', loadFonts = true, clients = {}, onLogin, children } = props;

    const connect = useMemo(() => props.client ?? new CorvenConnect({ appId, apiUrl }), [props.client, appId, apiUrl]);
    const state = useSyncExternalStore(
        (cb) => connect.subscribe(cb),
        () => connect.authState,
        () => connect.authState,
    );

    const [config, setConfig] = useState<AppConfig | null>(null);
    const [configError, setConfigError] = useState<string | null>(null);
    const [view, setView] = useState<View | null>(null);
    const [signature, setSignature] = useState<PendingSignature | null>(null);
    const onLoginRef = useRef(onLogin);
    onLoginRef.current = onLogin;

    const system = useSystemMode(theme === 'auto');
    const mode: ThemeMode = theme === 'auto' ? system : theme;
    const t = useMemo(() => tokens(mode, accent), [mode, accent]);

    useEffect(() => injectStyles(loadFonts), [loadFonts]);

    useEffect(() => {
        void connect.init();
        connect
            .getConfig()
            .then(setConfig)
            .catch((e: Error) => setConfigError(e.message));
    }, [connect]);

    // Every signature from this app goes through the approval screen.
    useEffect(() => {
        connect.setApprovalHandler(
            (request) =>
                new Promise<SignApproval>((resolve) => {
                    setSignature((previous) => {
                        previous?.resolve({ approved: false });
                        return {
                            request,
                            resolve: (approval) => {
                                setSignature(null);
                                resolve(approval);
                            },
                        };
                    });
                }),
        );
        return () => connect.setApprovalHandler(null);
    }, [connect]);

    const close = useCallback(() => setView(null), []);

    const finishLogin = useCallback(
        (isNewUser: boolean) => {
            const user = connect.user;
            if (user) onLoginRef.current?.(user, { isNewUser });
            setView((current) => {
                if (current && 'link' in current && current.link) return { screen: 'wallet', tab: 'logins' };
                return isNewUser ? { screen: 'creating' } : null;
            });
        },
        [connect],
    );

    const value = useMemo<ContextValue>(
        () => ({ connect, state, config, configError, mode, tokens: t, clients, modal: { view, signature, setView, close, finishLogin } }),
        [connect, state, config, configError, mode, t, clients, view, signature, close, finishLogin],
    );

    return (
        <Context.Provider value={value}>
            {children}
            <Modal />
        </Context.Provider>
    );
}

/** Everything an app needs: state, login/logout, the wallet modal and a ccc signer. */
export function useCorvenConnect() {
    const { connect, state, config, modal, clients } = useConnectContext();

    return {
        /** False until the saved session has been checked. */
        ready: state.status !== 'loading',
        authenticated: state.status === 'signed-in',
        user: state.user,
        config,
        /** Opens the sign-in modal. */
        login: () => modal.setView({ screen: 'main' }),
        /** Opens the wallet (balance, send, receive, export, sign-in methods). */
        openWallet: () => modal.setView({ screen: 'wallet' }),
        closeModal: modal.close,
        logout: () => connect.logout(),
        /** A ccc signer for the user's wallet; signing shows the approval screen. */
        getSigner: (network: Network = 'TESTNET'): CorvenConnectSigner => connect.getSigner(network, clients[network]),
        /** The underlying @corven/connect client. */
        client: connect,
    };
}
