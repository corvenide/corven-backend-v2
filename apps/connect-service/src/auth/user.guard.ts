// apps/connect-service/src/auth/user.guard.ts

import { CanActivate, createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common';

import { fail } from '../http/errors';
import { TokensService } from './tokens.service';

/** Requires a valid Connect access token for the request's app. Runs after AppGuard. */
@Injectable()
export class UserGuard implements CanActivate {
    constructor(private readonly tokens: TokensService) { }

    canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest();
        const userId = this.tokens.userFromAuthorization(req.headers.authorization, req.connect.app.id);
        if (!userId) throw fail(401, 'Sign in first.', 'unauthorized');
        req.connectUserId = userId;
        return true;
    }
}

export const UserId = createParamDecorator((_: unknown, context: ExecutionContext): string => {
    return context.switchToHttp().getRequest().connectUserId;
});
