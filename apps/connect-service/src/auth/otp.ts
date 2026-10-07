// apps/connect-service/src/auth/otp.ts
//
// One-time codes for phone (SMS, WhatsApp, voice call) and email.
//
// twilio   Twilio Verify generates, sends and checks the codes
//          (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID).
//          Email codes need an email integration on the Verify service
//          (Twilio console > Verify > Services > Email).
// console  Development only: codes are generated here and printed to the
//          service log. Refused in production unless
//          CONNECT_ALLOW_CONSOLE_OTP=1.

import { Logger } from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import { fail } from '../http/errors';

export type OtpChannel = 'sms' | 'whatsapp' | 'call' | 'email';

export interface OtpProvider {
    readonly name: string;
    send(to: string, channel: OtpChannel): Promise<void>;
    /** True when the code is right. Throws only for provider failures. */
    check(to: string, code: string): Promise<boolean>;
}

export class TwilioVerifyProvider implements OtpProvider {
    readonly name = 'twilio';
    private readonly logger = new Logger('TwilioVerify');

    constructor(
        private readonly accountSid: string,
        private readonly authToken: string,
        private readonly serviceSid: string,
        private readonly fetchImpl: typeof fetch = fetch,
    ) { }

    async send(to: string, channel: OtpChannel): Promise<void> {
        const res = await this.post('Verifications', { To: to, Channel: channel });
        if (res.ok) return;

        const body = await res.json().catch(() => ({}));
        this.logger.warn(`Verify send failed (${res.status}): ${body?.code} ${body?.message}`);
        // https://www.twilio.com/docs/api/errors
        if (body?.code === 60200 || body?.code === 21211) throw fail(400, 'That number or email can\'t receive codes.', 'invalid_destination');
        if (body?.code === 60203 || res.status === 429) throw fail(429, 'Too many codes sent. Wait a few minutes and try again.', 'rate_limited');
        if (body?.code === 60205) throw fail(400, 'That number can\'t receive SMS. Try a call instead.', 'channel_unavailable');
        if (body?.code === 60410 || body?.code === 60605) throw fail(400, 'Codes can\'t be sent to that country yet.', 'country_blocked');
        throw fail(502, 'We couldn\'t send the code. Try again in a moment.', 'otp_send_failed');
    }

    async check(to: string, code: string): Promise<boolean> {
        const res = await this.post('VerificationCheck', { To: to, Code: code });
        // 404: no pending verification (expired, already approved or too many tries).
        if (res.status === 404) return false;
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            this.logger.warn(`Verify check failed (${res.status}): ${body?.code} ${body?.message}`);
            if (res.status === 429 || body?.code === 60202) throw fail(429, 'Too many wrong codes. Request a new one.', 'rate_limited');
            throw fail(502, 'We couldn\'t check the code. Try again.', 'otp_check_failed');
        }
        const body = await res.json();
        return body?.status === 'approved';
    }

    private post(path: string, form: Record<string, string>) {
        return this.fetchImpl(`https://verify.twilio.com/v2/Services/${this.serviceSid}/${path}`, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams(form).toString(),
        });
    }
}

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_TRIES = 5;

export class ConsoleOtpProvider implements OtpProvider {
    readonly name = 'console';
    private readonly logger = new Logger('ConnectOtp');
    private readonly codes = new Map<string, { hash: Buffer; expiresAt: number; tries: number }>();

    /** The last code sent to each destination, for tests. */
    readonly lastCode = new Map<string, string>();

    async send(to: string, channel: OtpChannel): Promise<void> {
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        this.codes.set(to, { hash: digest(code), expiresAt: Date.now() + CODE_TTL_MS, tries: 0 });
        this.lastCode.set(to, code);
        this.logger.log(`[dev] ${channel} code for ${to}: ${code}`);
    }

    async check(to: string, code: string): Promise<boolean> {
        const entry = this.codes.get(to);
        if (!entry || entry.expiresAt < Date.now()) return false;
        entry.tries += 1;
        if (entry.tries > MAX_TRIES) {
            this.codes.delete(to);
            return false;
        }
        const ok = timingSafeEqual(entry.hash, digest(code));
        if (ok) this.codes.delete(to);
        return ok;
    }
}

const digest = (code: string) => createHash('sha256').update(code).digest();

export function otpProviderFromEnv(env = process.env): OtpProvider {
    const kind = (env.CONNECT_OTP_PROVIDER ?? (env.TWILIO_VERIFY_SERVICE_SID ? 'twilio' : 'console')).toLowerCase();

    if (kind === 'twilio') {
        const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_VERIFY_SERVICE_SID: service } = env;
        if (!sid || !token || !service) {
            throw new Error('CONNECT_OTP_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID');
        }
        return new TwilioVerifyProvider(sid, token, service);
    }

    if (kind === 'console') {
        if (env.NODE_ENV === 'production' && env.CONNECT_ALLOW_CONSOLE_OTP !== '1') {
            throw new Error('Set up Twilio Verify for Corven Connect codes (CONNECT_OTP_PROVIDER=twilio). The console provider is for development only.');
        }
        return new ConsoleOtpProvider();
    }

    throw new Error(`Unknown CONNECT_OTP_PROVIDER "${kind}" (use twilio or console)`);
}

export const OTP_PROVIDER = Symbol('OTP_PROVIDER');
