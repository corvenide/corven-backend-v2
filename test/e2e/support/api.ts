// HTTP client for the end-to-end tests. Talks to a running API gateway
// (E2E_API_URL) the way the browser does: it sends an Origin header, keeps
// the refresh cookie, and signs in with a real CKB wallet signature.

import { ccc } from '@ckb-ccc/core';
import { randomBytes } from 'node:crypto';

export const API_URL = (process.env.E2E_API_URL || 'http://localhost:8000/api').replace(/\/$/, '');
export const ORIGIN = process.env.E2E_ORIGIN || 'http://localhost:5173';

const REFRESH_COOKIE = 'corven_rt';

export interface ApiResponse<T = any> {
    status: number;
    body: T;
    headers: Headers;
}

let ipCounter = 0;

/** A made-up client IP, so each client gets its own rate-limit bucket. */
function nextIp(): string {
    ipCounter += 1;
    return `10.${(process.pid >> 8) & 255}.${process.pid & 255}.${ipCounter % 250 + 1}`;
}

export class ApiClient {
    accessToken: string | null = null;
    refreshToken: string | null = null;
    readonly ip = nextIp();

    async request<T = any>(
        method: string,
        path: string,
        options: { body?: unknown; origin?: string | null; auth?: boolean; cookie?: string | null } = {},
    ): Promise<ApiResponse<T>> {
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'X-Forwarded-For': this.ip,
        };

        const origin = options.origin === undefined ? ORIGIN : options.origin;
        if (origin) headers.Origin = origin;

        if (options.body !== undefined) headers['Content-Type'] = 'application/json';
        if (options.auth !== false && this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;

        const cookie = options.cookie === undefined ? this.refreshToken : options.cookie;
        if (cookie) headers.Cookie = `${REFRESH_COOKIE}=${encodeURIComponent(cookie)}`;

        const response = await fetch(`${API_URL}${path}`, {
            method,
            headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });

        this.captureRefreshCookie(response.headers);

        const text = await response.text();
        let body: any = text;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            /* not JSON */
        }

        return { status: response.status, body, headers: response.headers };
    }

    get<T = any>(path: string) {
        return this.request<T>('GET', path);
    }

    post<T = any>(path: string, body?: unknown) {
        return this.request<T>('POST', path, { body: body ?? {} });
    }

    put<T = any>(path: string, body?: unknown) {
        return this.request<T>('PUT', path, { body: body ?? {} });
    }

    delete<T = any>(path: string) {
        return this.request<T>('DELETE', path);
    }

    private captureRefreshCookie(headers: Headers): void {
        for (const cookie of headers.getSetCookie()) {
            const [pair] = cookie.split(';');
            const [name, ...rest] = pair.split('=');

            if (name.trim() === REFRESH_COOKIE) {
                const value = decodeURIComponent(rest.join('='));
                this.refreshToken = value || null;
            }
        }
    }
}

const client = new ccc.ClientPublicTestnet();

/** A throwaway CKB testnet wallet. */
export async function createWallet(privateKey = `0x${randomBytes(32).toString('hex')}`) {
    const signer = new ccc.SignerCkbPrivateKey(client, privateKey);
    const address = await signer.getRecommendedAddress();

    return {
        address,
        sign: (message: string) => signer.signMessage(message),
    };
}

export type Wallet = Awaited<ReturnType<typeof createWallet>>;

/** Gets a sign-in challenge and signs it. Does not log in. */
export async function signedChallenge(api: ApiClient, wallet: Wallet, signer: Wallet = wallet) {
    const challenge = await api.post('/auth/wallet/challenge', { walletAddress: wallet.address });

    if (challenge.status !== 201) {
        throw new Error(`challenge failed: ${challenge.status} ${JSON.stringify(challenge.body)}`);
    }

    const signature = await signer.sign(challenge.body.message);

    return {
        walletAddress: wallet.address,
        challengeId: challenge.body.challengeId,
        signature: JSON.parse(JSON.stringify(signature)),
    };
}

/** A client signed in with a new wallet. */
export async function signedInClient(): Promise<{ api: ApiClient; wallet: Wallet; user: any }> {
    const api = new ApiClient();
    const wallet = await createWallet();

    const login = await api.post('/auth/wallet/login', await signedChallenge(api, wallet));

    if (login.status !== 201) {
        throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
    }

    api.accessToken = login.body.accessToken;

    return { api, wallet, user: login.body.user };
}
