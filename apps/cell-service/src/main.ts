// apps/cell-service/src/main.ts
import { NestFactory } from '@nestjs/core';
import { CellServiceModule } from './cell-service.module';

async function bootstrap() {
  const app = await NestFactory.create(CellServiceModule);

  // 8006 keeps it clear of the frontend dev server on 3000.
  const port = Number(process.env.CELL_SERVICE_PORT) || 8006;

  await app.listen(port);

  console.log(`Cell service running on 127.0.0.1:${port}`);
}

bootstrap();
