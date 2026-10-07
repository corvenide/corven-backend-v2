// The Corven Connect client: sign-in, session, wallets.
//
//   const connect = createCorvenConnect({ appId: 'app_…' });
//   await connect.init();                       // restores a saved session
//   await connect.sendCode({ phone: '0712 345 678' });
//   await connect.verifyCode({ phone: '0712 345 678', code: '123456' });
//   const signer = connect.getSigner('TESTNET'); // a ccc signer

import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

import { CorvenConnectError } from './errors';
import { browserStorage, memoryStorage, type TokenStorage } from './storage';
import type {
    ApprovalHandler,
    AppConfig,
    AuthState,
    CodeSent,
    Network,
    PhoneChannel,
    Session,
    SignApproval,
    SignRequest,
    StepUpMethod,
    StepUpPurpose,
    StepUpToken,
    User,
    WalletsResponse,
} from './types';

export const DEFAULT_API_URL = 'https://staging-api.corvanide.space/connect/v1';

export interface CorvenConnectOptions {
    /** Your app id from Corven (app_…). */
    appId: string;
    /** Defaults to Corven's hosted API. */
    apiUrl?: string;
    /** Where to keep the refresh token: 'local' (default) or 'memory', or your own. */
    storage?: 'local' | 'memory' | TokenStorage;
    fetch?: typeof fetch;
}

type Destination = { phone: string; channel?: PhoneChannel } | { email: string };
type Listener = (state: AuthState) => void;

export class CorvenConnect {
    readonly appId: string;
    readonly apiUrl: string;

    private readonly storage: TokenStorage;
    private readonly fetchImpl: typeof fetch;
    private readonly storageKey: string;

    private state: AuthState = { status: 'loading', user: null };
    private readonly listeners = new Set<Listener>();
    private access: { token: string; expiresAt: number } | null = null;
    private refreshing: Promise<void> | null = null;
    private configCache: Promise<AppConfig> | null = null;
    private initPromise: Promise<AuthState> | null = null;
    private approvalHandler: ApprovalHandler | null = null;

    constructor(options: CorvenConnectOptions) {
        if (!options?.appId) throw new Error('Corven Connect: appId is required.');
        this.appId = options.appId;
        this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
        this.storage =
            options.storage === 'memory' ? memoryStorage() : options.storage && options.storage !== 'local' ? options.storage : browserStorage();
        this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
        this.storageKey = `corven-connect:${this.appId}:session`;
    }

    // ------------------------------------------------------------ state

    get authState(): AuthState {
        return this.state;
    }

    get user(): User | null {
        return this.state.user;
    }

    /** Calls `listener` on every sign-in, sign-out and profile change. Returns an unsubscribe function. */
    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Restores the saved session, if any. Safe to call more than once. */
    init(): Promise<AuthState> {
        this.initPromise ??= (async () => {
            if (this.storage.get(this.storageKey)) {
                try {
                    await this.refresh();
                } catch {
                    // 401 already cleared the session; for network errors keep
                    // the saved token so the next load can try again.
                    if (this.state.status === 'loading') this.setState({ status: 'signed-out', user: null });
                }
            } else {
                this.signedOut();
            }
            return this.state;
        })();
        return this.initPromise;
    }

    getConfig(): Promise<AppConfig> {
        this.configCache ??= this.request<AppConfig>('GET', '/config').catch((e) => {
            this.configCache = null;
            throw e;
        });
        return this.configCache;
    }

    // ------------------------------------------------------------ sign in

    /** Sends a 6-digit code by SMS (default), WhatsApp, voice call, or email. */
    sendCode(to: Destination): Promise<CodeSent> {
        return this.request('POST', '/auth/code/send', to);
    }

    /** Signs in with the code. With `link: true` (signed in), adds the phone/email to the account instead. */
    async verifyCode(to: Destination & { code: string }, options: { link?: boolean } = {}): Promise<Session> {
        const session = await this.request<Session>('POST', '/auth/code/verify', to, { auth: options.link === true });
        this.signedIn(session);
        return session;
    }

