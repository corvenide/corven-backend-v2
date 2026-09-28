import { Module } from '@nestjs/common';

import { RpcModule } from '../rpc/rpc.module';

import { SyncService } from './sync.service';

@Module({
    imports: [RpcModule],
    providers: [SyncService],
})
export class JobsModule { }