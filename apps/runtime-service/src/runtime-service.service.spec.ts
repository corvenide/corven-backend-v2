import { RuntimeHealthService } from './runtime-health.service';
import type { DockerService } from './docker/docker.service';
import type { HostScheduler } from './host-scheduler';

describe('RuntimeHealthService', () => {
    let mockDocker: Partial<DockerService>;
    let mockScheduler: Partial<HostScheduler>;
    let service: RuntimeHealthService;

    beforeEach(() => {
        mockDocker = {
            ping: jest.fn().mockResolvedValue(undefined),
            on: jest.fn().mockReturnValue({
                ping: jest.fn().mockResolvedValue(undefined),
            }),
        };

        mockScheduler = {
            summary: jest.fn().mockResolvedValue([
                { id: 'host-1', status: 'online', runningWorkspaces: 2, maxWorkspaces: 10 },
            ]),
        };

        service = new RuntimeHealthService(
            mockDocker as DockerService,
            mockScheduler as HostScheduler,
        );
    });

    it('should return health status with hosts summary', async () => {
        const res = await service.health();
        expect(res.service).toBe('runtime-service');
        expect(res.status).toBe('ok');
        expect(res.hosts).toHaveLength(1);
        expect(mockDocker.ping).toHaveBeenCalled();
        expect(mockScheduler.summary).toHaveBeenCalled();
    });

    it('should ping a specific host successfully', async () => {
        const ok = await service.pingHost('host-1');
        expect(ok).toBe(true);
        expect(mockDocker.on).toHaveBeenCalledWith('host-1');
    });

    it('should handle ping failure gracefully and return false', async () => {
        mockDocker.on = jest.fn().mockReturnValue({
            ping: jest.fn().mockRejectedValue(new Error('Connection refused')),
        });

        const ok = await service.pingHost('offline-host');
        expect(ok).toBe(false);
    });
});
