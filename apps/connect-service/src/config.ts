// apps/connect-service/src/config.ts
//
// Settings for Corven Connect. Everything Connect needs has its own
// CONNECT_* variable so it never shares secrets with the Corven IDE.
//
//   CONNECT_SERVICE_PORT            HTTP port (default 8007)
//   CONNECT_JWT_SECRET              signs Connect access tokens; 32+ chars and
//                                   different from JWT_SECRET
//   CONNECT_WALLET_ENCRYPTION_KEY   32 bytes (base64 or hex) wrapping wallet keys
//   CONNECT_ADMIN_TOKEN             bearer token for /connect/v1/admin/*
//   CONNECT_OTP_PROVIDER            twilio | console (console logs codes; dev only)
//   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_VERIFY_SERVICE_SID
//   CONNECT_DEFAULT_COUNTRY_CODE    for numbers typed without +, default 254
//   CONNECT_MAINNET_DAILY_LIMIT_CKB default 1000; 0 turns mainnet signing off
//   CONNECT_CKB_TESTNET_RPC_URL / CONNECT_CKB_MAINNET_RPC_URL  optional

export const ACCESS_TOKEN_TTL_S = 15 * 60;
export const REFRESH_TOKEN_TTL_DAYS = 30;
/** Step-up tokens (mainnet signing, key export) live this long. */
export const STEP_UP_TTL_S = 5 * 60;
export const CHALLENGE_TTL_S = 5 * 60;

export function connectJwtSecret(env = process.env): string {
    const secret = env.CONNECT_JWT_SECRET ?? '';
    if (secret.length < 32) {
        throw new Error('CONNECT_JWT_SECRET must be set to a random string of at least 32 characters');
    }
    if (env.JWT_SECRET && secret === env.JWT_SECRET) {
        throw new Error('CONNECT_JWT_SECRET must be different from the IDE JWT_SECRET');
    }
    return secret;
}

export function defaultCountryCode(env = process.env): string {
    const code = (env.CONNECT_DEFAULT_COUNTRY_CODE ?? '254').replace(/\D/g, '');
    return code || '254';
}

export function mainnetDailyLimitCkb(env = process.env): bigint {
    const raw = env.CONNECT_MAINNET_DAILY_LIMIT_CKB;
    const value = raw === undefined || raw.trim() === '' ? 1000 : Number(raw);
    return Number.isFinite(value) && value > 0 ? BigInt(Math.floor(value)) : 0n;
}
