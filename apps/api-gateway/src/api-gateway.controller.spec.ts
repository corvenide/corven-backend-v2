import { BadRequestException } from '@nestjs/common';
import { ApiGatewayController } from './api-gateway.controller';
import { AuthController } from './auth.controller';
import { WalletController } from './wallet.controller';
import { WorkspaceController } from './workspace.controller';
import type { ApiGatewayService } from './api-gateway.service';
import type { MetricsService } from 'libs/logger/src/metrics.service';

describe('ApiGateway Controllers', () => {
    let mockGatewayService: Partial<ApiGatewayService>;
    let mockMetricsService: Partial<MetricsService>;
    let apiGatewayController: ApiGatewayController;
    let authController: AuthController;
    let walletController: WalletController;
    let workspaceController: WorkspaceController;

    beforeEach(() => {
        mockGatewayService = {
            runtimeHealth: jest.fn().mockResolvedValue({ status: 'ok', hosts: [] }),
            resolvePreview: jest.fn().mockResolvedValue({ internalPort: 3000 }),
            verifyToken: jest.fn().mockResolvedValue({ user: { id: 'user-1', isGuest: false } }),
            guestStart: jest.fn().mockResolvedValue({ accessToken: 'guest-tok', refreshToken: 'ref-tok', refreshTokenExpiresAt: new Date(), user: { id: 'g1', isGuest: true } }),
            createWalletChallenge: jest.fn().mockResolvedValue({ challenge: 'sign this', challengeId: 'ch-1' }),
            walletLogin: jest.fn().mockResolvedValue({ accessToken: 'w-tok', refreshToken: 'ref-tok', refreshTokenExpiresAt: new Date(), user: { id: 'w1' } }),
            listWallets: jest.fn().mockResolvedValue([{ address: 'ckt1...', network: 'TESTNET', balance: '1000' }]),
            walletTransfer: jest.fn().mockResolvedValue({ txHash: '0x123' }),
            createWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1', name: 'My Workspace' }),
            findMyWorkspaces: jest.fn().mockResolvedValue([{ id: 'ws-1', name: 'My Workspace' }]),
            findOneWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1', name: 'My Workspace' }),
            deleteWorkspace: jest.fn().mockResolvedValue({ success: true }),
        };

        mockMetricsService = {
            getContentType: jest.fn().mockReturnValue('text/plain; version=0.0.4'),
            getMetrics: jest.fn().mockResolvedValue('# HELP http_requests_total\nhttp_requests_total 42'),
        };

        apiGatewayController = new ApiGatewayController(
            mockGatewayService as ApiGatewayService,
            mockMetricsService as MetricsService,
        );

        authController = new AuthController(mockGatewayService as ApiGatewayService);
        walletController = new WalletController(mockGatewayService as ApiGatewayService);
        workspaceController = new WorkspaceController(mockGatewayService as ApiGatewayService);
    });

    describe('ApiGatewayController', () => {
        it('should return health status', () => {
            const health = apiGatewayController.health();
            expect(health.status).toBe('ok');
            expect(health.service).toBe('api-gateway');
            expect(health.timestamp).toBeDefined();
        });

        it('should call runtimeHealth', async () => {
            const res = await apiGatewayController.runtimeHealth();
            expect(res).toEqual({ status: 'ok', hosts: [] });
            expect(mockGatewayService.runtimeHealth).toHaveBeenCalled();
        });

        it('should return metrics with correct headers', async () => {
            const res = {
                setHeader: jest.fn(),
                send: jest.fn(),
            } as any;

            await apiGatewayController.getMetrics(res);
            expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain; version=0.0.4');
            expect(res.send).toHaveBeenCalledWith(expect.stringContaining('http_requests_total'));
        });

        it('should return workspace templates', () => {
            const templates = apiGatewayController.listWorkspaceTemplates();
            expect(Array.isArray(templates)).toBe(true);
            expect(templates.length).toBeGreaterThan(0);
        });

        it('should throw BadRequestException on invalid preview port', async () => {
            await expect(
                apiGatewayController.openPreview('Bearer valid-token', 'ws-1', { port: -1 }),
            ).rejects.toThrow(BadRequestException);
        });
    });

    describe('AuthController', () => {
        it('should create wallet challenge', () => {
            const req = { ip: '127.0.0.1' } as any;
            const res = authController.createWalletChallenge(req, { walletAddress: 'ckt1...' });
            expect(res).toBeDefined();
            expect(mockGatewayService.createWalletChallenge).toHaveBeenCalledWith({ walletAddress: 'ckt1...' });
        });

        it('should perform wallet login and return session', async () => {
            const req = { ip: '127.0.0.1', headers: { 'user-agent': 'jest', origin: 'http://localhost:3000' } } as any;
            const res = { cookie: jest.fn() } as any;
            const session = await authController.walletLogin(req, res, undefined, {
                walletAddress: 'ckt1...',
                challengeId: 'ch-1',
                signature: 'sig',
            });
            expect(session.accessToken).toBe('w-tok');
            expect(mockGatewayService.walletLogin).toHaveBeenCalled();
        });
    });

    describe('WalletController', () => {
        it('should list wallets for authenticated user', async () => {
            const wallets = await walletController.listWallets('Bearer user-token');
            expect(wallets).toHaveLength(1);
            expect(mockGatewayService.listWallets).toHaveBeenCalledWith('user-1');
        });

        it('should initiate wallet transfer', async () => {
            const req = {
                ip: '127.0.0.1',
                headers: { 'user-agent': 'jest' },
                get: jest.fn().mockReturnValue('localhost'),
            } as any;
            const result = await walletController.walletTransfer(req, 'Bearer user-token', {
                toAddress: 'ckt1recipient',
                amount: '100',
            });
            expect(result).toEqual({ txHash: '0x123' });
            expect(mockGatewayService.walletTransfer).toHaveBeenCalled();
        });
    });

    describe('WorkspaceController', () => {
        it('should create a workspace', async () => {
            const ws = await workspaceController.createWorkspace('Bearer user-token', {
                name: 'Test Project',
            });
            expect(ws).toEqual({ id: 'ws-1', name: 'My Workspace' });
            expect(mockGatewayService.createWorkspace).toHaveBeenCalledWith(
                expect.objectContaining({ name: 'Test Project', userId: 'user-1' }),
            );
        });

        it('should list user workspaces', async () => {
            const list = await workspaceController.findMyWorkspaces('Bearer user-token');
            expect(list).toHaveLength(1);
            expect(mockGatewayService.findMyWorkspaces).toHaveBeenCalledWith('user-1');
        });

        it('should delete a workspace', async () => {
            const res = await workspaceController.deleteWorkspace('Bearer user-token', 'ws-1');
            expect(res).toEqual({ success: true });
            expect(mockGatewayService.deleteWorkspace).toHaveBeenCalledWith('user-1', 'ws-1');
        });
    });
});
