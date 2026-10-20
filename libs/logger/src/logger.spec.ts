import { StructuredLogger } from './structured-logger.service';
import { MetricsService } from './metrics.service';

describe('StructuredLogger & MetricsService', () => {
    describe('StructuredLogger', () => {
        let logger: StructuredLogger;

        beforeEach(() => {
            logger = new StructuredLogger('TestContext');
        });

        it('should instantiate and log messages with metadata', () => {
            expect(() => {
                logger.log('hello world', { workspaceId: 'ws-123', clientId: 'c-456' });
                logger.warn('warning test', 'CustomContext');
                logger.debug('debug info', { test: true });
                logger.verbose('verbose info');
                logger.error('error occurred', 'stack trace', { error: 'something broke' });
            }).not.toThrow();
        });

        it('should allow setting context', () => {
            logger.setContext('NewContext');
            expect(() => logger.log('test after context change')).not.toThrow();
        });
    });

    describe('MetricsService', () => {
        let metricsService: MetricsService;

        beforeEach(() => {
            metricsService = new MetricsService();
            metricsService.onModuleInit();
        });

        it('should track requests and return Prometheus metrics format', async () => {
            metricsService.httpRequestsTotal.inc({ method: 'GET', route: '/api/health', status_code: '200' });
            metricsService.httpRequestDuration.observe({ method: 'GET', route: '/api/health', status_code: '200' }, 0.05);
            metricsService.activeWorkspaces.set(3);
            metricsService.activeSockets.set(5);

            const metrics = await metricsService.getMetrics();
            expect(metrics).toContain('http_requests_total');
            expect(metrics).toContain('workspaces_active_total 3');
            expect(metrics).toContain('websocket_connections_active 5');
            expect(metricsService.getContentType()).toBeDefined();
        });
    });
});
