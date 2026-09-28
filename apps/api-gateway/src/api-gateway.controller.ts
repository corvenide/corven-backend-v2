// apps/api-gateway/src/api-gateway.controller.ts

import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    Headers,
    HttpCode,
    Param,
    Patch,
    Post,
    Put,
    Query,
    Req,
    Res,
    UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { findTemplate, WORKSPACE_TEMPLATES } from 'libs/prisma/src/workspace-templates';

import { ApiGatewayService } from './api-gateway.service';
import {
    assertTrustedOrigin,
    clearRefreshCookie,
    RateLimiter,
    readRefreshCookie,
    sessionMeta,
    setRefreshCookie,
} from './auth-session';

@Controller()
export class ApiGatewayController {
    constructor(
        private readonly gatewayService: ApiGatewayService,
    ) { }

    // =========================================
    // Authentication
    // =========================================

    private readonly authLimiter = new RateLimiter(20, 60_000);

    @Post('auth/wallet/challenge')
    createWalletChallenge(
        @Req() req: Request,
        @Body() body: { walletAddress: string },
    ) {
        this.authLimiter.consume(`challenge:${req.ip}`);

        return this.gatewayService.createWalletChallenge({
            walletAddress: body?.walletAddress,
        });
    }

    @Post('auth/wallet/login')
    async walletLogin(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
        @Body()
        body: {
            walletAddress: string;
            challengeId: string;
            signature: unknown;
        },
    ) {
        this.authLimiter.consume(`login:${req.ip}`);

        const session = await this.gatewayService.walletLogin({
            walletAddress: body?.walletAddress,
            challengeId: body?.challengeId,
            signature: body?.signature,
            meta: sessionMeta(req),
        });

        return this.startSession(res, session);
    }

    @Post('auth/register')
    async register(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
        @Body() body: { name: string; email: string; password: string },
    ) {
        this.authLimiter.consume(`login:${req.ip}`);

        const session = await this.gatewayService.register({
            name: body?.name,
            email: body?.email,
            password: body?.password,
            meta: sessionMeta(req),
        });

        return this.startSession(res, session);
    }

    @Post('auth/login')
    async login(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
        @Body() body: { email: string; password: string },
    ) {
        this.authLimiter.consume(`login:${req.ip}`);

        const session = await this.gatewayService.login({
            email: body?.email,
            password: body?.password,
            meta: sessionMeta(req),
        });

        return this.startSession(res, session);
    }

    /**
     * Exchanges the httpOnly refresh cookie for a new access token and
     * rotates the cookie. Called on page load and before the access token
     * expires.
     */
    @Post('auth/refresh')
    @HttpCode(200)
    async refresh(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ) {
        assertTrustedOrigin(req);
        this.authLimiter.consume(`refresh:${req.ip}`);

        const refreshToken = readRefreshCookie(req);

        if (!refreshToken) {
            throw new UnauthorizedException('No session');
        }

        try {
            const session = await this.gatewayService.refreshSession({
                refreshToken,
                meta: sessionMeta(req),
            });

            return this.startSession(res, session);
        } catch (error) {
            if (error instanceof UnauthorizedException) {
                clearRefreshCookie(res);
            }

            throw error;
        }
    }

    @Post('auth/logout')
    @HttpCode(200)
    async logout(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ) {
        assertTrustedOrigin(req);

        const refreshToken = readRefreshCookie(req);

        clearRefreshCookie(res);

        if (refreshToken) {
            await this.gatewayService.logout({ refreshToken }).catch(() => undefined);
        }

        return { success: true };
    }

    @Post('auth/logout-all')
    @HttpCode(200)
    async logoutAll(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
        @Headers('authorization') authorization?: string,
    ) {
        assertTrustedOrigin(req);

        const user = await this.getUserFromAuthorizationHeader(authorization);

        clearRefreshCookie(res);

        return this.gatewayService.logoutAll(user.id);
    }

    @Post('auth/verify')
    verify(@Body() body: { token: string }) {
        return this.gatewayService.verifyToken(body?.token);
    }

