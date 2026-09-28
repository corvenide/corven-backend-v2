import { Module } from '@nestjs/common';
import { CellGateway } from './websocket.gateway';

@Module({
    providers: [CellGateway],
    exports: [CellGateway],
})
export class WebsocketModule { }