// apps/api-gateway/src/main.ts

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { ApiGatewayModule } from './api-gateway.module';
import { allowedOrigins } from './auth-session';

async function bootstrap() {
    const app = await NestFactory.create<NestExpressApplication>(ApiGatewayModule);

    // Behind a reverse proxy (nginx / load balancer) so req.ip is the
    // client's address, which the auth rate limiter depends on.
    app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));

    // Credentials (the refresh cookie) require an explicit origin list;
    // browsers reject `*` together with credentials.
    const origins = allowedOrigins();

    app.enableCors({
        origin: (origin, callback) => {
            if (!origin || origins.includes(origin)) {
                callback(null, true);
            } else {
                callback(null, false);
            }
        },
        credentials: true,
    });

    // Devnet RPC relays can carry a transaction with a contract binary.
    app.useBodyParser('json', { limit: '2mb' });

    app.setGlobalPrefix('api');

    const port = process.env.API_GATEWAY_PORT || 8000;

    await app.listen(port);

    console.log(
        `API gateway listening on ${process.env.API_GATEWAY_HOST || '127.0.0.1'}:${port} (CORS: ${origins.join(', ')})`,
    );
}

bootstrap();