    /** Signs in with a Google ID token from Google Identity Services. */
    async loginWithGoogle(credential: string, options: { link?: boolean } = {}): Promise<Session> {
        const session = await this.request<Session>('POST', '/auth/google', { credential }, { auth: options.link === true });
        this.signedIn(session);
        return session;
    }

    /** Signs in with a passkey added earlier (on this site). */
    async loginWithPasskey(): Promise<Session> {
        const { options, challengeToken } = await this.request<{ options: any; challengeToken: string }>('POST', '/auth/passkey/options');
        const response = await webauthn(() => startAuthentication({ optionsJSON: options }));
        const session = await this.request<Session>('POST', '/auth/passkey/verify', { response, challengeToken });
        this.signedIn(session);
        return session;
    }

    /** Adds a passkey for this site to the signed-in account. */
    async addPasskey(name?: string): Promise<User> {
        const { options, challengeToken } = await this.request<{ options: any; challengeToken: string }>('POST', '/me/passkeys/options', undefined, {
            auth: true,
        });
        const response = await webauthn(() => startRegistration({ optionsJSON: options }));
        return this.updateUser(await this.request<User>('POST', '/me/passkeys', { response, challengeToken, name }, { auth: true }));
    }

    async logout(): Promise<void> {
        const refreshToken = this.storage.get(this.storageKey);
        this.signedOut();
        if (refreshToken) await this.request('POST', '/auth/logout', { refreshToken }).catch(() => undefined);
    }

    // ------------------------------------------------------------ account

    async me(): Promise<User> {
        return this.updateUser(await this.request<User>('GET', '/me', undefined, { auth: true }));
    }

    async setDisplayName(displayName: string): Promise<User> {
        return this.updateUser(await this.request<User>('PATCH', '/me', { displayName }, { auth: true }));
    }

    async removeIdentity(identityId: string): Promise<User> {
        return this.updateUser(await this.request<User>('DELETE', `/me/identities/${encodeURIComponent(identityId)}`, undefined, { auth: true }));
    }

    async removePasskey(passkeyId: string): Promise<User> {
        return this.updateUser(await this.request<User>('DELETE', `/me/passkeys/${encodeURIComponent(passkeyId)}`, undefined, { auth: true }));
    }

    // ------------------------------------------------------------ step-up

    /** Sends a code to the user's own phone or email, to confirm a sensitive action. */
    sendStepUpCode(method: 'PHONE' | 'EMAIL', channel?: PhoneChannel): Promise<CodeSent> {
        return this.request('POST', '/step-up/code/send', { method, channel }, { auth: true });
    }

    verifyStepUp(
        purpose: StepUpPurpose,
        proof: { method: 'PHONE' | 'EMAIL'; code: string } | { method: 'GOOGLE'; credential: string },
    ): Promise<StepUpToken> {
        return this.request('POST', '/step-up/verify', { purpose, ...proof }, { auth: true });
    }

    async stepUpWithPasskey(purpose: StepUpPurpose): Promise<StepUpToken> {
        const { options, challengeToken } = await this.request<{ options: any; challengeToken: string }>('POST', '/step-up/passkey/options', undefined, {
            auth: true,
        });
        const response = await webauthn(() => startAuthentication({ optionsJSON: options }));
        return this.request('POST', '/step-up/verify', { purpose, method: 'PASSKEY' as StepUpMethod, response, challengeToken }, { auth: true });
    }

    // ------------------------------------------------------------ wallets

    getWallets(): Promise<WalletsResponse> {
        return this.request('GET', '/wallets', undefined, { auth: true });
    }

    /**
     * Signs a transaction with the user's wallet (no approval UI; the React
     * modal and CorvenConnectSigner add that). Mainnet needs a step-up token.
     */
    signTransaction(network: Network, transaction: unknown, stepUpToken?: string): Promise<{ transaction: unknown; txHash: string; outflow: string }> {
        return this.request('POST', '/wallets/sign', { network, transaction, stepUpToken }, { auth: true });
    }

    exportPrivateKey(network: Network, stepUpToken: string): Promise<{ network: Network; address: string; privateKey: string }> {
        return this.request('POST', '/wallets/export', { network, stepUpToken }, { auth: true });
    }

