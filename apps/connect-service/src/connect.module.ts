// apps/connect-service/src/connect.module.ts

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { PrismaService } from '@app/prisma';

import { AdminController, AdminGuard } from './admin/admin.controller';
import { AccountsService } from './auth/accounts.service';
import { OTP_PROVIDER, otpProviderFromEnv } from './auth/otp';
import { TokensService } from './auth/tokens.service';
import { UserGuard } from './auth/user.guard';
import { connectJwtSecret } from './config';
import { ConnectController, HealthController } from './connect.controller';
import { AppGuard } from './http/app.guard';
import { AppRegistry } from './http/app-registry.service';
import { WalletsService } from './wallets/wallets.service';

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
        JwtModule.registerAsync({
            useFactory: () => ({ secret: connectJwtSecret(), signOptions: { issuer: 'corven-connect' }, verifyOptions: { issuer: 'corven-connect' } }),
        }),
    ],
    controllers: [HealthController, ConnectController, AdminController],
    providers: [
        PrismaService,
        AppRegistry,
        AppGuard,
        UserGuard,
        AdminGuard,
        TokensService,
        WalletsService,
        AccountsService,
        { provide: OTP_PROVIDER, useFactory: () => otpProviderFromEnv() },
    ],
})
export class ConnectModule { }
