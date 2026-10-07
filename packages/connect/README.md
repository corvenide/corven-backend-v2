# @corven/connect

The framework-free Corven Connect client. For React, use
`@corven/connect-react`, which adds the modal.

```ts
import { createCorvenConnect } from '@corven/connect';

const connect = createCorvenConnect({ appId: 'app_…' });
await connect.init();                                   // restores a saved session

await connect.sendCode({ phone: '0712 345 678' });      // or { email }, channel: 'whatsapp' | 'call'
await connect.verifyCode({ phone: '0712 345 678', code: '123456' });

const signer = connect.getSigner('TESTNET');            // ccc signer
connect.subscribe((state) => console.log(state.status, state.user));
```

Other methods: `loginWithGoogle(idToken)`, `loginWithPasskey()`,
`addPasskey()`, `logout()`, `me()`, `getWallets()`,
`sendStepUpCode()` / `verifyStepUp()` / `stepUpWithPasskey()`,
`signTransaction()`, `exportPrivateKey()`, `getAccessToken()`,
`setApprovalHandler()`.

Without an approval handler, testnet transactions are signed directly and
mainnet ones are refused. The refresh token is kept in `localStorage`
(`storage: 'memory'` to keep it in memory only).
