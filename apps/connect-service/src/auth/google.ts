// apps/connect-service/src/auth/google.ts
//
// Verifies a Google ID token from Google Identity Services on the app's
// page. The audience is the app's own Google client id (its authorized
// JavaScript origins must include the app's pages), falling back to
// CONNECT_GOOGLE_CLIENT_ID.

import { OAuth2Client } from 'google-auth-library';

import { fail } from '../http/errors';

export interface GoogleProfile {
    sub: string;
    email: string;
    name: string | null;
    issuedAt: number;
}

const client = new OAuth2Client();

export function googleClientIdFor(appClientId: string | null, env = process.env): string | null {
    return appClientId || env.CONNECT_GOOGLE_CLIENT_ID?.trim() || null;
}

export async function verifyGoogleIdToken(
    credential: unknown,
    audience: string | null,
    verifier: Pick<OAuth2Client, 'verifyIdToken'> = client,
): Promise<GoogleProfile> {
    if (!audience) throw fail(503, 'Google sign-in isn\'t set up for this app.', 'google_not_configured');
    if (typeof credential !== 'string' || credential.length < 20 || credential.length > 8192) {
        throw fail(400, 'Google sign-in failed. Try again.', 'invalid_google_token');
    }

    let payload: Record<string, unknown> | undefined;
    try {
        payload = (await verifier.verifyIdToken({ idToken: credential, audience })).getPayload() as Record<string, unknown> | undefined;
    } catch {
        throw fail(401, 'Google sign-in failed. Try again.', 'invalid_google_token');
    }

    const sub = typeof payload?.sub === 'string' ? payload.sub : '';
    const email = typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!sub || !email) throw fail(401, 'Google sign-in failed. Try again.', 'invalid_google_token');
    if (payload?.email_verified !== true) throw fail(401, 'Verify your Google email address first.', 'google_email_unverified');

    const name = typeof payload?.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 80) : null;
    return { sub, email, name, issuedAt: typeof payload?.iat === 'number' ? payload.iat : 0 };
}
