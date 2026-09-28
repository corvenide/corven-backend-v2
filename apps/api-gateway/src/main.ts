import { NestFactory } from '@nestjs/core';
import { ApiGatewayModule } from './api-gateway.module';

async function bootstrap() {
    const app = await NestFactory.create(ApiGatewayModule);

    // Browsers reject "Access-Control-Allow-Origin: *" on credentialed
    // requests, so list the frontend origins explicitly in production
    // (comma-separated). Unset reflects the request origin, for local dev.
    const corsOrigins = process.env.CORS_ORIGINS?.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

    app.enableCors({
        origin: corsOrigins?.length ? corsOrigins : true,
        credentials: true,
    })

    app.setGlobalPrefix('api');

    const port = process.env.API_GATEWAY_PORT || 8000;

    console.log(`🚀 API GATEWAY IS RUNNING ON ${process.env.API_GATEWAY_HOST || '127.0.0.1'}:${port}`);
    await app.listen(port);
}
bootstrap();
