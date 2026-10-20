import { DockerClient, DockerService } from './docker.service';
import type Docker from 'dockerode';

describe('DockerService and DockerClient', () => {
    let mockDocker: any;
    let client: DockerClient;

    beforeEach(() => {
        mockDocker = {
            ping: jest.fn().mockResolvedValue('OK'),
            info: jest.fn().mockResolvedValue({
                NCPU: 4,
                MemTotal: 8589934592,
                ContainersRunning: 2,
                Name: 'docker-host-1',
            }),
            getImage: jest.fn().mockReturnValue({
                inspect: jest.fn().mockResolvedValue({ Id: 'sha256:abc123' }),
            }),
            createContainer: jest.fn().mockResolvedValue({
                id: 'container-123',
                start: jest.fn().mockResolvedValue(undefined),
                stop: jest.fn().mockResolvedValue(undefined),
                remove: jest.fn().mockResolvedValue(undefined),
                inspect: jest.fn().mockResolvedValue({
                    State: { Running: true, Status: 'running' },
                    NetworkSettings: { Ports: { '3000/tcp': [{ HostPort: '32000' }] } },
                }),
            }),
            getContainer: jest.fn().mockReturnValue({
                id: 'container-123',
                inspect: jest.fn().mockResolvedValue({
                    State: { Running: true, Status: 'running' },
                    NetworkSettings: { Ports: { '3000/tcp': [{ HostPort: '32000' }] } },
                }),
                stop: jest.fn().mockResolvedValue(undefined),
                remove: jest.fn().mockResolvedValue(undefined),
            }),
            createNetwork: jest.fn().mockResolvedValue({ id: 'net-1' }),
            getNetwork: jest.fn().mockReturnValue({
                inspect: jest.fn().mockResolvedValue({ Id: 'net-1', Name: 'fiberdev-net' }),
                remove: jest.fn().mockResolvedValue(undefined),
            }),
            createVolume: jest.fn().mockResolvedValue({ Name: 'vol-1' }),
            getVolume: jest.fn().mockReturnValue({
                inspect: jest.fn().mockResolvedValue({ Name: 'vol-1' }),
                remove: jest.fn().mockResolvedValue(undefined),
            }),
            listContainers: jest.fn().mockResolvedValue([]),
        };

        client = new DockerClient(mockDocker as unknown as Docker, 'test-host');
    });

    describe('DockerClient', () => {
        it('should return host info', async () => {
            const info = await client.hostInfo();
            expect(info.cpus).toBe(4);
            expect(info.memoryBytes).toBe(8589934592);
            expect(info.containersRunning).toBe(2);
            expect(info.name).toBe('docker-host-1');
        });

        it('should ping docker daemon successfully', async () => {
            await expect(client.ping()).resolves.not.toThrow();
            expect(mockDocker.ping).toHaveBeenCalled();
            expect(mockDocker.info).toHaveBeenCalled();
        });

        it('should retrieve imageId if image exists', async () => {
            const id = await client.imageId('fiberdev/ckb-node:dev');
            expect(id).toBe('sha256:abc123');
        });

        it('should return null when image is missing', async () => {
            mockDocker.getImage.mockReturnValueOnce({
                inspect: jest.fn().mockRejectedValue(new Error('404 image not found')),
            });
            const id = await client.imageId('missing:image');
            expect(id).toBeNull();
        });

        it('should check if network exists', async () => {
            const exists = await client.networkExists('fiberdev-net');
            expect(exists).toBe(true);
        });

        it('should create network if not exists', async () => {
            mockDocker.getNetwork.mockReturnValueOnce({
                inspect: jest.fn().mockRejectedValue(new Error('no such network')),
            });
            const net = await client.createNetwork('new-net');
            expect(net).toBeDefined();
            expect(mockDocker.createNetwork).toHaveBeenCalled();
        });

        it('should check if volume exists', async () => {
            const exists = await client.volumeExists('vol-1');
            expect(exists).toBe(true);
        });

        it('should create volume if not exists', async () => {
            mockDocker.getVolume.mockReturnValueOnce({
                inspect: jest.fn().mockRejectedValue(new Error('no such volume')),
            });
            const vol = await client.createVolume('new-vol');
            expect(vol).toBeDefined();
            expect(mockDocker.createVolume).toHaveBeenCalled();
        });

        it('should remove volume gracefully', async () => {
            await expect(client.removeVolume('vol-1')).resolves.not.toThrow();
        });

        it('should remove network gracefully', async () => {
            await expect(client.removeNetwork('fiberdev-net')).resolves.not.toThrow();
        });
    });

    describe('DockerService registry resolution', () => {
        it('should provide default host client', () => {
            const service = new DockerService();
            const hostClient = service.on();
            expect(hostClient).toBeDefined();
            expect(hostClient.hostId).toBe(service.registry.defaultHostId);
        });
    });
});
