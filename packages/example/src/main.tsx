// Corven Connect example: sign in, see the wallet, send testnet CKB.
//   cp .env.example .env && npm run dev

import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ccc } from '@ckb-ccc/core';
import { ConnectButton, CorvenConnectProvider, UserRejectedError, formatCkb, useCorvenConnect } from '@corven/connect-react';

const params = new URLSearchParams(location.search);
const env = import.meta.env;

function testnetClient(): ccc.Client | undefined {
    if (!env.VITE_CKB_RPC_URL) return undefined;
    const scripts = env.VITE_CKB_SCRIPTS ? JSON.parse(env.VITE_CKB_SCRIPTS) : undefined;
    return new ccc.ClientPublicTestnet({ url: env.VITE_CKB_RPC_URL, ...(scripts ? { scripts } : {}) } as never);
}

function Demo() {
    const { ready, authenticated, user, getSigner, logout } = useCorvenConnect();
    const [to, setTo] = useState('');
    const [result, setResult] = useState('');

    const send = async () => {
        setResult('Building…');
        try {
            const signer = getSigner('TESTNET');
            const { script } = await ccc.Address.fromString(to, signer.client);
            const tx = ccc.Transaction.from({ outputs: [{ lock: script, capacity: ccc.fixedPointFrom(100) }] });
            await tx.completeInputsByCapacity(signer);
            await tx.completeFeeBy(signer);
            setResult(`Sent: ${await signer.sendTransaction(tx)}`);
        } catch (e) {
            setResult(e instanceof UserRejectedError ? 'You rejected it.' : `Error: ${(e as Error).message}`);
        }
    };

    return (
        <main style={{ maxWidth: 560, margin: '64px auto', padding: '0 16px', fontFamily: 'system-ui, sans-serif' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h1 style={{ fontSize: 22 }}>My CKB dApp</h1>
                <ConnectButton />
            </div>
            {!ready && <p>Loading…</p>}
            {ready && !authenticated && <p>Sign in with your phone, email, Google or a passkey. You get a CKB wallet instantly.</p>}
            {authenticated && user && (
                <section>
                    <p data-testid="demo-user">Signed in as {user.identities[0]?.value}</p>
                    <p style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>{user.wallets.find((w) => w.network === 'TESTNET')?.address}</p>
                    <h2 style={{ fontSize: 16 }}>Send 100 testnet CKB from code</h2>
                    <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="ckt1…" style={{ width: '100%', padding: 8 }} aria-label="demo recipient" />
                    <button onClick={send} style={{ marginTop: 8 }}>
                        Send with getSigner()
                    </button>
                    <p data-testid="demo-result" style={{ wordBreak: 'break-all' }}>{result}</p>
                    <button onClick={() => logout()}>Log out</button>
                </section>
            )}
            <p style={{ color: '#888', fontSize: 12 }}>{formatCkb(100_000_000n)} CKB = 100,000,000 shannons</p>
        </main>
    );
}

function App() {
    const clients = useMemo(() => {
        const testnet = testnetClient();
        return testnet ? { TESTNET: testnet } : {};
    }, []);
    return (
        <CorvenConnectProvider
            appId={params.get('app') ?? env.VITE_CORVEN_APP_ID}
            apiUrl={env.VITE_CORVEN_API_URL || undefined}
            theme={(params.get('theme') as 'dark' | 'light' | null) ?? 'dark'}
            accent={params.get('accent') ?? undefined}
            clients={clients}
        >
            <Demo />
        </CorvenConnectProvider>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
