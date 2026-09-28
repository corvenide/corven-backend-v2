import {
    WebSocketGateway,
    WebSocketServer,
} from '@nestjs/websockets';

import { Server } from 'socket.io';

@WebSocketGateway({
    cors: true,
})
export class CellGateway {
    @WebSocketServer()
    server: Server;

    emit(event: string, payload: unknown) {
        this.server.emit(event, payload);
    }
}