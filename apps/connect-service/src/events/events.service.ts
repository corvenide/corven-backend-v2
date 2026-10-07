// apps/connect-service/src/events/events.service.ts
//
// Usage events behind the dashboard's stats. Writes never block or fail the
// request that caused them.

import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '@app/prisma';

export type EventKind = 'SIGN_UP' | 'SIGN_IN' | 'CODE_SENT' | 'TX_SIGNED';

@Injectable()
export class EventsService {
    private readonly logger = new Logger('ConnectEvents');

    constructor(private readonly prisma: PrismaService) { }

    record(appId: string, kind: EventKind, method?: string): void {
        this.prisma.connectEvent
            .create({ data: { appId, kind, method: method?.slice(0, 20) ?? null } })
            .catch((error: unknown) => this.logger.warn(`Could not record ${kind}: ${error instanceof Error ? error.message : error}`));
    }
}
