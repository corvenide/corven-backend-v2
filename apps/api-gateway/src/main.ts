// apps/api-gateway/src/main.ts

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { ApiGatewayModule } from './api-gateway.module';
import { ApiGatewayService } from './api-gateway.service';
import { createPreviewProxy, PREVIEW_PATH } from './preview-proxy';
import { allowedOrigins } from './auth-session';

async function bootstrap() {
    const app = await NestFactory.create<NestExpressApplication>(ApiGatewayModule);

    // Dev-server previews are proxied before CORS and body parsing, so the
    // request body and the opaque-origin iframe pass through untouched.
    const preview = createPreviewProxy(app.get(ApiGatewayService));
    app.use(PREVIEW_PATH, (req: any, res: any, next: any) => void preview.handleHttp(req, res, next));

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

    app.getHttpServer().on('upgrade', (req: any, socket: any, head: Buffer) => {
        void preview.handleUpgrade(req, socket, head);
    });

    console.log(
        `API gateway listening on ${process.env.API_GATEWAY_HOST || '127.0.0.1'}:${port} (CORS: ${origins.join(', ')})`,
    );
}

bootstrap();