    @Get('auth/me')
    me(@Headers('authorization') authorization?: string) {
        return this.getUserFromAuthorizationHeader(authorization);
    }

    /** Moves the refresh token into the cookie; the body never carries it. */
    private startSession(
        res: Response,
        session: {
            accessToken: string;
            refreshToken: string;
            refreshTokenExpiresAt: string | Date;
            user: unknown;
        },
    ) {
        setRefreshCookie(res, session.refreshToken, session.refreshTokenExpiresAt);

        return {
            accessToken: session.accessToken,
            user: session.user,
        };
    }

    // =========================================
    // Community: news, feedback and proposals
    // =========================================
    //
    // Reading is public. Writing needs a signed-in user; only admins
    // (COMMUNITY_ADMIN_WALLETS) can publish news, set statuses and pin.

    private readonly postLimiter = new RateLimiter(6, 10 * 60_000);
    private readonly commentLimiter = new RateLimiter(30, 10 * 60_000);
    private readonly voteLimiter = new RateLimiter(60, 60_000);

    @Get('community/permissions')
    async communityPermissions(@Headers('authorization') authorization?: string) {
        const user = await this.getOptionalUser(authorization);
        return this.gatewayService.communityPermissions(user?.id);
    }

    @Get('community/posts')
    async listCommunityPosts(
        @Headers('authorization') authorization: string | undefined,
        @Query('kind') kind?: string,
        @Query('sort') sort?: string,
        @Query('status') status?: string,
        @Query('offset') offset?: string,
    ) {
        const user = await this.getOptionalUser(authorization);
        return this.gatewayService.listCommunityPosts({
            kind,
            sort,
            status,
            offset: offset ? Number(offset) : 0,
            viewerId: user?.id,
        });
    }

    @Get('community/posts/:id')
    async getCommunityPost(
        @Headers('authorization') authorization: string | undefined,
        @Param('id') postId: string,
    ) {
        const user = await this.getOptionalUser(authorization);
        return this.gatewayService.getCommunityPost(postId, user?.id);
    }

    @Post('community/posts')
    async createCommunityPost(
        @Headers('authorization') authorization: string,
        @Body() body: { kind: string; title: string; body: string },
    ) {
        const user = await this.getUserFromAuthorizationHeader(authorization);
        this.postLimiter.consume(`post:${user.id}`);

        return this.gatewayService.createCommunityPost({
            userId: user.id,
            kind: body?.kind,
            title: body?.title,
            body: body?.body,
        });
    }

    @Patch('community/posts/:id')
    async updateCommunityPost(
        @Headers('authorization') authorization: string,
        @Param('id') postId: string,
        @Body() body: { title?: string; body?: string; status?: string; pinned?: boolean },
    ) {
        const user = await this.getUserFromAuthorizationHeader(authorization);

        return this.gatewayService.updateCommunityPost({
            userId: user.id,
            postId,
            title: body?.title,
            body: body?.body,
            status: body?.status,
            pinned: body?.pinned,
        });
    }

    @Delete('community/posts/:id')
    async deleteCommunityPost(
        @Headers('authorization') authorization: string,
        @Param('id') postId: string,
    ) {
        const user = await this.getUserFromAuthorizationHeader(authorization);
        return this.gatewayService.deleteCommunityPost(user.id, postId);
    }

    @Post('community/posts/:id/comments')
    async addCommunityComment(
        @Headers('authorization') authorization: string,
        @Param('id') postId: string,
        @Body() body: { body: string },
    ) {
        const user = await this.getUserFromAuthorizationHeader(authorization);
        this.commentLimiter.consume(`comment:${user.id}`);

        return this.gatewayService.addCommunityComment({ userId: user.id, postId, body: body?.body });
    }

    @Delete('community/comments/:id')
    async deleteCommunityComment(
        @Headers('authorization') authorization: string,
        @Param('id') commentId: string,
    ) {
        const user = await this.getUserFromAuthorizationHeader(authorization);
        return this.gatewayService.deleteCommunityComment(user.id, commentId);
    }

