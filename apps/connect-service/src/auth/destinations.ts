// apps/connect-service/src/auth/destinations.ts
//
// Phone numbers and emails as typed in the modal, normalized so the same
// person always maps to the same identity.

import { defaultCountryCode } from '../config';
import { fail } from '../http/errors';

/**
 * "+254 712 345 678", "0712345678" (with the default country 254) and
 * "254712345678" all become "+254712345678" (E.164).
 */
export function normalizePhone(value: unknown, countryCode = defaultCountryCode()): string {
    const raw = String(value ?? '').trim();
    if (!raw) throw fail(400, 'Enter your phone number.', 'invalid_phone');

    let digits = raw.replace(/[\s().-]/g, '');
    if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;

    if (!digits.startsWith('+')) {
        if (!/^\d+$/.test(digits)) throw fail(400, 'That phone number has characters it shouldn\'t.', 'invalid_phone');
        digits = digits.startsWith('0') ? `+${countryCode}${digits.slice(1)}` : digits.startsWith(countryCode) ? `+${digits}` : `+${countryCode}${digits}`;
    }

    if (!/^\+[1-9]\d{7,14}$/.test(digits)) {
        throw fail(400, 'That doesn\'t look like a full phone number. Include the country code, e.g. +254 712 345 678.', 'invalid_phone');
    }
    return digits;
}

export function normalizeEmail(value: unknown): string {
    const email = String(value ?? '').trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        throw fail(400, 'Enter a valid email address.', 'invalid_email');
    }
    return email;
}

/** "+254712345678" → "+254 712 ••• 678". */
export function maskPhone(phone: string): string {
    if (phone.length < 8) return phone;
    const cc = phone.startsWith('+254') ? '+254' : phone.slice(0, phone.length - 9);
    const rest = phone.slice(cc.length);
    return `${cc} ${rest.slice(0, 3)} ••• ${rest.slice(-3)}`;
}

export function maskEmail(email: string): string {
    const [name, domain] = email.split('@');
    return `${name.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(6, name.length - 2)))}@${domain}`;
}
