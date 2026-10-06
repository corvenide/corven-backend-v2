// apps/auth-service/src/google-verification.spec.ts
//
// Runs real ID-token verification (google-auth-library) against tokens
// signed with a local key that stands in for Google's published certs.

import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

import { googleClientIds, verifyGoogleCredential } from './google-verification';

const CLIENT_ID = '1234-corven.apps.googleusercontent.com';
const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });

function idToken(claims: Record<string, unknown> = {}, key: KeyObject = google.privateKey): string {
    const now = Math.floor(Date.now() / 1000);
    const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = encode({ alg: 'RS256', kid: 'test-key', typ: 'JWT' });
    const body = encode({
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        sub: '1100223344',
        email: 'Ada@Example.com',
        email_verified: true,
        name: 'Ada Lovelace',
        iat: now,
        exp: now + 3600,
        ...claims,
    });
    const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url');
    return `${head}.${body}.${signature}`;
}

const library = new OAuth2Client();
const verifier = {
    verifyIdToken: ({ idToken: token, audience }: { idToken: string; audience: string[] }) =>
        library.verifySignedJwtWithCertsAsync(
            token,
            { 'test-key': google.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
            audience,
            ['accounts.google.com', 'https://accounts.google.com'],
        ),
} as unknown as OAuth2Client;

const reasonOf = (token: string, audience = [CLIENT_ID]) =>
    verifyGoogleCredential(token, audience, verifier).then(
        () => 'ok',
        (error: { reason?: string }) => error.reason,
    );

describe('verifyGoogleCredential', () => {
    it('accepts a valid token and normalises the email', async () => {
        await expect(verifyGoogleCredential(idToken(), [CLIENT_ID], verifier)).resolves.toEqual({
            sub: '1100223344',
            email: 'ada@example.com',
            emailVerified: true,
            name: 'Ada Lovelace',
            issuedAt: expect.any(Number),
        });
    });

    it('rejects a token issued for another app', async () => {
        await expect(reasonOf(idToken({ aud: 'other-app.apps.googleusercontent.com' }))).resolves.toBe('invalid_token');
    });

    it('rejects expired, forged and wrong-issuer tokens', async () => {
        await expect(reasonOf(idToken({ iat: 1_700_000_000, exp: 1_700_003_600 }))).resolves.toBe('invalid_token');
        await expect(reasonOf(idToken({}, attacker.privateKey))).resolves.toBe('invalid_token');
        await expect(reasonOf(idToken({ iss: 'https://evil.example' }))).resolves.toBe('invalid_token');
        await expect(reasonOf('not-a-jwt-at-all-xxxxxxxx')).resolves.toBe('invalid_token');
    });

    it('rejects unverified emails', async () => {
        await expect(reasonOf(idToken({ email_verified: false }))).resolves.toBe('email_not_verified');
    });

    it('reports a missing client id', async () => {
        await expect(reasonOf(idToken(), [])).resolves.toBe('not_configured');
    });

    it('reads comma-separated client ids', () => {
        process.env.GOOGLE_CLIENT_ID = ` ${CLIENT_ID} , dev-client `;
        expect(googleClientIds()).toEqual([CLIENT_ID, 'dev-client']);
    });
});