    @Post('community/posts/:id/vote')
    @HttpCode(200)
    async toggleCommunityVote(
        @Headers('authorization') authorization: string,
        @Param('id') postId: string,
    ) {
        const user = await this.getUserFromAuthorizationHeader(authorization);
        this.voteLimiter.consume(`vote:${user.id}`);

        return this.gatewayService.toggleCommunityVote(user.id, postId);
    }

    /** The signed-in user if a valid token was sent; otherwise undefined. */
    private async getOptionalUser(authorization?: string): Promise<{ id: string } | undefined> {
        if (!authorization) return undefined;

        try {
            return await this.getUserFromAuthorizationHeader(authorization);
        } catch {
            return undefined;
        }
    }

    // =========================================
    // Workspace management
    // =========================================

    /** Project templates a new workspace can start from. Public, static. */
    @Get('workspace-templates')
    listWorkspaceTemplates() {
        return WORKSPACE_TEMPLATES;
    }

    @Post('workspaces')
    async createWorkspace(
        @Headers('authorization')
        authorization: string,

        @Body()
        body: {
            name: string;
            templateId?: string;
        },
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        if (body.templateId && !findTemplate(body.templateId)) {
            throw new BadRequestException(`Unknown project template: ${body.templateId}`);
        }

        return this.gatewayService.createWorkspace({
            userId: user.id,
            name: body.name,
            templateId: body.templateId,
        });
    }

    @Get('workspaces')
    async findMyWorkspaces(
        @Headers('authorization')
        authorization: string,
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.findMyWorkspaces(
            user.id,
        );
    }

    @Get('workspaces/:id')
    async findOneWorkspace(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.findOneWorkspace(
            user.id,
            workspaceId,
        );
    }

    @Delete('workspaces/:id')
    async deleteWorkspace(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.deleteWorkspace(
            user.id,
            workspaceId,
        );
    }

    // =========================================
    // Workspace runtime
    // =========================================

    @Post('workspaces/:id/start')
    async startWorkspace(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.startWorkspace(
            user.id,
            workspaceId,
        );
    }

    /** Sent by the open IDE tab; keeps the workspace from being stopped as idle. */
    @Post('workspaces/:id/heartbeat')
    @HttpCode(200)
    async workspaceHeartbeat(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.workspaceHeartbeat(
            user.id,
            workspaceId,
        );
    }

    /** Starts the workspace's CKB devnet (devnets start on demand). */
    @Post('workspaces/:id/devnet/start')
    async startDevnet(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.startDevnet(
            user.id,
            workspaceId,
        );
    }

    // =========================================
    // Contracts and deployments
    // =========================================

    /** Contract binaries in the project's build/release folder. */
    @Get('workspaces/:id/contracts')
    async listContracts(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
    ) {
        const user = await this.getUserFromAuthorizationHeader(authorization);
        return this.gatewayService.listContracts(user.id, workspaceId);
    }

    /** A built binary as base64, for deploys signed in the user's wallet. */
    @Get('workspaces/:id/contracts/:name/binary')
    async contractBinary(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
        @Param('name') name: string,
    ) {
        const user = await this.getUserFromAuthorizationHeader(authorization);
        return this.gatewayService.contractBinary(user.id, workspaceId, name);
    }

    @Get('workspaces/:id/deployments')
    async listDeployments(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
    ) {
        const user = await this.getUserFromAuthorizationHeader(authorization);
        return this.gatewayService.listDeployments(user.id, workspaceId);
    }

    /** Deploys a built contract to the workspace devnet. */
    @Post('workspaces/:id/deployments/devnet')
    async deployDevnet(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
        @Body() body: { contract?: string; upgradable?: boolean },
    ) {
        const user = await this.getUserFromAuthorizationHeader(authorization);
        return this.gatewayService.deployDevnet(user.id, workspaceId, String(body?.contract ?? ''), body?.upgradable !== false);
    }

    /** Records a deploy the user signed in their wallet (testnet). */
    @Post('workspaces/:id/deployments')
    async recordDeployment(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
        @Body() body: Record<string, unknown>,
    ) {
        const user = await this.getUserFromAuthorizationHeader(authorization);
        return this.gatewayService.recordDeployment(user.id, workspaceId, body ?? {});
    }

