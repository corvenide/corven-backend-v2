// apps/auth-service/src/google-verification.ts
//
// Verifies the ID token ("credential") that Google Identity Services hands
// the browser after a user picks their Google account.
//
// google-auth-library checks the signature against Google's published keys,
// the issuer, the expiry, and that the token was issued for one of our
// OAuth client IDs (the audience). A token minted for any other app is
// rejected, so another site's Google login can't be replayed here.

import { OAuth2Client } from 'google-auth-library';

export interface GoogleIdentity {
    /** Stable Google account id. Emails can change; this can't. */
    sub: string;
    email: string;
    emailVerified: boolean;
    name: string | null;
    /** When Google issued the token (seconds since epoch). */
    issuedAt: number;
}

export type GoogleVerificationFailure = 'not_configured' | 'invalid_token' | 'email_not_verified';

export class GoogleVerificationError extends Error {
    constructor(readonly reason: GoogleVerificationFailure) {
        super(reason);
    }
}

/** GOOGLE_CLIENT_ID, comma-separated when several clients (web, dev) are allowed. */
export function googleClientIds(): string[] {
    return (process.env.GOOGLE_CLIENT_ID ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
}

const client = new OAuth2Client();

/** Verifies a Google ID token. Throws GoogleVerificationError. */
export async function verifyGoogleCredential(
    credential: string,
    audience: string[] = googleClientIds(),
    verifier: Pick<OAuth2Client, 'verifyIdToken'> = client,
): Promise<GoogleIdentity> {
    if (audience.length === 0) {
        throw new GoogleVerificationError('not_configured');
    }

    if (typeof credential !== 'string' || credential.length < 20 || credential.length > 8192) {
        throw new GoogleVerificationError('invalid_token');
    }

    let payload: Record<string, unknown> | undefined;

    try {
        const ticket = await verifier.verifyIdToken({ idToken: credential, audience });
        payload = ticket.getPayload() as Record<string, unknown> | undefined;
    } catch {
        throw new GoogleVerificationError('invalid_token');
    }

    const sub = typeof payload?.sub === 'string' ? payload.sub : '';
    const email = typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : '';

    if (!sub || !email) {
        throw new GoogleVerificationError('invalid_token');
    }

    // Accounts are matched by email, so only accept emails Google has verified.
    if (payload?.email_verified !== true) {
        throw new GoogleVerificationError('email_not_verified');
    }

    const name = typeof payload?.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 80) : null;

    const issuedAt = typeof payload?.iat === 'number' ? payload.iat : 0;

    return { sub, email, emailVerified: true, name, issuedAt };
}
