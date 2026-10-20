import { Injectable } from '@nestjs/common';
import { DockerService } from './docker/docker.service';
import { HostScheduler } from './host-scheduler';
import { StructuredLogger } from 'libs/logger/src/structured-logger.service';

@Injectable()
export class RuntimeHealthService {
    private readonly logger = new StructuredLogger('RuntimeHealthService');

    constructor(
        private readonly docker: DockerService,
        private readonly scheduler: HostScheduler,
    ) { }

    async health() {
        await this.docker.ping();

        const hosts = await this.scheduler.summary();
        this.logger.log('Runtime health check performed', { hostsCount: hosts.length });

        return {
            service: 'runtime-service',
            status: 'ok',
            timestamp: new Date().toISOString(),
            hosts,
        };
    }

    async pingHost(hostId: string | null): Promise<boolean> {
        try {
            await this.docker.on(hostId).ping();
            return true;
        } catch (error) {
            this.logger.warn('Host ping failed', { hostId: hostId ?? 'default', error });
            return false;
        }
    }
}
