import { Module } from '@nestjs/common';
import { CellServiceController } from './cell-service.controller';
import { CellServiceService } from './cell-service.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { PrismaService } from 'libs/prisma/src/prisma.service';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            envFilePath: '.env',
        }),

        ClientsModule.registerAsync([
            {
                name: 'CELL_SERVICE',
                imports: [ConfigModule],
                inject: [ConfigService],
                useFactory: (config: ConfigService) => ({
                    transport: Transport.TCP,
                    options: {
                        host: config.get<string>('CELL_SERVICE_HOST') || '127.0.0.1',
                        port: config.get<number>('CELL_SERVICE_PORT') || 8006,
                    },
                })
            }
        ])

    ],
    controllers: [CellServiceController],
    providers: [CellServiceService, PrismaService],
})
export class CellServiceModule { }
