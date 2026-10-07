// apps/connect-service/src/http/app-registry.service.ts
//
// The apps allowed to use Corven Connect, cached for a short while so CORS
// checks and every request don't each hit the database.

import { Injectable } from '@nestjs/common';

import { PrismaService } from '@app/prisma';

export const LOGIN_METHODS = ['PHONE', 'EMAIL', 'GOOGLE', 'PASSKEY'] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];

export interface ConnectAppInfo {
    id: string;
    name: string;
    allowedOrigins: string[];
    googleClientId: string | null;
    loginMethods: LoginMethod[];
    mainnetEnabled: boolean;
    logoUrl: string | null;
}

const CACHE_MS = 30_000;

@Injectable()
export class AppRegistry {
    private apps = new Map<string, ConnectAppInfo>();
    private origins = new Set<string>();
    private loadedAt = 0;
    private loading: Promise<void> | null = null;

    constructor(private readonly prisma: PrismaService) { }

    async get(appId: string): Promise<ConnectAppInfo | null> {
        await this.refresh();
        return this.apps.get(appId) ?? null;
    }

    /** True when any app lists this origin (used to answer CORS preflights). */
    async isKnownOrigin(origin: string): Promise<boolean> {
        await this.refresh();
        return this.origins.has(origin);
    }

    /** Drop the cache, e.g. after an admin edits an app. */
    invalidate(): void {
        this.loadedAt = 0;
    }

    private async refresh(): Promise<void> {
        if (Date.now() - this.loadedAt < CACHE_MS) return;
        this.loading ??= this.load().finally(() => (this.loading = null));
        await this.loading;
    }

    private async load(): Promise<void> {
        const rows = await this.prisma.connectApp.findMany();
        const apps = new Map<string, ConnectAppInfo>();
        const origins = new Set<string>();

        for (const row of rows) {
            apps.set(row.id, {
                id: row.id,
                name: row.name,
                allowedOrigins: row.allowedOrigins,
                googleClientId: row.googleClientId,
                loginMethods: row.loginMethods.filter((m): m is LoginMethod => (LOGIN_METHODS as readonly string[]).includes(m)),
                mainnetEnabled: row.mainnetEnabled,
                logoUrl: row.logoUrl,
            });
            row.allowedOrigins.forEach((o) => origins.add(o));
        }

        this.apps = apps;
        this.origins = origins;
        this.loadedAt = Date.now();
    }
}

/** Normalizes an origin an admin typed: scheme + host (+ port), no path. */
export function normalizeOrigin(value: string): string | null {
    try {
        const url = new URL(value.trim());
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) return null;
        return url.origin;
    } catch {
        return null;
    }
}