    // =========================================
    // Debugger
    // =========================================

    /** Runs a built contract on its own in ckb-debugger. */
    @Post('workspaces/:id/debug/run')
    @HttpCode(200)
    async debugRunContract(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
        @Body() body: { contract?: string },
    ) {
        const user = await this.getUserFromAuthorizationHeader(authorization);
        return this.gatewayService.debugRunContract(user.id, workspaceId, String(body?.contract ?? ''));
    }

    /** Recent devnet transactions (including rejected ones sent via the RPC proxy). */
    @Get('workspaces/:id/debug/transactions')
    async debugTransactions(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
    ) {
        const user = await this.getUserFromAuthorizationHeader(authorization);
        return this.gatewayService.debugTransactions(user.id, workspaceId);
    }

    /** Replays every script of a devnet transaction. */
    @Post('workspaces/:id/debug/tx')
    @HttpCode(200)
    async debugTransaction(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
        @Body() body: { txHash?: string; replace?: unknown },
    ) {
        const user = await this.getUserFromAuthorizationHeader(authorization);
        const replace = Array.isArray(body?.replace) ? body.replace.filter((n): n is string => typeof n === 'string').slice(0, 10) : [];
        return this.gatewayService.debugTransaction(user.id, workspaceId, String(body?.txHash ?? ''), replace);
    }

    /** Generates Rust or C bindings for a Molecule schema, next to it. */
    @Post('workspaces/:id/molecule/generate')
    @HttpCode(200)
    async generateMolecule(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
        @Body() body: { path?: unknown; language?: unknown },
    ) {
        const user = await this.getUserFromAuthorizationHeader(authorization);
        return this.gatewayService.generateMolecule(user.id, workspaceId, String(body?.path ?? ''), body?.language === 'c' ? 'c' : 'rust');
    }

    // =========================================
    // Devnet tools
    // =========================================

    /** The devnet's pre-funded test accounts, with balances. */
    @Get('workspaces/:id/devnet/accounts')
    async devnetAccounts(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
    ) {
        const user = await this.getUserFromAuthorizationHeader(authorization);
        return this.gatewayService.devnetAccounts(user.id, workspaceId);
    }

    /** Devnet system scripts in CCC's format. */
    @Get('workspaces/:id/devnet/scripts')
    async devnetScripts(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
    ) {
        const user = await this.getUserFromAuthorizationHeader(authorization);
        return this.gatewayService.devnetScripts(user.id, workspaceId);
    }

    /** Relays one JSON-RPC call to the workspace devnet (allow-listed methods). */
    @Post('workspaces/:id/devnet/rpc')
    @HttpCode(200)
    async devnetRpc(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
        @Body() body: unknown,
    ) {
        const user = await this.getUserFromAuthorizationHeader(authorization);
        return this.gatewayService.devnetRpc(user.id, workspaceId, body);
    }

    /** Stops the devnet node; its chain data is kept. */
    @Post('workspaces/:id/devnet/stop')
    async stopDevnet(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.stopDevnet(
            user.id,
            workspaceId,
        );
    }

    /** Live devnet facts (tip, recent blocks, tx pool) for the Nodes page. */
    @Get('workspaces/:id/devnet')
    async getDevnetInfo(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.getDevnetInfo(
            user.id,
            workspaceId,
        );
    }

    @Post('workspaces/:id/stop')
    async stopWorkspace(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.stopWorkspace(
            user.id,
            workspaceId,
        );
    }

    @Get('workspaces/:id/status')
    async getWorkspaceStatus(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.getWorkspaceStatus(
            user.id,
            workspaceId,
        );
    }

    @Post('workspaces/:id/reset')
    async resetWorkspace(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.resetWorkspace(
            user.id,
            workspaceId,
        );
    }

    @Delete('workspaces/:id/runtime')
    async deleteWorkspaceRuntime(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,

        @Query('deleteWorkspaceFiles')
        deleteWorkspaceFiles?: string,

        @Query('deleteCkbData')
        deleteCkbData?: string,
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.deleteWorkspaceRuntime(
            user.id,
            workspaceId,
            this.parseBooleanQuery(
                deleteWorkspaceFiles,
                true,
            ),
            this.parseBooleanQuery(
                deleteCkbData,
                true,
            ),
        );
    }

