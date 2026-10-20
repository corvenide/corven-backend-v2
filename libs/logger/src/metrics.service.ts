import { Injectable, OnModuleInit } from '@nestjs/common';
import * as client from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
    private readonly registry: client.Registry;

    public readonly httpRequestsTotal: client.Counter<string>;
    public readonly httpRequestDuration: client.Histogram<string>;
    public readonly activeWorkspaces: client.Gauge<string>;
    public readonly activeSockets: client.Gauge<string>;

    constructor() {
        this.registry = new client.Registry();

        this.httpRequestsTotal = new client.Counter({
            name: 'http_requests_total',
            help: 'Total number of HTTP requests handled',
            labelNames: ['method', 'route', 'status_code'],
            registers: [this.registry],
        });

        this.httpRequestDuration = new client.Histogram({
            name: 'http_request_duration_seconds',
            help: 'Duration of HTTP requests in seconds',
            labelNames: ['method', 'route', 'status_code'],
            buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
            registers: [this.registry],
        });

        this.activeWorkspaces = new client.Gauge({
            name: 'workspaces_active_total',
            help: 'Current number of active running workspaces',
            registers: [this.registry],
        });

        this.activeSockets = new client.Gauge({
            name: 'websocket_connections_active',
            help: 'Current number of active WebSocket connections',
            registers: [this.registry],
        });
    }

    onModuleInit() {
        client.collectDefaultMetrics({ register: this.registry });
    }

    async getMetrics(): Promise<string> {
        return this.registry.metrics();
    }

    getContentType(): string {
        return this.registry.contentType;
    }
}
