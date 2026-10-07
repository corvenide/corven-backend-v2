// apps/api-gateway/src/api-gateway.service.ts

import {
    BadRequestException,
    ConflictException,
    HttpException,
    ForbiddenException,
    GatewayTimeoutException,
    Inject,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';

import {
    ClientProxy,
} from '@nestjs/microservices';

import {
    catchError,
    firstValueFrom,
    throwError,
    timeout,
    TimeoutError,
} from 'rxjs';

interface SessionMeta {
    userAgent?: string;
    ipAddress?: string;
}

export interface AuthSession {
    accessToken: string;
    refreshToken: string;
    refreshTokenExpiresAt: string;
    user: unknown;
    /** Workspaces a guest brought along when they signed in. */
    claimedWorkspaces?: unknown[];
}

@Injectable()
export class ApiGatewayService {
    constructor(
        @Inject('AUTH_SERVICE')
        private readonly authClient: ClientProxy,

        @Inject('WORKSPACE_SERVICE')
        private readonly workspaceClient: ClientProxy,

        @Inject('FILE_SERVICE')
        private readonly fileClient: ClientProxy,

        @Inject('RUNTIME_SERVICE')
        private readonly runtimeClient: ClientProxy,
    ) { }

    // =========================================
    // Authentication
    // =========================================

    createWalletChallenge(data: { walletAddress: string }) {
        return this.sendToAuthService('auth.wallet.challenge', data);
    }

    guestStart(data: { meta: SessionMeta }) {
        return this.sendToAuthService<AuthSession>('auth.guest', data);
    }

    walletLogin(data: {
        walletAddress: string;
        challengeId: string;
        signature: unknown;
        meta: SessionMeta;
        guestToken?: string;
    }) {
        // Signature verification can call out to public CKB nodes for
        // known-script lookups, so allow a little longer than default.
        return this.sendToAuthService<AuthSession>('auth.wallet.login', data, 15_000);
    }

    googleLogin(data: { credential: string; meta: SessionMeta; guestToken?: string }) {
        // Verifying the ID token may fetch Google's signing keys.
        return this.sendToAuthService<AuthSession>('auth.google.login', data, 15_000);
    }

    // ---- Corven wallets (Google users)

    listWallets(userId: string) {
        // Reads balances from public CKB nodes.
        return this.sendToAuthService('wallet.list', { userId }, 20_000);
    }

    walletTransfer(userId: string, body: Record<string, unknown>) {
        return this.sendToAuthService('wallet.transfer', { network: body.network, to: body.to, amountCkb: body.amountCkb, confirmation: body.confirmation, userId }, 60_000);
    }

    walletSignTestnet(userId: string, transaction: unknown) {
        return this.sendToAuthService('wallet.sign-testnet', { userId, transaction }, 30_000);
    }

    walletExport(userId: string, body: Record<string, unknown>) {
        return this.sendToAuthService('wallet.export', { network: body.network, confirmation: body.confirmation, userId }, 15_000);
    }

    register(data: { name: string; email: string; password: string; meta: SessionMeta }) {
        return this.sendToAuthService<AuthSession>('auth.register', data);
    }

    login(data: { email: string; password: string; meta: SessionMeta }) {
        return this.sendToAuthService<AuthSession>('auth.login', data);
    }

    refreshSession(data: { refreshToken: string; meta: SessionMeta }) {
        return this.sendToAuthService<AuthSession>('auth.refresh', data);
    }

    logout(data: { refreshToken: string }) {
        return this.sendToAuthService('auth.logout', data);
    }

    logoutAll(userId: string) {
        return this.sendToAuthService('auth.logout-all', { userId });
    }

    verifyToken(token: string) {
        return this.sendToAuthService<{ valid: boolean; user: { id: string } }>(
            'auth.verify',
            { token },
        );
    }

    getProfile(userId: string) {
        return this.sendToAuthService('auth.profile', { userId });
    }

    // =========================================
    // Workspace service
    // =========================================

    createWorkspace(data: {
        userId: string;
        name: string;
        templateId?: string;
        temporary?: boolean;
        guest?: boolean;
    }) {
        return this.send(
            this.workspaceClient,
            'workspace.create',
            data,
        );
    }

    setWorkspaceTemporary(data: { userId: string; workspaceId: string; temporary: boolean; guest?: boolean }) {
        return this.send(this.workspaceClient, 'workspace.setTemporary', data);
    }

    findMyWorkspaces(userId: string) {
        return this.send(
            this.workspaceClient,
            'workspace.findMine',
            {
                userId,
            },
        );
    }

    findOneWorkspace(
        userId: string,
        workspaceId: string,
    ) {
        return this.send(
            this.workspaceClient,
            'workspace.findOne',
            {
                userId,
                workspaceId,
            },
        );
    }

    /**
     * Deletes the complete workspace record.
     *
     * The workspace service should call runtime.delete
     * before deleting the workspace database record.
     */
    deleteWorkspace(
        userId: string,
        workspaceId: string,
    ) {
        return this.send(
            this.workspaceClient,
            'workspace.delete',
            {
                userId,
                workspaceId,
            },
            15 * 60 * 1_000,
        );
    }

    // =========================================
    // Runtime service
    // =========================================

    startWorkspace(
        userId: string,
        workspaceId: string,
    ) {
        return this.send(
            this.runtimeClient,
            'runtime.start',
            {
                userId,
                workspaceId,
            },
            // Returns as soon as the start is claimed; provisioning continues
            // in the background and is followed via runtime.status.
            30_000,
        );
    }

    workspaceHeartbeat(
        userId: string,
        workspaceId: string,
    ) {
        return this.send(
            this.runtimeClient,
            'runtime.heartbeat',
            { userId, workspaceId },
            10_000,
        );
    }

    resolvePreview(
        userId: string,
        workspaceId: string,
        port: number,
    ) {
        return this.send(
            this.runtimeClient,
            'runtime.preview.resolve',
            { userId, workspaceId, port },
            10_000,
        );
    }

    startDevnet(
        userId: string,
        workspaceId: string,
    ) {
        return this.send(
            this.runtimeClient,
            'runtime.devnet.start',
            { userId, workspaceId },
            60_000,
        );
    }

    stopDevnet(
        userId: string,
        workspaceId: string,
    ) {
        return this.send(
            this.runtimeClient,
            'runtime.devnet.stop',
            { userId, workspaceId },
            30_000,
        );
    }

    getDevnetInfo(
        userId: string,
        workspaceId: string,
    ) {
        return this.send(
            this.runtimeClient,
            'runtime.devnet.info',
            { userId, workspaceId },
            15_000,
        );
    }

    listContracts(userId: string, workspaceId: string) {
        return this.send(this.runtimeClient, 'runtime.contracts.list', { userId, workspaceId }, 15_000);
    }

    contractBinary(userId: string, workspaceId: string, contract: string) {
        return this.send(this.runtimeClient, 'runtime.contracts.binary', { userId, workspaceId, contract }, 30_000);
    }

    deployDevnet(userId: string, workspaceId: string, contract: string, upgradable: boolean) {
        // offckb waits for the transaction to be committed.
        return this.send(this.runtimeClient, 'runtime.deploy.devnet', { userId, workspaceId, contract, upgradable }, 180_000);
    }

    devnetAccounts(userId: string, workspaceId: string) {
        return this.send(this.runtimeClient, 'runtime.devnet.accounts', { userId, workspaceId }, 30_000);
    }

    devnetScripts(userId: string, workspaceId: string) {
        return this.send(this.runtimeClient, 'runtime.devnet.scripts', { userId, workspaceId }, 30_000);
    }

    devnetRpc(userId: string, workspaceId: string, request: unknown) {
        return this.send(this.runtimeClient, 'runtime.devnet.rpc', { userId, workspaceId, request }, 70_000);
    }

    debugRunContract(userId: string, workspaceId: string, contract: string) {
        return this.send(this.runtimeClient, 'runtime.debug.run', { userId, workspaceId, contract }, 90_000);
    }

    debugTransactions(userId: string, workspaceId: string) {
        return this.send(this.runtimeClient, 'runtime.debug.transactions', { userId, workspaceId }, 20_000);
    }

    debugTransaction(userId: string, workspaceId: string, txHash: string, replace: string[]) {
        // Loads the transaction and runs each of its scripts.
        return this.send(this.runtimeClient, 'runtime.debug.tx', { userId, workspaceId, txHash, replace }, 240_000);
    }

    generateMolecule(userId: string, workspaceId: string, path: string, language: 'rust' | 'c') {
        return this.send(this.runtimeClient, 'runtime.molecule.generate', { userId, workspaceId, path, language }, 60_000);
    }

    listDeployments(userId: string, workspaceId: string) {
        return this.send(this.runtimeClient, 'runtime.deployments.list', { userId, workspaceId }, 15_000);
    }

    recordDeployment(userId: string, workspaceId: string, body: Record<string, unknown>) {
        return this.send(this.runtimeClient, 'runtime.deployments.record', { ...body, userId, workspaceId }, 15_000);
    }

    stopWorkspace(
        userId: string,
        workspaceId: string,
    ) {
        return this.send(
            this.runtimeClient,
            'runtime.stop',
            {
                userId,
                workspaceId,
            },
            60_000,
        );
    }

    getWorkspaceStatus(
        userId: string,
        workspaceId: string,
    ) {
        return this.send(
            this.runtimeClient,
            'runtime.status',
            {
                userId,
                workspaceId,
            },
            30_000,
        );
    }

    deleteWorkspaceRuntime(
        userId: string,
        workspaceId: string,
        deleteWorkspaceFiles = true,
        deleteCkbData = true,
    ) {
        return this.send(
            this.runtimeClient,
            'runtime.delete',
            {
                userId,
                workspaceId,
                deleteWorkspaceFiles,
                deleteCkbData,
            },
            60_000,
        );
    }

    resetWorkspace(
        userId: string,
        workspaceId: string,
    ) {
        return this.send(
            this.runtimeClient,
            'runtime.reset',
            {
                userId,
                workspaceId,
            },
            // Removing the old containers and volumes, then claiming a start.
            2 * 60 * 1_000,
        );
    }

    executeRuntimeCommand(
        userId: string,
        workspaceId: string,
        command: string[],
        workingDirectory?: string,
    ) {
        if (
            !Array.isArray(command) ||
            command.length === 0
        ) {
            throw new BadRequestException(
                'Command must contain at least one argument',
            );
        }

        return this.send(
            this.runtimeClient,
            'runtime.execute',
            {
                userId,
                workspaceId,
                command,
                workingDirectory,
            },
            10 * 60 * 1_000,
        );
    }

    buildWorkspace(
        userId: string,
        workspaceId: string,
    ) {
        return this.send(
            this.runtimeClient,
            'runtime.build',
            {
                userId,
                workspaceId,
            },
            15 * 60 * 1_000,
        );
    }

    testWorkspace(
        userId: string,
        workspaceId: string,
    ) {
        return this.send(
            this.runtimeClient,
            'runtime.test',
            {
                userId,
                workspaceId,
            },
            15 * 60 * 1_000,
        );
    }

    runContract(
        userId: string,
        workspaceId: string,
    ) {
        return this.send(
            this.runtimeClient,
            'runtime.run-contract',
            {
                userId,
                workspaceId,
            },
            5 * 60 * 1_000,
        );
    }

    runtimeHealth() {
        return this.send(
            this.runtimeClient,
            'runtime.health',
            {},
            10_000,
        );
    }

    // =========================================
    // File service
    // =========================================

    listFiles(
        userId: string,
        workspaceId: string,
    ) {
        return this.send(
            this.fileClient,
            'file.list',
            {
                userId,
                workspaceId,
            },
        );
    }

    readFile(
        userId: string,
        workspaceId: string,
        path: string,
    ) {
        return this.send(
            this.fileClient,
            'file.read',
            {
                userId,
                workspaceId,
                path,
            },
        );
    }

    createFile(
        userId: string,
        workspaceId: string,
        path: string,
        content: string,
    ) {
        return this.send(
            this.fileClient,
            'file.create',
            {
                userId,
                workspaceId,
                path,
                content,
            },
        );
    }

    updateFile(
        userId: string,
        workspaceId: string,
        path: string,
        content: string,
    ) {
        return this.send(
            this.fileClient,
            'file.update',
            {
                userId,
                workspaceId,
                path,
                content,
            },
        );
    }

    deleteFile(
        userId: string,
        workspaceId: string,
        path: string,
    ) {
        return this.send(
            this.fileClient,
            'file.delete',
            {
                userId,
                workspaceId,
                path,
            },
        );
    }

    createDirectory(
        userId: string,
        workspaceId: string,
        path: string,
    ) {
        return this.send(
            this.fileClient,
            'file.mkdir',
            {
                userId,
                workspaceId,
                path,
            },
        );
    }

    renameFile(
        userId: string,
        workspaceId: string,
        oldPath: string,
        newPath: string,
    ) {
        return this.send(
            this.fileClient,
            'file.rename',
            {
                userId,
                workspaceId,
                oldPath,
                newPath,
            },
        );
    }

    // =========================================
    // Community (news, feedback, proposals)
    // =========================================

    communityPermissions(userId?: string) {
        return this.sendToAuthService<{ isAdmin: boolean }>('community.permissions', { userId });
    }

    listCommunityPosts(query: { kind?: string; sort?: string; status?: string; offset?: number; viewerId?: string }) {
        return this.sendToAuthService('community.posts.list', query, 10_000);
    }

    getCommunityPost(postId: string, viewerId?: string) {
        return this.sendToAuthService('community.posts.get', { postId, viewerId }, 10_000);
    }

    createCommunityPost(data: { userId: string; kind: string; title: string; body: string }) {
        return this.sendToAuthService('community.posts.create', data, 10_000);
    }

    updateCommunityPost(data: {
        userId: string;
        postId: string;
        title?: string;
        body?: string;
        status?: string;
        pinned?: boolean;
    }) {
        return this.sendToAuthService('community.posts.update', data, 10_000);
    }

    deleteCommunityPost(userId: string, postId: string) {
        return this.sendToAuthService('community.posts.delete', { userId, postId });
    }

    addCommunityComment(data: { userId: string; postId: string; body: string }) {
        return this.sendToAuthService('community.comments.create', data);
    }

    deleteCommunityComment(userId: string, commentId: string) {
        return this.sendToAuthService('community.comments.delete', { userId, commentId });
    }

    toggleCommunityVote(userId: string, postId: string) {
        return this.sendToAuthService('community.posts.vote', { userId, postId });
    }

    // =========================================
    // Transport helpers
    // =========================================

    private async sendToAuthService<T = unknown>(
        cmd: string,
        payload: unknown,
        timeoutMs = 5_000,
    ): Promise<T> {
        return this.send<T>(
            this.authClient,
            cmd,
            payload,
            timeoutMs,
        );
    }

    private async send<T = unknown>(
        client: ClientProxy,
        cmd: string,
        payload: unknown,
        timeoutMs = 5_000,
    ): Promise<T> {
        return firstValueFrom(
            client
                .send<T>(
                    {
                        cmd,
                    },
                    payload,
                )
                .pipe(
                    timeout(timeoutMs),

                    catchError((error: unknown) => {
                        return throwError(
                            () =>
                                this.mapMicroserviceError(
                                    error,
                                    cmd,
                                ),
                        );
                    }),
                ),
        );
    }

    private mapMicroserviceError(
        error: unknown,
        command: string,
    ): Error {
        if (error instanceof TimeoutError) {
            return new GatewayTimeoutException(
                `Request to ${command} timed out`,
            );
        }

        const source =
            error as {
                message?: string;
                response?: {
                    message?: string | string[];
                    statusCode?: number;
                };
                statusCode?: number;
                code?: string;
            };

        const responseMessage =
            source?.response?.message;

        const message = Array.isArray(
            responseMessage,
        )
            ? responseMessage.join(', ')
            : responseMessage ??
            source?.message ??
            'Microservice unavailable';

        const statusCode =
            source?.response?.statusCode ??
            source?.statusCode;

        // Community calls report "not allowed" and "not found" precisely, so
        // the page can show them instead of treating them as a lost session.
        if (statusCode === 429) return new HttpException(message, 429);

        if (
            command.startsWith('community.') ||
            command.startsWith('wallet.') ||
            command === 'workspace.create' ||
            command === 'workspace.setTemporary'
        ) {
            if (statusCode === 403) return new ForbiddenException(message);
            if (statusCode === 404) return new NotFoundException(message);
        }

        if (
            statusCode === 401 ||
            statusCode === 403 ||
            /unauthorized|forbidden|invalid token|token expired/i.test(
                message,
            )
        ) {
            return new UnauthorizedException(
                message,
            );
        }

        if (statusCode === 409) return new ConflictException(message);
        if (statusCode === 503) return new ServiceUnavailableException(message);

        if (
            source?.code === 'ECONNREFUSED' ||
            source?.code === 'ECONNRESET'
        ) {
            return new ServiceUnavailableException(
                `${command} service is unavailable`,
            );
        }

        return new BadRequestException(
            message,
        );
    }
}
