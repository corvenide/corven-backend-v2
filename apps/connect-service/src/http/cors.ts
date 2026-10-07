// apps/connect-service/src/http/cors.ts
//
// CORS for Connect is per app: a page may call the API only if some app
// lists its origin. Corven IDE's own origins (CORS_ORIGINS) are allowed too,
// for the Connect dashboard that lives in the IDE. Requests carry no cookies (the SDK sends a bearer
// token), so credentials stay off. The app guard then checks that the
// origin belongs to the app named in the request.

import type { NextFunction, Request, Response } from 'express';

import type { AppRegistry } from './app-registry.service';

export const APP_HEADER = 'x-corven-app';

export function connectCors(registry: AppRegistry) {
    return (req: Request, res: Response, next: NextFunction) => {
        const origin = req.headers.origin;
        if (!origin) return next();

        res.setHeader('Vary', 'Origin');

        const ideOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);

        registry
            .isKnownOrigin(origin)
            .then((known) => known || ideOrigins.includes(origin))
            .then((known) => {
                if (known) {
                    res.setHeader('Access-Control-Allow-Origin', origin);
                    res.setHeader('Access-Control-Allow-Headers', `authorization, content-type, ${APP_HEADER}`);
                    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
                    res.setHeader('Access-Control-Max-Age', '600');
                }
                if (req.method === 'OPTIONS') return void res.status(204).end();
                next();
            })
            .catch(next);
    };
}
