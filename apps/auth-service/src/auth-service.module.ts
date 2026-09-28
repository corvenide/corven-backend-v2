// apps/auth-service/src/auth-service.module.ts

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { PrismaService } from 'libs/prisma/src/prisma.service';

import { AuthServiceController } from './auth-service.controller';
import { AuthService } from './auth-service.service';
import { CommunityAdmins } from './community/community-admins';
import { CommunityController } from './community/community.controller';
import { CommunityService } from './community/community.service';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            envFilePath: '.env',
        }),
        JwtModule.registerAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => {
                const secret = config.get<string>('JWT_SECRET');

                // Refuse to start with a missing or guessable secret instead of
                // silently signing tokens with a hard-coded default.
                if (!secret || secret.length < 32) {
                    throw new Error(
                        'JWT_SECRET must be set to a random string of at least 32 characters',
                    );
                }

                return {
                    secret,
                    signOptions: {
                        // Short-lived: the refresh token keeps the session alive.
                        expiresIn: (config.get<string>('JWT_ACCESS_EXPIRES_IN') ||
                            '15m') as never,
                    },
                };
            },
        }),
    ],
    controllers: [AuthServiceController, CommunityController],
    providers: [
        AuthService,
        PrismaService,
        CommunityService,
        // Reads COMMUNITY_ADMIN_WALLETS.
        { provide: CommunityAdmins, useFactory: () => new CommunityAdmins() },
    ],
})
export class AuthServiceModule { }
