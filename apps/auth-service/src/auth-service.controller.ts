// apps/auth-service/src/auth-service.controller.ts

import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { AuthService, type SessionMeta } from './auth-service.service';

@Controller()
export class AuthServiceController {
    constructor(private readonly authService: AuthService) { }

    @MessagePattern({ cmd: 'auth.wallet.challenge' })
    createWalletChallenge(@Payload() data: { walletAddress: string }) {
        return this.authService.createWalletChallenge(data);
    }

    @MessagePattern({ cmd: 'auth.wallet.login' })
    walletLogin(
        @Payload()
        data: {
            walletAddress: string;
            challengeId: string;
            signature: unknown;
            meta?: SessionMeta;
        },
    ) {
        return this.authService.walletLogin(data);
    }

    @MessagePattern({ cmd: 'auth.register' })
    register(
        @Payload()
        data: { name: string; email: string; password: string; meta?: SessionMeta },
    ) {
        return this.authService.register(data);
    }

    @MessagePattern({ cmd: 'auth.login' })
    login(@Payload() data: { email: string; password: string; meta?: SessionMeta }) {
        return this.authService.login(data);
    }

    @MessagePattern({ cmd: 'auth.refresh' })
    refresh(@Payload() data: { refreshToken: string; meta?: SessionMeta }) {
        return this.authService.refresh(data);
    }

    @MessagePattern({ cmd: 'auth.logout' })
    logout(@Payload() data: { refreshToken?: string }) {
        return this.authService.logout(data);
    }

    @MessagePattern({ cmd: 'auth.logout-all' })
    logoutAll(@Payload() data: { userId: string }) {
        return this.authService.logoutAll(data);
    }

    @MessagePattern({ cmd: 'auth.verify' })
    verify(@Payload() data: { token: string }) {
        return this.authService.verifyToken(data.token);
    }

    @MessagePattern({ cmd: 'auth.profile' })
    profile(@Payload() data: { userId: string }) {
        return this.authService.getProfile(data.userId);
    }
}