    /**
     * Who approves signatures. The React provider registers its modal here.
     * Without a handler, testnet transactions are signed directly and mainnet
     * ones are refused.
     */
    setApprovalHandler(handler: ApprovalHandler | null): void {
        this.approvalHandler = handler;
    }

    /** @internal Used by CorvenConnectSigner. */
    async approve(request: SignRequest): Promise<SignApproval> {
        if (this.approvalHandler) return this.approvalHandler(request);
        if (request.network === 'TESTNET') return { approved: true };
        throw new CorvenConnectError('Mainnet signing needs an approval handler (use @corven/connect-react).', 0, 'step_up_required');
    }

    // ------------------------------------------------------------ http

    /** Access token for your own backend calls, refreshed as needed. Verify it server-side with GET /me. */
    async getAccessToken(): Promise<string | null> {
        if (this.state.status !== 'signed-in') return null;
        await this.ensureFreshAccess();
        return this.access?.token ?? null;
    }

    private async request<T>(method: string, path: string, body?: unknown, opts: { auth?: boolean; retried?: boolean } = {}): Promise<T> {
        const headers: Record<string, string> = { 'x-corven-app': this.appId };
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (opts.auth) {
            await this.ensureFreshAccess();
            if (!this.access) throw new CorvenConnectError('Sign in first.', 401, 'unauthorized');
            headers.authorization = `Bearer ${this.access.token}`;
        }

        let res: Response;
        try {
            res = await this.fetchImpl(this.apiUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        } catch {
            throw new CorvenConnectError('Can\'t reach Corven Connect. Check your connection.', 0, 'network_error');
        }

        const data = await res.json().catch(() => null);
        if (res.ok) return data as T;

        if (res.status === 401 && opts.auth && !opts.retried && data?.code === 'unauthorized') {
            this.access = null;
            return this.request(method, path, body, { ...opts, retried: true });
        }
        const message = Array.isArray(data?.message) ? data.message.join(' ') : (data?.message ?? `Request failed (${res.status}).`);
        throw new CorvenConnectError(message, res.status, data?.code);
    }

    private async ensureFreshAccess(): Promise<void> {
        if (this.access && this.access.expiresAt - Date.now() > 30_000) return;
        if (!this.storage.get(this.storageKey)) return;
        await this.refresh();
    }

    private refresh(): Promise<void> {
        this.refreshing ??= (async () => {
            const refreshToken = this.storage.get(this.storageKey);
            try {
                const session = await this.request<Session>('POST', '/auth/refresh', { refreshToken });
                this.signedIn(session);
            } catch (error) {
                if (error instanceof CorvenConnectError && error.status === 401) this.signedOut();
                throw error;
            }
        })().finally(() => (this.refreshing = null));
        return this.refreshing;
    }

    private signedIn(session: Session): void {
        this.access = { token: session.accessToken, expiresAt: Date.parse(session.accessTokenExpiresAt) };
        this.storage.set(this.storageKey, session.refreshToken);
        this.setState({ status: 'signed-in', user: session.user });
    }

    private signedOut(): void {
        this.access = null;
        this.storage.remove(this.storageKey);
        this.setState({ status: 'signed-out', user: null });
    }

    private updateUser(user: User): User {
        if (this.state.status === 'signed-in') this.setState({ status: 'signed-in', user });
        return user;
    }

    private setState(state: AuthState): void {
        this.state = state;
        for (const listener of [...this.listeners]) {
            try {
                listener(state);
            } catch {
                /* a listener's error is its own */
            }
        }
    }
}

export function createCorvenConnect(options: CorvenConnectOptions): CorvenConnect {
    return new CorvenConnect(options);
}

async function webauthn<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        const name = (error as { name?: string })?.name;
        if (name === 'NotAllowedError' || name === 'AbortError') {
            throw new CorvenConnectError('Passkey request was cancelled.', 0, 'passkey_cancelled');
        }
        throw new CorvenConnectError(error instanceof Error ? error.message : 'Passkey failed.', 0, 'passkey_failed');
    }
}
