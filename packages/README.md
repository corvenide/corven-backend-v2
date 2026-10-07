# Corven Connect SDK

| Package | What |
|---|---|
| `@corven/connect` | Framework-free client: sign-in, session, wallets, a ccc signer |
| `@corven/connect-react` | Provider, `useCorvenConnect()`, `<ConnectButton>`, and the modal |
| `example` | Vite + React example app |

This folder is its own npm workspace (the backend uses pnpm and doesn't
include it, and the Docker build ignores it).

```
cd packages
npm install
npm run build                 # both packages
cp example/.env.example example/.env   # set VITE_CORVEN_APP_ID
npm run example               # http://localhost:5199
```

Publish: `npm publish -w @corven/connect --access public`, then
`-w @corven/connect-react`. (Create the `@corven` npm org first.)

Backend setup and the API: `docs/CORVEN CONNECT.md`.
