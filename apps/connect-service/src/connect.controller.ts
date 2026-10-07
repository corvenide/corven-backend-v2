// apps/connect-service/src/connect.controller.ts
//
// Public Corven Connect API, called by the SDK from an app's pages:
//   https://<api domain>/connect/v1/...
// Every request names its app in the x-corven-app header; signed-in calls
// add `Authorization: Bearer <access token>`.

import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { AccountsService } from './auth/accounts.service';
import { TokensService } from './auth/tokens.service';
import { UserGuard, UserId } from './auth/user.guard';
import { AppGuard, Ctx, type ConnectRequestContext } from './http/app.guard';
import { WalletsService } from './wallets/wallets.service';

@Controller('v1')
@UseGuards(AppGuard)
export class ConnectController {
    constructor(
        private readonly accounts: AccountsService,
        private readonly wallets: WalletsService,
        private readonly tokens: TokensService,
    ) { }

    @Get('config')
    config(@Ctx() ctx: ConnectRequestContext) {
        return this.accounts.publicConfig(ctx);
    }

    // ---------------------------------------------------------- sign in

    /** Body: { phone, channel?: sms|whatsapp|call } or { email }. */
    @Post('auth/code/send')
    @HttpCode(200)
    sendCode(@Ctx() ctx: ConnectRequestContext, @Body() body: any) {
        return this.accounts.sendCode(ctx, body ?? {});
    }

    /** Body: { phone | email, code }. With a bearer token, links it instead. */
    @Post('auth/code/verify')
    @HttpCode(200)
    verifyCode(@Ctx() ctx: ConnectRequestContext, @Headers('authorization') auth: string, @Body() body: any) {
        return this.accounts.verifyCode(ctx, auth, body ?? {});
    }

    /** Body: { credential } (Google ID token). With a bearer token, links it instead. */
    @Post('auth/google')
    @HttpCode(200)
    google(@Ctx() ctx: ConnectRequestContext, @Headers('authorization') auth: string, @Body() body: any) {
        return this.accounts.google(ctx, auth, body ?? {});
    }

    /** Body: { address } (the wallet's testnet address). */
    @Post('auth/wallet/challenge')
    @HttpCode(200)
    walletChallenge(@Ctx() ctx: ConnectRequestContext, @Body() body: any) {
        return this.accounts.walletChallenge(ctx, body ?? {});
    }

    /** Body: { challengeToken, signature, walletName? }. With a bearer token, links the wallet instead. */
    @Post('auth/wallet/verify')
    @HttpCode(200)
    walletLogin(@Ctx() ctx: ConnectRequestContext, @Headers('authorization') auth: string, @Body() body: any) {
        return this.accounts.walletLogin(ctx, auth, body ?? {});
    }

    @Post('auth/passkey/options')
    @HttpCode(200)
    passkeyLoginOptions(@Ctx() ctx: ConnectRequestContext) {
        return this.accounts.passkeyAuthOptions(ctx, null);
    }

    /** Body: { response, challengeToken }. */
    @Post('auth/passkey/verify')
    @HttpCode(200)
    passkeyLogin(@Ctx() ctx: ConnectRequestContext, @Body() body: any) {
        return this.accounts.passkeyLogin(ctx, body ?? {});
    }

    @Post('auth/refresh')
    @HttpCode(200)
    refresh(@Ctx() ctx: ConnectRequestContext, @Body() body: any) {
        return this.accounts.refresh(ctx, body ?? {});
    }

    @Post('auth/logout')
    @HttpCode(200)
    logout(@Body() body: any) {
        return this.accounts.logout(body ?? {});
    }

    // ---------------------------------------------------------- signed in

    @Get('me')
    @UseGuards(UserGuard)
    me(@UserId() userId: string) {
        return this.accounts.me(userId);
    }

    @Patch('me')
    @UseGuards(UserGuard)
    updateMe(@UserId() userId: string, @Body() body: any) {
        return this.accounts.updateProfile(userId, body ?? {});
    }

