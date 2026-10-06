// apps/auth-service/src/wallets/wallet.controller.ts

import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { WalletService } from './wallet.service';

@Controller()
export class WalletController {
    constructor(private readonly wallets: WalletService) { }

    @MessagePattern({ cmd: 'wallet.list' })
    list(@Payload() data: { userId: string }) {
        return this.wallets.list(data);
    }

    @MessagePattern({ cmd: 'wallet.transfer' })
    transfer(@Payload() data: { userId: string; network: unknown; to: unknown; amountCkb: unknown; confirmation?: unknown }) {
        return this.wallets.transfer(data);
    }

    @MessagePattern({ cmd: 'wallet.sign-testnet' })
    signTestnet(@Payload() data: { userId: string; transaction: unknown }) {
        return this.wallets.signTestnetTransaction(data);
    }

    @MessagePattern({ cmd: 'wallet.export' })
    exportKey(@Payload() data: { userId: string; network: unknown; confirmation?: unknown }) {
        return this.wallets.exportKey(data);
    }
}
