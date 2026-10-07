// apps/connect-service/src/main.ts
//
// Corven Connect API: sign-in (phone, email, Google, passkeys) and embedded
// CKB wallets for other apps. Its own HTTP service, separate from the IDE's
// api-gateway; Caddy sends https://<API_DOMAIN>/connect/* here.

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { ConnectModule } from './connect.module';
import { connectCors } from './http/cors';
import { AppRegistry } from './http/app-registry.service';

async function bootstrap() {
    const app = await NestFactory.create<NestExpressApplication>(ConnectModule);

    // Behind Caddy: req.ip is the client's address (rate limits use it).
    app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
    app.use(connectCors(app.get(AppRegistry)));
    app.useBodyParser('json', { limit: '1mb' });
    app.setGlobalPrefix('connect');

    const port = Number(process.env.CONNECT_SERVICE_PORT || 8007);
    const host = process.env.CONNECT_SERVICE_HOST || '127.0.0.1';
    await app.listen(port, host);
    console.log(`Corven Connect listening on ${host}:${port}`);
}

bootstrap();
