import { ApiClient, createWallet, signedChallenge, signedInClient } from './support/api';

describe('Auth (e2e)', () => {
    describe('wallet sign-in', () => {
        it('signs in with a wallet signature and returns the user', async () => {
            const api = new ApiClient();
            const wallet = await createWallet();

            const challenge = await api.post('/auth/wallet/challenge', { walletAddress: wallet.address });
            expect(challenge.status).toBe(201);
            expect(challenge.body.message).toContain(wallet.address);

            const signature = await wallet.sign(challenge.body.message);
            const login = await api.post('/auth/wallet/login', {
                walletAddress: wallet.address,
                challengeId: challenge.body.challengeId,
                signature: JSON.parse(JSON.stringify(signature)),
            });

            expect(login.status).toBe(201);
            expect(login.body.accessToken).toEqual(expect.any(String));
            expect(login.body.user).toMatchObject({ walletAddress: wallet.address, authProvider: 'CKB_WALLET' });
            // The refresh token only travels in the httpOnly cookie.
            expect(login.body).not.toHaveProperty('refreshToken');
            expect(api.refreshToken).toEqual(expect.any(String));
            expect(login.headers.getSetCookie().join()).toMatch(/HttpOnly/i);

            api.accessToken = login.body.accessToken;
            const me = await api.get('/auth/me');
            expect(me.status).toBe(200);
            expect(me.body).toMatchObject({ id: login.body.user.id, walletAddress: wallet.address });
        });

        it('signs the same wallet into the same account every time', async () => {
            const api = new ApiClient();
            const wallet = await createWallet();

            const first = await api.post('/auth/wallet/login', await signedChallenge(api, wallet));
            const second = await api.post('/auth/wallet/login', await signedChallenge(api, wallet));

            expect(second.body.user.id).toBe(first.body.user.id);
        });

        it("rejects a signature from another wallet claiming this wallet's address", async () => {
            const api = new ApiClient();
            const victim = await createWallet();
            const attacker = await createWallet();

            const login = await api.post('/auth/wallet/login', await signedChallenge(api, victim, attacker));

            expect(login.status).toBe(401);
            expect(api.refreshToken).toBeNull();
        });

        it('rejects reusing a challenge', async () => {
            const api = new ApiClient();
            const wallet = await createWallet();
            const signed = await signedChallenge(api, wallet);

            expect((await api.post('/auth/wallet/login', signed)).status).toBe(201);

            const replay = await api.post('/auth/wallet/login', signed);
            expect(replay.status).toBe(401);
            expect(replay.body.message).toMatch(/already used/);
        });

        it('rejects a challenge issued for a different wallet', async () => {
            const api = new ApiClient();
            const alice = await createWallet();
            const bob = await createWallet();
            const forBob = await signedChallenge(api, bob);

            const login = await api.post('/auth/wallet/login', { ...forBob, walletAddress: alice.address });

            expect(login.status).toBe(401);
        });

        it.each([
            ['no wallet address', { walletAddress: '' }],
            ['an invalid address', { walletAddress: 'not-a-ckb-address' }],
        ])('rejects a challenge request with %s', async (_label, body) => {
            const response = await new ApiClient().post('/auth/wallet/challenge', body);
            expect(response.status).toBe(400);
        });

        it('rejects a malformed signature', async () => {
            const api = new ApiClient();
            const wallet = await createWallet();
            const signed = await signedChallenge(api, wallet);

            const login = await api.post('/auth/wallet/login', { ...signed, signature: { signature: 'nope' } });

            expect(login.status).toBe(400);
        });

        it('limits sign-in attempts per client', async () => {
            const api = new ApiClient();
            const wallet = await createWallet();
            const statuses: number[] = [];

            for (let attempt = 0; attempt < 21; attempt += 1) {
                const response = await api.post('/auth/wallet/challenge', { walletAddress: wallet.address });
                statuses.push(response.status);
            }

            expect(statuses.slice(0, 20).every((status) => status === 201)).toBe(true);
            expect(statuses[20]).toBe(429);
        });
    });

    describe('sessions', () => {
        it('requires a valid access token', async () => {
            const api = new ApiClient();

            expect((await api.get('/auth/me')).status).toBe(401);
            expect((await api.get('/workspaces')).status).toBe(401);

            api.accessToken = 'not.a.token';
            expect((await api.get('/workspaces')).status).toBe(401);
        });

        it('refreshes the session and rotates the refresh cookie', async () => {
            const { api, user } = await signedInClient();
            const firstCookie = api.refreshToken;

            const refreshed = await api.post('/auth/refresh');

            expect(refreshed.status).toBe(200);
            expect(refreshed.body.user.id).toBe(user.id);
            expect(api.refreshToken).not.toBe(firstCookie);

            api.accessToken = refreshed.body.accessToken;
            expect((await api.get('/auth/me')).status).toBe(200);
        });

        it('revokes the whole session when an old refresh cookie is reused', async () => {
            const { api } = await signedInClient();
            const stolen = api.refreshToken;

            // The real user refreshes; the stolen cookie is now stale.
            expect((await api.post('/auth/refresh')).status).toBe(200);
            const current = api.refreshToken;

            // The thief replays the old cookie...
            const replay = await api.request('POST', '/auth/refresh', { body: {}, cookie: stolen });
            expect(replay.status).toBe(401);

            // ...which also signs out the real user's newer cookie.
            const afterReuse = await api.request('POST', '/auth/refresh', { body: {}, cookie: current });
            expect(afterReuse.status).toBe(401);
        });

        it('refuses to refresh from another site', async () => {
            const { api } = await signedInClient();

            const response = await api.request('POST', '/auth/refresh', { body: {}, origin: 'https://evil.example' });

            expect(response.status).toBe(403);
        });

        it('refuses to refresh without a cookie', async () => {
            const response = await new ApiClient().post('/auth/refresh');
            expect(response.status).toBe(401);
        });

        it('logs out: the refresh cookie stops working', async () => {
            const { api } = await signedInClient();
            const cookie = api.refreshToken;

            expect((await api.post('/auth/logout')).status).toBeLessThan(300);

            const refresh = await api.request('POST', '/auth/refresh', { body: {}, cookie });
            expect(refresh.status).toBe(401);
        });

        it('logs out everywhere: every device loses its session', async () => {
            const first = await signedInClient();

            // Same wallet, second device.
            const secondDevice = new ApiClient();
            const login = await secondDevice.post(
                '/auth/wallet/login',
                await signedChallenge(secondDevice, first.wallet),
            );
            expect(login.status).toBe(201);

            expect((await first.api.post('/auth/logout-all')).status).toBeLessThan(300);

            expect((await first.api.post('/auth/refresh')).status).toBe(401);
            expect((await secondDevice.post('/auth/refresh')).status).toBe(401);
        });
    });

    describe('CORS', () => {
        it('allows the configured frontend origin with credentials', async () => {
            const response = await new ApiClient().get('/health');

            expect(response.headers.get('access-control-allow-origin')).toBe(process.env.E2E_ORIGIN || 'http://localhost:5173');
            expect(response.headers.get('access-control-allow-credentials')).toBe('true');
        });

        it('does not allow other origins', async () => {
            const response = await new ApiClient().request('GET', '/health', { origin: 'https://evil.example' });

            expect(response.headers.get('access-control-allow-origin')).toBeNull();
        });
    });
});