    @Delete('me/identities/:id')
    @UseGuards(UserGuard)
    unlinkIdentity(@UserId() userId: string, @Param('id') id: string) {
        return this.accounts.unlink(userId, 'identity', id);
    }

    @Delete('me/passkeys/:id')
    @UseGuards(UserGuard)
    removePasskey(@UserId() userId: string, @Param('id') id: string) {
        return this.accounts.unlink(userId, 'passkey', id);
    }

    @Post('me/passkeys/options')
    @HttpCode(200)
    @UseGuards(UserGuard)
    passkeyRegisterOptions(@Ctx() ctx: ConnectRequestContext, @UserId() userId: string) {
        return this.accounts.passkeyRegisterOptions(ctx, userId);
    }

    /** Body: { response, challengeToken, name? }. */
    @Post('me/passkeys')
    @HttpCode(200)
    @UseGuards(UserGuard)
    addPasskey(@Ctx() ctx: ConnectRequestContext, @UserId() userId: string, @Body() body: any) {
        return this.accounts.passkeyRegisterVerify(ctx, userId, body ?? {});
    }

    /** Signs out everywhere. */
    @Post('me/sessions/revoke')
    @HttpCode(200)
    @UseGuards(UserGuard)
    async revokeAll(@UserId() userId: string) {
        await this.tokens.revokeAll(userId);
        return { ok: true };
    }

    // ---------------------------------------------------------- step-up

    /** Body: { method: PHONE|EMAIL, channel? }. */
    @Post('step-up/code/send')
    @HttpCode(200)
    @UseGuards(UserGuard)
    stepUpSend(@Ctx() ctx: ConnectRequestContext, @UserId() userId: string, @Body() body: any) {
        return this.accounts.stepUpSend(ctx, userId, body ?? {});
    }

    @Post('step-up/passkey/options')
    @HttpCode(200)
    @UseGuards(UserGuard)
    stepUpPasskeyOptions(@Ctx() ctx: ConnectRequestContext, @UserId() userId: string) {
        return this.accounts.passkeyAuthOptions(ctx, userId);
    }

    /** Body: { address }: a message for one of the user's wallets to sign. */
    @Post('step-up/wallet/challenge')
    @HttpCode(200)
    @UseGuards(UserGuard)
    stepUpWalletChallenge(@Ctx() ctx: ConnectRequestContext, @UserId() userId: string, @Body() body: any) {
        return this.accounts.walletStepUpChallenge(ctx, userId, body ?? {});
    }

    /** Body: { purpose: sign|export, method, code | credential | response+challengeToken | signature+challengeToken }. */
    @Post('step-up/verify')
    @HttpCode(200)
    @UseGuards(UserGuard)
    stepUpVerify(@Ctx() ctx: ConnectRequestContext, @UserId() userId: string, @Body() body: any) {
        return this.accounts.stepUpVerify(ctx, userId, body ?? {});
    }

    // ---------------------------------------------------------- wallets

    @Get('wallets')
    @UseGuards(UserGuard)
    listWallets(@UserId() userId: string) {
        return this.wallets.list(userId);
    }

    /** Body: { network, transaction, stepUpToken? (mainnet) }. */
    @Post('wallets/sign')
    @HttpCode(200)
    @UseGuards(UserGuard)
    sign(@Ctx() ctx: ConnectRequestContext, @UserId() userId: string, @Body() body: any) {
        return this.wallets.sign(userId, ctx, body ?? {});
    }

    /** Body: { network, stepUpToken }. */
    @Post('wallets/export')
    @HttpCode(200)
    @UseGuards(UserGuard)
    exportKey(@Ctx() ctx: ConnectRequestContext, @UserId() userId: string, @Body() body: any) {
        return this.wallets.exportKey(userId, ctx, body ?? {});
    }
}

@Controller()
export class HealthController {
    @Get('health')
    health() {
        return { ok: true, service: 'connect-service' };
    }
}
