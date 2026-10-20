import { WorkspaceService } from './workspace-service.service';
import type { PrismaService } from 'libs/prisma/src/prisma.service';
import type { ClientProxy } from '@nestjs/microservices';
import { of } from 'rxjs';

describe('WorkspaceService', () => {
    let service: WorkspaceService;
    let mockPrisma: any;
    let mockRuntimeClient: any;

    beforeEach(() => {
        const dummyWs = {
            id: 'ws-123',
            name: 'My Workspace',
            userId: 'user-1',
            templateId: 'hello-world',
            temporary: false,
            status: 'PENDING',
            createdAt: new Date(),
            lastActivityAt: new Date(),
        };

        mockPrisma = {
            workspace: {
                count: jest.fn().mockResolvedValue(0),
                create: jest.fn().mockResolvedValue(dummyWs),
                findMany: jest.fn().mockResolvedValue([dummyWs]),
                findUnique: jest.fn().mockResolvedValue(dummyWs),
                update: jest.fn().mockResolvedValue({ ...dummyWs, temporary: true }),
            },
        };

        mockRuntimeClient = {
            send: jest.fn().mockReturnValue(of({ success: true })),
        };

        service = new WorkspaceService(
            mockPrisma as unknown as PrismaService,
            mockRuntimeClient as unknown as ClientProxy,
        );
    });

    it('should create a workspace and return it with expiry calculation', async () => {
        const ws = await service.create({
            userId: 'user-1',
            name: 'My Workspace',
            templateId: 'hello-world',
        });

        expect(ws.id).toBe('ws-123');
        expect(mockPrisma.workspace.create).toHaveBeenCalled();
        expect(ws.expiresAt).toBeNull();
    });

    it('should find all workspaces for a user via findMine', async () => {
        const list = await service.findMine('user-1');
        expect(list).toHaveLength(1);
        expect(mockPrisma.workspace.findMany).toHaveBeenCalled();
    });

    it('should find one workspace by user and id', async () => {
        const ws = await service.findOne('user-1', 'ws-123');
        expect(ws.id).toBe('ws-123');
        expect(mockPrisma.workspace.findUnique).toHaveBeenCalledWith({
            where: { id: 'ws-123' },
            include: { containers: true },
        });
    });

    it('should set workspace temporary status', async () => {
        const ws = await service.setTemporary({
            workspaceId: 'ws-123',
            userId: 'user-1',
            temporary: true,
        });
        expect(ws.temporary).toBe(true);
        expect(mockPrisma.workspace.update).toHaveBeenCalled();
    });
});
