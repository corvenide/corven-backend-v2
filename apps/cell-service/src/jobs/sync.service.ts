import {
    Injectable,
    Logger,
    OnModuleInit,
} from '@nestjs/common';

import { RpcService } from '../rpc/rpc.service';

@Injectable()
export class SyncService implements OnModuleInit {
    private readonly logger = new Logger(SyncService.name);

    constructor(
        private readonly rpc: RpcService,
    ) { }

    onModuleInit() {
        this.start();
    }

    async start() {
        this.logger.log('Starting blockchain synchronizer...');
    }

    async syncLatestBlock() { }

    async syncTransactions() { }

    async syncCells() { }

    async syncScripts() { }

    async syncAddresses() { }
}