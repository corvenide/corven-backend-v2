import {
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    Post,
    Req,
    Res,
    UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { ApiGatewayService } from './api-gateway.service';
import {
    assertTrustedOrigin,
    clearRefreshCookie,
    RateLimiter,
    readRefreshCookie,
    sessionMeta,
} from './auth-session';
import { bearerToken, getUserFromAuthorizationHeader, startSession } from './auth-helpers';
import {
    GoogleLoginDto,
    LoginDto,
    RegisterDto,
    WalletChallengeDto,
    WalletLoginDto,
} from './dto/auth.dto';

@Controller('auth')
export class AuthController {
    constructor(private readonly gatewayService: ApiGatewayService) { }

    private readonly authLimiter = new RateLimiter(20, 60_000);
    private readonly guestLimiter = new RateLimiter(
        Number(process.env.GUEST_SESSIONS_PER_IP_HOUR) || 60,
        60 * 60_000,
    );

    @Post('guest')
    @HttpCode(200)
    async guestStart(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ) {
        assertTrustedOrigin(req);
        this.guestLimiter.consume(`guest:${req.ip}`);

        const session = await this.gatewayService.guestStart({ meta: sessionMeta(req) });
        return startSession(res, session);
    }

    @Post('wallet/challenge')
    createWalletChallenge(
        @Req() req: Request,
        @Body() body: WalletChallengeDto,
    ) {
        this.authLimiter.consume(`challenge:${req.ip}`);
        return this.gatewayService.createWalletChallenge({
            walletAddress: body?.walletAddress,
        });
    }

    @Post('wallet/login')
    async walletLogin(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
        @Headers('authorization') authorization: string | undefined,
        @Body() body: WalletLoginDto,
    ) {
        this.authLimiter.consume(`login:${req.ip}`);

        const session = await this.gatewayService.walletLogin({
            walletAddress: body?.walletAddress,
            challengeId: body?.challengeId,
            signature: body?.signature,
            meta: sessionMeta(req),
            guestToken: bearerToken(authorization),
        });

        return startSession(res, session);
    }

    @Post('google')
    async googleLogin(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
        @Headers('authorization') authorization: string | undefined,
        @Body() body: GoogleLoginDto,
    ) {
        assertTrustedOrigin(req);
        this.authLimiter.consume(`login:${req.ip}`);

        const session = await this.gatewayService.googleLogin({
            credential: typeof body?.credential === 'string' ? body.credential : '',
            meta: sessionMeta(req),
            guestToken: bearerToken(authorization),
        });

        return startSession(res, session);
    }

    @Post('register')
    async register(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
        @Body() body: RegisterDto,
    ) {
        this.authLimiter.consume(`login:${req.ip}`);

        const session = await this.gatewayService.register({
            name: body?.name,
            email: body?.email,
            password: body?.password,
            meta: sessionMeta(req),
        });

        return startSession(res, session);
    }

    @Post('login')
    async login(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
        @Body() body: LoginDto,
    ) {
        this.authLimiter.consume(`login:${req.ip}`);

        const session = await this.gatewayService.login({
            email: body?.email,
            password: body?.password,
            meta: sessionMeta(req),
        });

        return startSession(res, session);
    }

    @Post('refresh')
    @HttpCode(200)
    async refresh(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ) {
        assertTrustedOrigin(req);
        this.authLimiter.consume(`refresh:${req.ip}`);

        const refreshToken = readRefreshCookie(req);
        if (!refreshToken) {
            throw new UnauthorizedException('No session');
        }

        try {
            const session = await this.gatewayService.refreshSession({
                refreshToken,
                meta: sessionMeta(req),
            });
            return startSession(res, session);
        } catch (error) {
            if (error instanceof UnauthorizedException) {
                clearRefreshCookie(res);
            }
            throw error;
        }
    }

    @Post('logout')
    @HttpCode(200)
    async logout(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ) {
        assertTrustedOrigin(req);
        const refreshToken = readRefreshCookie(req);
        clearRefreshCookie(res);

        if (refreshToken) {
            await this.gatewayService.logout({ refreshToken }).catch(() => undefined);
        }

        return { success: true };
    }

    @Post('logout-all')
    @HttpCode(200)
    async logoutAll(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
        @Headers('authorization') authorization?: string,
    ) {
        assertTrustedOrigin(req);
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        clearRefreshCookie(res);
        return this.gatewayService.logoutAll(user.id);
    }

    @Post('verify')
    verify(@Body() body: { token: string }) {
        return this.gatewayService.verifyToken(body?.token);
    }

    @Get('me')
    me(@Headers('authorization') authorization?: string) {
        return getUserFromAuthorizationHeader(this.gatewayService, authorization);
    }
}
