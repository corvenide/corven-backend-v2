// apps/connect-service/src/http/app.guard.ts
//
// Every /v1 route (except admin) names its app in the x-corven-app header.
// The guard loads the app and, for browser requests, checks the page's
// origin is one of the app's allowed origins.

import { CanActivate, createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { AppRegistry, type ConnectAppInfo } from './app-registry.service';
import { APP_HEADER } from './cors';
import { fail } from './errors';

export interface ConnectRequestContext {
    app: ConnectAppInfo;
    /** The page's origin, when the request came from a browser. */
    origin: string | null;
    ip: string | undefined;
    userAgent: string | undefined;
}

@Injectable()
export class AppGuard implements CanActivate {
    constructor(private readonly registry: AppRegistry) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest<Request & { connect?: ConnectRequestContext }>();
        const appId = String(req.headers[APP_HEADER] ?? '').trim();
        if (!appId) throw fail(400, `Missing ${APP_HEADER} header.`, 'missing_app');

        const app = await this.registry.get(appId);
        if (!app) throw fail(404, 'Unknown Corven Connect app id.', 'unknown_app');

        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
        if (origin && !app.allowedOrigins.includes(origin)) {
            throw fail(403, `${origin} is not an allowed origin for this app. Add it in the app's settings.`, 'origin_not_allowed');
        }

        req.connect = {
            app,
            origin,
            ip: req.ip,
            userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 300) : undefined,
        };
        return true;
    }
}

export const Ctx = createParamDecorator((_: unknown, context: ExecutionContext): ConnectRequestContext => {
    return context.switchToHttp().getRequest().connect;
});