    @Post('workspaces/:id/execute')
    async executeRuntimeCommand(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,

        @Body()
        body: {
            command: string[];
            workingDirectory?: string;
        },
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.executeRuntimeCommand(
            user.id,
            workspaceId,
            body.command,
            body.workingDirectory,
        );
    }

    @Post('workspaces/:id/build')
    async buildWorkspace(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.buildWorkspace(
            user.id,
            workspaceId,
        );
    }

    @Post('workspaces/:id/test')
    async testWorkspace(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.testWorkspace(
            user.id,
            workspaceId,
        );
    }

    @Post('workspaces/:id/run-contract')
    async runContract(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.runContract(
            user.id,
            workspaceId,
        );
    }

    // =========================================
    // Workspace files
    // =========================================

    @Get('workspaces/:id/files')
    async listFiles(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.listFiles(
            user.id,
            workspaceId,
        );
    }

    @Get('workspaces/:id/files/content')
    async readFile(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,

        @Query('path')
        path: string,
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.readFile(
            user.id,
            workspaceId,
            path,
        );
    }

    @Post('workspaces/:id/files')
    async createFile(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,

        @Body()
        body: {
            path: string;
            content?: string;
        },
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.createFile(
            user.id,
            workspaceId,
            body.path,
            body.content ?? '',
        );
    }

    @Put('workspaces/:id/files')
    async updateFile(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,

        @Body()
        body: {
            path: string;
            content: string;
        },
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.updateFile(
            user.id,
            workspaceId,
            body.path,
            body.content,
        );
    }

    @Delete('workspaces/:id/files')
    async deleteFile(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,

        @Query('path')
        path: string,
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.deleteFile(
            user.id,
            workspaceId,
            path,
        );
    }

    @Post('workspaces/:id/directories')
    async createDirectory(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,

        @Body()
        body: {
            path: string;
        },
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.createDirectory(
            user.id,
            workspaceId,
            body.path,
        );
    }

    @Put('workspaces/:id/files/rename')
    async renameFile(
        @Headers('authorization')
        authorization: string,

        @Param('id')
        workspaceId: string,

        @Body()
        body: {
            oldPath: string;
            newPath: string;
        },
    ) {
        const user =
            await this.getUserFromAuthorizationHeader(
                authorization,
            );

        return this.gatewayService.renameFile(
            user.id,
            workspaceId,
            body.oldPath,
            body.newPath,
        );
    }

    // =========================================
    // Health
    // =========================================

    @Get('health')
    health() {
        return {
            status: 'ok',
            service: 'api-gateway',
            timestamp: new Date().toISOString(),
        };
    }

    @Get('health/runtime')
    runtimeHealth() {
        return this.gatewayService.runtimeHealth();
    }

    // =========================================
    // Private helpers
    // =========================================

    private async getUserFromAuthorizationHeader(
        authorization?: string,
    ) {
        if (!authorization) {
            throw new UnauthorizedException(
                'Missing authorization header',
            );
        }

        const [scheme, token] =
            authorization.trim().split(/\s+/);

        if (
            scheme?.toLowerCase() !== 'bearer' ||
            !token
        ) {
            throw new UnauthorizedException(
                'Invalid authorization header',
            );
        }

        const result: any =
            await this.gatewayService.verifyToken(
                token,
            );

        if (!result?.user) {
            throw new UnauthorizedException(
                'Invalid authentication response',
            );
        }

        return result.user;
    }

    private parseBooleanQuery(
        value: string | undefined,
        defaultValue: boolean,
    ): boolean {
        if (value === undefined) {
            return defaultValue;
        }

        const normalized =
            value.trim().toLowerCase();

        if (
            normalized === 'true' ||
            normalized === '1'
        ) {
            return true;
        }

        if (
            normalized === 'false' ||
            normalized === '0'
        ) {
            return false;
        }

        return defaultValue;
    }
}
