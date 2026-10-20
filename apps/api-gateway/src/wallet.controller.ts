import {
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    Post,
    Req,
    Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { ApiGatewayService } from './api-gateway.service';
import { assertTrustedOrigin, RateLimiter } from './auth-session';
import { getAccountUser } from './auth-helpers';
import {
    WalletExportDto,
    WalletSignTestnetDto,
    WalletTransferDto,
} from './dto/wallet.dto';

@Controller('wallet')
export class WalletController {
    constructor(private readonly gatewayService: ApiGatewayService) { }

    private readonly walletLimiter = new RateLimiter(10, 60_000);

    /** The user's Corven-held testnet and mainnet wallets, with balances. */
    @Get()
    async listWallets(@Headers('authorization') authorization: string) {
        const user = await getAccountUser(this.gatewayService, authorization, 'use Corven wallets');
        return this.gatewayService.listWallets(user.id);
    }

    /** Sends CKB. Mainnet needs `confirmation`: a fresh Google ID token. */
    @Post('transfer')
    @HttpCode(200)
    async walletTransfer(
        @Req() req: Request,
        @Headers('authorization') authorization: string,
        @Body() body: WalletTransferDto,
    ) {
        assertTrustedOrigin(req);
        const user = await getAccountUser(this.gatewayService, authorization, 'use Corven wallets');
        this.walletLimiter.consume(`transfer:${user.id}`);
        return this.gatewayService.walletTransfer(user.id, (body as unknown as Record<string, unknown>) ?? {});
    }

    /** Signs a browser-built testnet transaction (contract deploys) with the testnet wallet. */
    @Post('sign-testnet')
    @HttpCode(200)
    async walletSignTestnet(
        @Req() req: Request,
        @Headers('authorization') authorization: string,
        @Body() body: WalletSignTestnetDto,
    ) {
        assertTrustedOrigin(req);
        const user = await getAccountUser(this.gatewayService, authorization, 'use Corven wallets');
        this.walletLimiter.consume(`sign:${user.id}`);
        return this.gatewayService.walletSignTestnet(user.id, body?.transaction);
    }

    /** Returns a wallet's private key. Needs a fresh Google confirmation. */
    @Post('export')
    @HttpCode(200)
    async walletExport(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
        @Headers('authorization') authorization: string,
        @Body() body: WalletExportDto,
    ) {
        assertTrustedOrigin(req);
        const user = await getAccountUser(this.gatewayService, authorization, 'use Corven wallets');
        this.walletLimiter.consume(`export:${user.id}`);
        res.setHeader('Cache-Control', 'no-store');
        return this.gatewayService.walletExport(user.id, (body as unknown as Record<string, unknown>) ?? {});
    }
}
