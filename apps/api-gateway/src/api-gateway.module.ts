// apps/api-gateway/src/api-gateway.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ApiGatewayController } from './api-gateway.controller';
import { ApiGatewayService } from './api-gateway.service';
import { AiController } from './ai/ai.controller';
import { AiService } from './ai/ai.service';

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
    controllers: [ApiGatewayController, AiController],
    providers: [ApiGatewayService, AiService],
})
export class ApiGatewayModule { }
