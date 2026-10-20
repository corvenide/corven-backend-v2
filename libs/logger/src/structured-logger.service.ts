import { Injectable, LoggerService, Scope } from '@nestjs/common';
import pino from 'pino';

export interface LogMeta {
    workspaceId?: string;
    clientId?: string;
    userId?: string;
    durationMs?: number;
    error?: unknown;
    [key: string]: unknown;
}

@Injectable({ scope: Scope.DEFAULT })
export class StructuredLogger implements LoggerService {
    private readonly pinoLogger: pino.Logger;

    constructor(private context: string = 'Application') {
        this.pinoLogger = pino({
            level: process.env.LOG_LEVEL || 'info',
            formatters: {
                level: (label) => ({ level: label }),
            },
            timestamp: pino.stdTimeFunctions.isoTime,
        });
    }

    setContext(context: string) {
        this.context = context; metrics.service.ts
    }

    log(message: string, metaOrContext?: LogMeta | string) {
        if (typeof metaOrContext === 'string') {
            this.pinoLogger.info({ context: metaOrContext }, message);
        } else {
            this.pinoLogger.info({ context: this.context, ...metaOrContext }, message);
        }
    }

    error(message: string, trace?: string, metaOrContext?: LogMeta | string) {
        const meta = typeof metaOrContext === 'object' ? metaOrContext : {};
        const ctx = typeof metaOrContext === 'string' ? metaOrContext : this.context;
        this.pinoLogger.error({ context: ctx, trace, ...meta }, message);
    }

    warn(message: string, metaOrContext?: LogMeta | string) {
        if (typeof metaOrContext === 'string') {
            this.pinoLogger.warn({ context: metaOrContext }, message);
        } else {
            this.pinoLogger.warn({ context: this.context, ...metaOrContext }, message);
        }
    }

    debug(message: string, metaOrContext?: LogMeta | string) {
        if (typeof metaOrContext === 'string') {
            this.pinoLogger.debug({ context: metaOrContext }, message);
        } else {
            this.pinoLogger.debug({ context: this.context, ...metaOrContext }, message);
        }
    }

    verbose(message: string, metaOrContext?: LogMeta | string) {
        if (typeof metaOrContext === 'string') {
            this.pinoLogger.trace({ context: metaOrContext }, message);
        } else {
            this.pinoLogger.trace({ context: this.context, ...metaOrContext }, message);
        }
    }
}
