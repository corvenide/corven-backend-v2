import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class RpcService {
    private readonly logger = new Logger(RpcService.name);

    async getTipBlockNumber() { }

    async getBlock(hash: string) { }

    async getTransaction(hash: string) { }

    async getLiveCell(outPoint: string) { }

    async getHeader(hash: string) { }

    async estimateCycles(tx: unknown) { }

    async sendTransaction(tx: unknown) { }
}