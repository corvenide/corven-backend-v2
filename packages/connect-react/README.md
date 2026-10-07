# @corven/connect-react

Phone, email, Google and passkey sign-in with an embedded CKB wallet, for
React apps.

```
npm install @corven/connect-react @ckb-ccc/core
npm install @ckb-ccc/ccc   # optional: "Connect a wallet" (JoyID, MetaMask, UniSat, OKX…)
```

```tsx
import { CorvenConnectProvider, ConnectButton, useCorvenConnect } from '@corven/connect-react';
import { ccc } from '@ckb-ccc/core';

export default function App() {
    return (
        <CorvenConnectProvider appId="app_…" theme="dark" accent="#3cc68a">
            <ConnectButton />
            <Pay />
        </CorvenConnectProvider>
    );
}

function Pay() {
    const { authenticated, getSigner } = useCorvenConnect();
    if (!authenticated) return null;

    return (
        <button
            onClick={async () => {
                const signer = getSigner('TESTNET'); // a ccc signer
                const { script } = await ccc.Address.fromString('ckt1…', signer.client);
                const tx = ccc.Transaction.from({ outputs: [{ lock: script, capacity: ccc.fixedPointFrom(100) }] });
                await tx.completeInputsByCapacity(signer);
                await tx.completeFeeBy(signer);
                await signer.sendTransaction(tx); // shows the approval screen
            }}
        >
            Pay 100 CKB
        </button>
    );
}
```

### Provider props

| Prop | Default | |
|---|---|---|
| `appId` | required | from Corven |
| `apiUrl` | Corven's hosted API | e.g. a local connect-service |
| `theme` | `'dark'` | `'dark'`, `'light'` or `'auto'` |
| `accent` | `#3cc68a` | brand colour |
| `clients` | public nodes | `{ TESTNET?: ccc.Client, MAINNET?: ccc.Client }` |
| `loadFonts` | `true` | loads Geist from Google Fonts |
| `onLogin` | | `(user, { isNewUser }) => void` |

### `useCorvenConnect()`

`ready`, `authenticated`, `user`, `config`, `login()`, `openWallet()`,
`closeModal()`, `logout()`, `getSigner(network)`, `externalWallet`,
`reconnectWallet()`, `client` (the `@corven/connect` client).

People who signed in with their own wallet (`user.embeddedWallets === false`)
sign with it: `getSigner('TESTNET')` returns that wallet's CCC signer and the
wallet shows its own prompt. After a page reload the SDK reconnects it
quietly when the wallet allows; otherwise the wallet screen offers "Reconnect".

Signing a mainnet transaction asks the user to confirm with a code,
passkey or Google first. `UserRejectedError` is thrown when they reject.
