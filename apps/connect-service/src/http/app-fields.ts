// apps/connect-service/src/http/app-fields.ts
//
// Validates the editable settings of a Connect app (shared by the admin API
// and the dashboard).

import { randomBytes } from 'node:crypto';

import { LOGIN_METHODS, normalizeOrigin } from './app-registry.service';
import { fail } from './errors';

export function newAppId(): string {
    return `app_${randomBytes(12).toString('base64url').replace(/[-_]/g, 'x')}`;
}

export function appFields(body: any, partial: boolean): Record<string, unknown> {
    const data: Record<string, unknown> = {};

    if (body?.name !== undefined || !partial) {
        const name = String(body?.name ?? '').trim();
        if (!name || name.length > 60) throw fail(400, 'Name is required (max 60 characters).');
        data.name = name;
    }
    if (body?.allowedOrigins !== undefined || !partial) {
        const list = Array.isArray(body?.allowedOrigins) ? body.allowedOrigins : [];
        const origins = list.map((o: unknown) => normalizeOrigin(String(o)));
        if (origins.length === 0 || origins.some((o: string | null) => !o)) {
            throw fail(400, 'Allowed origins must be like https://myapp.xyz (http only for localhost).');
        }
        if (origins.length > 20) throw fail(400, 'At most 20 allowed origins.');
        data.allowedOrigins = [...new Set(origins)];
    }
    if (body?.loginMethods !== undefined) {
        const methods = Array.isArray(body.loginMethods) ? body.loginMethods.map((m: unknown) => String(m).toUpperCase()) : [];
        if (methods.length === 0 || methods.some((m: string) => !(LOGIN_METHODS as readonly string[]).includes(m))) {
            throw fail(400, `Login methods must be some of ${LOGIN_METHODS.join(', ')}.`);
        }
        data.loginMethods = [...new Set(methods)];
    }
    if (body?.googleClientId !== undefined) {
        const id = body.googleClientId ? String(body.googleClientId).trim() : '';
        if (id && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw fail(400, 'That doesn\'t look like a Google OAuth client id.');
        data.googleClientId = id || null;
    }
    if (body?.logoUrl !== undefined) {
        const url = body.logoUrl ? String(body.logoUrl).trim() : '';
        if (url && !/^https:\/\/\S+$/.test(url)) throw fail(400, 'Logo must be an https:// URL.');
        data.logoUrl = url || null;
    }
    if (body?.mainnetEnabled !== undefined) data.mainnetEnabled = body.mainnetEnabled === true;
    return data;
}
