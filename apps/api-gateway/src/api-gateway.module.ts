// apps/api-gateway/src/api-gateway.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ApiGatewayController } from './api-gateway.controller';
import { ApiGatewayService } from './api-gateway.service';
import { AuthController } from './auth.controller';
import { WalletController } from './wallet.controller';
import { WorkspaceController } from './workspace.controller';
import { CommunityController } from './community.controller';
import { AiController } from './ai/ai.controller';
import { AiService } from './ai/ai.service';
import { MetricsService } from 'libs/logger/src/metrics.service';
import { StructuredLogger } from 'libs/logger/src/structured-logger.service';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            envFilePath: '.env',
        }),

        ClientsModule.registerAsync([
            {
                name: 'AUTH_SERVICE',
                imports: [ConfigModule],
                inject: [ConfigService],
                useFactory: (config: ConfigService) => ({
                    transport: Transport.TCP,
                    options: {
                        host: config.get<string>('AUTH_SERVICE_HOST') || '127.0.0.1',
                        port: Number(config.get<string>('AUTH_SERVICE_PORT')) || 8001,
                    },
                }),
            },
            {
                name: 'WORKSPACE_SERVICE',
                imports: [ConfigModule],
                inject: [ConfigService],
                useFactory: (config: ConfigService) => ({
                    transport: Transport.TCP,
                    options: {
                        host: config.get<string>('WORKSPACE_SERVICE_HOST') || '127.0.0.1',
                        port: Number(config.get<string>('WORKSPACE_SERVICE_PORT')) || 8002,
                    }
                })
            },
            {
                name: 'RUNTIME_SERVICE',
                imports: [ConfigModule],
                inject: [ConfigService],
                useFactory: (config: ConfigService) => ({
                    transport: Transport.TCP,
                    options: {
                        host: config.get<string>('RUNTIME_SERVICE_HOST') || '127.0.0.1',
                        port: Number(config.get<string>('RUNTIME_SERVICE_PORT')) || 8004,
                    },
                }),
            },
            {
                name: 'FILE_SERVICE',
                imports: [ConfigModule],
                inject: [ConfigService],

                useFactory: (config: ConfigService) => ({
                    transport: Transport.TCP,

                    options: {
                        host:
                            config.get<string>(
                                'FILE_SERVICE_HOST',
                            ) || '127.0.0.1',

                        port:
                            Number(
                                config.get<string>(
                                    'FILE_SERVICE_PORT',
                                ),
                            ) || 8005,
                    },
                }),
            }
        ]),
    ],
    controllers: [
        ApiGatewayController,
        AuthController,
        WalletController,
        WorkspaceController,
        CommunityController,
        AiController,
    ],
    providers: [ApiGatewayService, AiService, MetricsService, StructuredLogger],
})
export class ApiGatewayModule { }
