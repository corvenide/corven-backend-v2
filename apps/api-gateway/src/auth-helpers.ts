import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { setRefreshCookie } from './auth-session';
import type { ApiGatewayService } from './api-gateway.service';

export function bearerToken(authorization?: string): string | undefined {
    const [scheme, token] = (authorization ?? '').trim().split(/\s+/);
    return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

export async function getUserFromAuthorizationHeader(
    gatewayService: ApiGatewayService,
    authorization?: string,
): Promise<any> {
    if (!authorization) {
        throw new UnauthorizedException('Missing authorization header');
    }

    const [scheme, token] = authorization.trim().split(/\s+/);

    if (scheme?.toLowerCase() !== 'bearer' || !token) {
        throw new UnauthorizedException('Invalid authorization header');
    }

    const result: any = await gatewayService.verifyToken(token);

    if (!result?.user) {
        throw new UnauthorizedException('Invalid authentication response');
    }

    return result.user;
}

export async function getAccountUser(
    gatewayService: ApiGatewayService,
    authorization: string | undefined,
    action: string,
): Promise<any> {
    const user = await getUserFromAuthorizationHeader(gatewayService, authorization);

    if (user.isGuest) {
        throw new ForbiddenException(`Connect a wallet or sign in to ${action}.`);
    }

    return user;
}

export function startSession(
    res: Response,
    session: {
        accessToken: string;
        refreshToken: string;
        refreshTokenExpiresAt: string | Date;
        user: unknown;
        claimedWorkspaces?: unknown[];
    },
) {
    setRefreshCookie(res, session.refreshToken, session.refreshTokenExpiresAt);

    return {
        accessToken: session.accessToken,
        user: session.user,
        ...(session.claimedWorkspaces ? { claimedWorkspaces: session.claimedWorkspaces } : {}),
    };
}
