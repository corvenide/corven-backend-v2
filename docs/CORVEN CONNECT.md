# Corven Connect

Sign-in (phone, email, Google, passkeys) with an embedded CKB wallet, for
other apps. Like Privy, built for CKB and for phone-first users.

It lives in this backend but is kept apart from Corven IDE:

| | Corven IDE | Corven Connect |
|---|---|---|
| Service | api-gateway + auth-service | `apps/connect-service` (own HTTP service) |
| URL | `https://API_DOMAIN/api/...` | `https://API_DOMAIN/connect/v1/...` (Caddy routes `/connect/*`) |
| Users | `User` | `ConnectUser` (per app), `ConnectIdentity`, `ConnectPasskey` |
| Sessions | `RefreshToken`, `JWT_SECRET` | `ConnectSession`, `CONNECT_JWT_SECRET` |
| Wallets | `UserWallet`, `WALLET_ENCRYPTION_KEY` | `ConnectWallet`, `CONNECT_WALLET_ENCRYPTION_KEY` |
| CORS | `CORS_ORIGINS` | each app's `allowedOrigins` |

Same database, same Docker image (`SERVICE=connect-service`), same domain.

## Set up on the server

1. Twilio Verify: create a Verify service (console > Verify > Services).
   Enable SMS, WhatsApp and Voice. For email codes, add an email integration
   (SendGrid) to the service.
2. Add to `deploy/.env` (see `.env.example`):
   ```
   CONNECT_JWT_SECRET=$(openssl rand -base64 48)
   CONNECT_WALLET_ENCRYPTION_KEY=$(openssl rand -base64 32)   # back it up off the server
   CONNECT_ADMIN_TOKEN=$(openssl rand -hex 24)
   CONNECT_OTP_PROVIDER=twilio
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   TWILIO_VERIFY_SERVICE_SID=VA...
   ```
3. `bash deploy/deploy.sh` (runs the migration `20261007120000_corven_connect`,
   starts `connect-service`, reloads Caddy).
4. Check: `curl https://staging-api.corvanide.space/connect/health`

## Register an app

```
curl -X POST https://staging-api.corvanide.space/connect/v1/admin/apps \
  -H "Authorization: Bearer $CONNECT_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Kisumu Market","allowedOrigins":["https://kisumu.market","http://localhost:5173"],
       "googleClientId":"123-abc.apps.googleusercontent.com"}'
```

Returns `{ "id": "app_…" }`, the app id for the SDK. Other fields:
`loginMethods` (any of `PHONE`, `EMAIL`, `GOOGLE`, `PASSKEY`), `logoUrl`,
`mainnetEnabled` (default false). Change them with
`PATCH /connect/v1/admin/apps/:id`; list with `GET /connect/v1/admin/apps`.

Google: the app's own OAuth client must list the app's pages under
Authorized JavaScript origins. `CONNECT_GOOGLE_CLIENT_ID` is a fallback.

## Security model

- Users, identities and wallets are per app: app A's token is refused by app B.
- An identity (phone, email, Google account) belongs to one user per app.
  Linking one that belongs to someone else is refused (409); nothing merges
  silently.
- Refresh tokens are hashed, rotated on every use; reusing an old one
  revokes the whole session family.
- Wallet keys: AES-256-GCM envelope encryption, bound to user, network and
  address. The master key never touches the database.
- Signing: input cells are always looked up on chain (anything the caller
  says about them is ignored). The transaction must spend the user's cells.
- Mainnet: only for apps with `mainnetEnabled`, only with a fresh step-up
  (code, passkey or Google, single use, 5 minutes), capped by
  `CONNECT_MAINNET_DAILY_LIMIT_CKB` per user per 24 hours.
- Key export needs its own step-up.
- Rate limits on code sends (per IP, per destination) and checks.

Holding keys for users (custody), especially on mainnet, may carry legal
obligations. Move `CONNECT_WALLET_ENCRYPTION_KEY` to a KMS before mainnet use.

## API (all under /connect/v1, header `x-corven-app: app_…`)

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | /config | | name, methods, Google client id, networks |
| POST | /auth/code/send | `{phone, channel?}` or `{email}` | channel: sms, whatsapp, call |
| POST | /auth/code/verify | `{phone or email, code}` | session; with bearer: links |
| POST | /auth/google | `{credential}` | session; with bearer: links |
| POST | /auth/passkey/options | | then /auth/passkey/verify `{response, challengeToken}` |
| POST | /auth/refresh | `{refreshToken}` | rotates |
| POST | /auth/logout | `{refreshToken}` | |
| GET/PATCH | /me | `{displayName}` | bearer |
| DELETE | /me/identities/:id, /me/passkeys/:id | | keeps at least one |
| POST | /me/passkeys/options, /me/passkeys | | add a passkey |
| POST | /step-up/code/send | `{method: PHONE or EMAIL}` | |
| POST | /step-up/passkey/options | | |
| POST | /step-up/verify | `{purpose: sign or export, method, code / credential / response+challengeToken}` | `{stepUpToken}` |
| GET | /wallets | | balances + activity |
| POST | /wallets/sign | `{network, transaction, stepUpToken?}` | signed tx |
| POST | /wallets/export | `{network, stepUpToken}` | private key |

Sessions return `{accessToken, refreshToken, isNewUser, user}`. Errors are
`{statusCode, message, code}`.

To check a Connect user from your own backend, call `GET /connect/v1/me`
with their access token (`connect.getAccessToken()` in the SDK).

## Local development

```
# .env
CONNECT_JWT_SECRET=<32+ chars>  CONNECT_WALLET_ENCRYPTION_KEY=<openssl rand -base64 32>
CONNECT_ADMIN_TOKEN=<24+ chars> CONNECT_OTP_PROVIDER=console
pnpm dev connect          # codes are printed in the log
```

Against an offckb devnet: `CONNECT_CKB_TESTNET_RPC_URL=http://127.0.0.1:8114`
and `CONNECT_CKB_SCRIPTS_FILE=<json with the devnet's scripts>`.

The SDK and an example app are in `packages/` (see its README).
