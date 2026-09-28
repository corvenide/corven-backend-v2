// apps/terminal-service/src/terminal.gateway.ts
import {
    ConnectedSocket,
    MessageBody,
    OnGatewayConnection,
    OnGatewayDisconnect,
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { PassThrough } from 'stream';
import { v4 as uuidv4 } from 'uuid';

import { TerminalService } from './terminal-service.service';
import { DockerService } from './docker.service';
import { PrismaService } from 'libs/prisma/src/prisma.service';
import { recordWorkspaceActivity } from 'libs/prisma/src/workspace-activity';
import { type AuthenticatedSocket } from './terminal.types';

@WebSocketGateway({
    namespace: '/terminal',
    cors: {
        origin: true,
        credentials: true,
    },
    transports: ['websocket'],
})
export class TerminalGateway
    implements OnGatewayConnection, OnGatewayDisconnect {
    private readonly logger = new Logger(
        TerminalGateway.name,
    );

    @WebSocketServer()
    server: Server;

    constructor(
        private readonly terminalService: TerminalService,
        private readonly dockerService: DockerService,
        private readonly prisma: PrismaService,
    ) { }

    async handleConnection(
        client: AuthenticatedSocket,
    ) {
        this.logger.log(`[${client.id}] Connection attempt`);
        try {
            const token = this.extractToken(client);
            this.logger.debug(`[${client.id}] Token extracted successfully`);

            client.user =
                await this.terminalService.verifyToken(token);

            this.logger.log(
                `[${client.id}] Client authenticated successfully for user: ${client?.user?.id}`,
            );

            client.emit('terminal:authenticated', {
                success: true,
                user: client.user,
            });
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : 'Unauthorized';

            this.logger.warn(
                `[${client.id}] Authentication failed: ${message}`,
            );

            client.emit('terminal:error', {
                message,
            });

            client.disconnect(true);
        }
    }

    handleDisconnect(client: AuthenticatedSocket) {
        this.logger.log(`[${client.id}] Client disconnecting`);

        if (client.terminalStream) {
            this.logger.debug(`[${client.id}] Closing terminal stream`);
            client.terminalStream.end();
            client.terminalStream.destroy();
        }

        if (client.currentTestRun?.stream) {
            this.logger.debug(`[${client.id}] Cleaning up test stream for run ${client.currentTestRun.runId}`);
            client.currentTestRun.stream.removeAllListeners();
        }

        if (client.currentTestRun) {
            this.logger.debug(`[${client.id}] Cleaning up test run ${client.currentTestRun.runId}`);
        }

        this.logger.log(
            `[${client.id}] Client disconnected successfully`,
        );
    }

    @SubscribeMessage('terminal:open')
    async openTerminal(
        @ConnectedSocket()
        client: AuthenticatedSocket,

        @MessageBody()
        payload: {
            workspaceId: string;
            cols?: number;
            rows?: number;
        },
    ) {
        this.logger.log(`[${client.id}] Opening terminal for workspace: ${payload.workspaceId}`);
        this.logger.debug(`[${client.id}] Terminal dimensions: ${payload.cols}x${payload.rows}`);

        if (!client.user) {
            this.logger.warn(`[${client.id}] Unauthenticated terminal open attempt`);
            client.emit('terminal:error', {
                message: 'Unauthenticated connection',
            });
            return;
        }

        if (client.terminalStream) {
            this.logger.debug(`[${client.id}] Closing existing terminal stream`);
            client.terminalStream.end();
            client.terminalStream.destroy();
        }

        try {
            const terminal =
                await this.terminalService.openTerminal(
                    client.user.id,
                    payload.workspaceId,
                );

            this.logger.log(`[${client.id}] Terminal opened with execId: ${terminal.execId}`);

            client.terminalStream = terminal.stream;
            client.terminalExecId = terminal.execId;
            client.workspaceId = payload.workspaceId;

            terminal.stream.on('data', (chunk: Buffer) => {
                client.emit(
                    'terminal:output',
                    chunk.toString('utf8'),
                );
            });

            terminal.stream.on('end', () => {
                this.logger.log(`[${client.id}] Terminal stream ended for workspace: ${payload.workspaceId}`);
                client.emit('terminal:closed', {
                    workspaceId: payload.workspaceId,
                });
            });

            terminal.stream.on('error', (error) => {
                this.logger.error(`[${client.id}] Terminal stream error: ${error.message}`);
                client.emit('terminal:error', {
                    message: error.message,
                });
            });

            client.emit('terminal:ready', {
                workspaceId: payload.workspaceId,
                execId: terminal.execId,
            });

            this.logger.debug(`[${client.id}] Terminal ready event emitted`);

            if (
                payload.cols &&
                payload.rows &&
                client.terminalExecId
            ) {
                this.logger.debug(`[${client.id}] Resizing terminal to ${payload.cols}x${payload.rows}`);
                await this.terminalService.resizeTerminal(
                    client.terminalExecId,
                    payload.cols,
                    payload.rows,
                );
                this.logger.debug(`[${client.id}] Terminal resized successfully`);
            }
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : 'Unable to open terminal';

            this.logger.error(`[${client.id}] Failed to open terminal: ${message}`);

            client.emit('terminal:error', {
                message,
            });
        }
    }

    @SubscribeMessage('terminal:input')
    writeInput(
        @ConnectedSocket()
        client: AuthenticatedSocket,

        @MessageBody()
        payload: {
            data: string;
        },
    ) {
        const inputLength = payload.data?.length || 0;
        this.logger.debug(`[${client.id}] Terminal input received: ${inputLength} characters`);

        if (!client.terminalStream) {
            this.logger.warn(`[${client.id}] Input attempted but terminal is not open`);
            client.emit('terminal:error', {
                message: 'Terminal is not open',
            });
            return;
        }

        client.terminalStream.write(payload.data);

        if (client.workspaceId) {
            void recordWorkspaceActivity(this.prisma, client.workspaceId);
        }
        this.logger.debug(`[${client.id}] Input written to terminal stream`);
    }

    @SubscribeMessage('terminal:resize')
    async resizeTerminal(
        @ConnectedSocket()
        client: AuthenticatedSocket,

        @MessageBody()
        payload: {
            cols: number;
            rows: number;
        },
    ) {
        this.logger.log(`[${client.id}] Resizing terminal to ${payload.cols}x${payload.rows}`);

        if (!client.terminalExecId) {
            this.logger.warn(`[${client.id}] Resize attempted but no terminal execId found`);
            return;
        }

        await this.terminalService.resizeTerminal(
            client.terminalExecId,
            payload.cols,
            payload.rows,
        );
        this.logger.debug(`[${client.id}] Terminal resized successfully`);
    }

    @SubscribeMessage('terminal:close')
    closeTerminal(
        @ConnectedSocket()
        client: AuthenticatedSocket,
    ) {
        this.logger.log(`[${client.id}] Closing terminal`);

        if (client.terminalStream) {
            this.logger.debug(`[${client.id}] Terminating terminal stream`);
            client.terminalStream.end();
            client.terminalStream.destroy();
            client.terminalStream = undefined;
        }

        client.terminalExecId = undefined;
        client.workspaceId = undefined;

        client.emit('terminal:closed', {
            success: true,
        });

        this.logger.debug(`[${client.id}] Terminal closed successfully`);
    }

    @SubscribeMessage('test:run')
    async runTests(
        @ConnectedSocket() client: AuthenticatedSocket,
        @MessageBody() payload: { workspaceId: string; command: string; cwd?: string; runId?: string },
    ) {
        this.logger.log(`[${client.id}] Test run requested: workspace=${payload.workspaceId}, command="${payload.command}"`);
        this.logger.debug(`[${client.id}] Test working directory: ${payload.cwd || '/workspace'}`);

        if (!client.user) {
            this.logger.warn(`[${client.id}] Unauthenticated test run attempt`);
            client.emit('test:error', { message: 'Unauthenticated' });
            return;
        }

        const { workspaceId, command, cwd } = payload;

        if (client.currentTestRun) {
            this.logger.warn(`[${client.id}] Test run already in progress: ${client.currentTestRun.runId}`);
            client.emit('test:error', { message: 'A test run is already in progress. Cancel it first.' });
            return;
        }

        try {
            this.logger.debug(`[${client.id}] Fetching workspace: ${workspaceId}`);
            const workspace = await this.prisma.workspace.findUnique({
                where: { id: workspaceId }
            });

            if (!workspace) {
                this.logger.warn(`[${client.id}] Workspace not found: ${workspaceId}`);
                throw new Error('Workspace not found');
            }
            if (workspace.userId !== client.user.id) {
                this.logger.warn(`[${client.id}] User ${client.user.id} does not own workspace ${workspaceId}`);
                throw new Error('You do not own this workspace');
            }
            if (workspace.status !== 'RUNNING') {
                this.logger.warn(`[${client.id}] Workspace ${workspaceId} is not running (status: ${workspace.status})`);
                throw new Error('Workspace runtime is not running');
            }

            void recordWorkspaceActivity(this.prisma, workspaceId, 0);
            this.logger.debug(`[${client.id}] Fetching runtime container for workspace: ${workspaceId}`);
            const runtimeContainer = await this.prisma.workspaceContainer.findUnique({
                where: {
                    workspaceId_type: {
                        workspaceId,
                        type: 'FIBER_RUNTIME',
                    },
                },
            });

            if (!runtimeContainer) {
                this.logger.warn(`[${client.id}] Runtime container not found for workspace: ${workspaceId}`);
                throw new Error('Runtime container not found');
            }

            const container = await this.dockerService.getContainer(runtimeContainer.containerId);
            const details = await container.inspect();

            if (!details.State.Running) {
                this.logger.warn(`[${client.id}] Runtime container is stopped for workspace: ${workspaceId}`);
                throw new Error('Runtime container is stopped');
            }

            const workingDir = cwd ? `/workspace/${cwd.replace(/^\/+/, '')}` : '/workspace';
            this.logger.debug(`[${client.id}] Using working directory: ${workingDir}`);

            this.logger.debug(`[${client.id}] Creating Docker exec for tests`);
            const exec = await this.dockerService.createExec(
                runtimeContainer.containerId,
                {
                    AttachStdout: true,
                    AttachStderr: true,
                    Cmd: ['/bin/bash', '-c', command],
                    WorkingDir: workingDir,
                    Env: [
                        `WORKSPACE_ID=${workspaceId}`,
                        `USER_ID=${client.user.id}`,
                        'TERM=xterm-256color',
                    ],
                }
            );
            this.logger.debug(`[${client.id}] Docker exec created successfully`);

            this.logger.debug(`[${client.id}] Starting Docker exec stream`);
            // Use hijack:true to get the raw multiplexed stream from Docker.
            // We must demux it ourselves; otherwise the 'end' event is unreliable
            // and the process appears to run forever.
            const rawStream = await this.dockerService.startExec(exec, {
                hijack: true,
                stdin: false,
            });
            this.logger.debug(`[${client.id}] Docker exec stream started, demuxing`);

            // Demux the Docker multiplexed stream into separate stdout/stderr streams.
            const stdoutStream = new PassThrough();
            const stderrStream = new PassThrough();
            this.dockerService.demuxStream(rawStream, stdoutStream, stderrStream);

            const runId = payload.runId || uuidv4();
            client.currentTestRun = { runId, exec, stream: rawStream, containerId: runtimeContainer.containerId };
            this.logger.log(`[${client.id}] Test run started with ID: ${runId}`);

            client.emit('test:started', {
                workspaceId,
                runId,
                startedAt: new Date().toISOString(),
            });
            this.logger.debug(`[${client.id}] Test started event emitted`);

            let outputBuffer = '';
            let streamsClosed = 0;
            const totalStreams = 2; // stdout + stderr

            const onData = (chunk: Buffer, streamName: 'stdout' | 'stderr') => {
                const data = chunk.toString('utf8');
                outputBuffer += data;
                this.logger.debug(`[${client.id}] Test ${streamName} received: ${data.length} chars`);
                client.emit('test:output', {
                    workspaceId,
                    runId,
                    stream: streamName,
                    data,
                });
            };

            let streamEnded = false;

            const onStreamEnd = () => {
                if (streamEnded) return;
                streamEnded = true;

                this.logger.log(`[${client.id}] Test streams ended for run ${runId}`);
                exec.inspect((err: any, inspectData: any) => {
                    const exitCode = inspectData?.ExitCode ?? 0;
                    this.logger.log(`[${client.id}] Test run ${runId} finished with exit code: ${exitCode}`);
                    this.logger.debug(`[${client.id}] Total output: ${outputBuffer.length} chars`);
                    // Guard: if already cancelled/cleaned up, skip
                    if (!client.currentTestRun || client.currentTestRun.runId !== runId) {
                        this.logger.debug(`[${client.id}] Run ${runId} already cleaned up, skipping finished event`);
                        return;
                    }
                    client.emit('test:finished', {
                        workspaceId,
                        runId,
                        exitCode,
                        finishedAt: new Date().toISOString(),
                    });
                    delete client.currentTestRun;
                    this.logger.debug(`[${client.id}] Test run ${runId} cleaned up`);
                });
            };

            const onError = (error: Error) => {
                this.logger.error(`[${client.id}] Test stream error for run ${runId}: ${error.message}`);
                if (!client.currentTestRun || client.currentTestRun.runId !== runId) return;
                client.emit('test:error', {
                    workspaceId,
                    runId,
                    message: error.message,
                });
                delete client.currentTestRun;
                this.logger.debug(`[${client.id}] Test run ${runId} cleaned up after error`);
            };

            stdoutStream.on('data', (chunk) => onData(chunk, 'stdout'));
            stderrStream.on('data', (chunk) => onData(chunk, 'stderr'));
            
            rawStream.on('end', onStreamEnd);
            rawStream.on('close', onStreamEnd);
            rawStream.on('error', onError);

        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to run tests';
            this.logger.error(`[${client.id}] Test run failed: ${message}`);
            client.emit('test:error', {
                workspaceId,
                message,
            });
            delete client.currentTestRun;
            this.logger.debug(`[${client.id}] Test run cleaned up after failure`);
        }
    }

    @SubscribeMessage('test:cancel')
    async cancelTests(
        @ConnectedSocket() client: AuthenticatedSocket,
        @MessageBody() payload: { workspaceId: string; runId: string },
    ) {
        this.logger.log(`[${client.id}] Test cancellation requested for run: ${payload.runId}`);

        if (!client.currentTestRun || client.currentTestRun.runId !== payload.runId) {
            this.logger.warn(`[${client.id}] No active test run found for ID: ${payload.runId}`);
            client.emit('test:error', { message: 'No active test run to cancel' });
            return;
        }

        const { exec, stream, runId, containerId } = client.currentTestRun;
        // Clean up immediately so the onStreamEnd callback is a no-op.
        delete client.currentTestRun;

        try {
            this.logger.debug(`[${client.id}] Cancelling test run: ${runId}`);

            // Stop listening on the raw stream so we don't get ghost events.
            if (stream) {
                stream.removeAllListeners();
                this.logger.debug(`[${client.id}] Test stream listeners removed`);
            }

            // Kill the running process in the container.
            // Docker exec has no direct kill API, so we send SIGKILL to the
            // exec's PID by inspecting and then using container.kill with a
            // targeted signal. The simplest reliable approach is a second
            // exec that kills all processes in the process group.
            try {
                const inspectData = await new Promise<any>((resolve, reject) =>
                    exec.inspect((err: any, data: any) => (err ? reject(err) : resolve(data)))
                );
                const pid: number | undefined = inspectData?.Pid;
                if (pid) {
                    const killExec = await this.dockerService.createExec(containerId, {
                        AttachStdout: false,
                        AttachStderr: false,
                        Cmd: ['kill', '-KILL', String(pid)],
                    });
                    await this.dockerService.startExec(killExec, { hijack: false, stdin: false });
                    this.logger.debug(`[${client.id}] Sent SIGKILL to PID ${pid}`);
                }
            } catch (killError) {
                // Non-fatal: process may have already finished.
                this.logger.debug(`[${client.id}] Exec kill skipped: ${killError}`);
            }

            client.emit('test:cancelled', {
                workspaceId: payload.workspaceId,
                runId,
            });
            this.logger.log(`[${client.id}] Test run ${runId} cancelled successfully`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to cancel';
            this.logger.error(`[${client.id}] Failed to cancel test run: ${message}`);
            client.emit('test:error', { message });
        }
    }

    @SubscribeMessage('projects:list')
    async listProjects(
        @ConnectedSocket() client: AuthenticatedSocket,
        @MessageBody() payload: { workspaceId: string },
    ) {
        this.logger.log(`[${client.id}] Listing projects for workspace: ${payload.workspaceId}`);

        if (!client.user) {
            this.logger.warn(`[${client.id}] Unauthenticated project list attempt`);
            client.emit('projects:error', { message: 'Unauthenticated' });
            return;
        }

        const { workspaceId } = payload;

        try {
            this.logger.debug(`[${client.id}] Fetching workspace: ${workspaceId}`);
            const workspace = await this.prisma.workspace.findUnique({
                where: { id: workspaceId }
            });

            if (!workspace) {
                this.logger.warn(`[${client.id}] Workspace not found: ${workspaceId}`);
                throw new Error('Workspace not found');
            }

            if (workspace.userId !== client.user.id) {
                this.logger.warn(`[${client.id}] User ${client.user.id} does not own workspace ${workspaceId}`);
                throw new Error('Unauthorized');
            }

            void recordWorkspaceActivity(this.prisma, workspaceId, 0);
            this.logger.debug(`[${client.id}] Fetching runtime container for workspace: ${workspaceId}`);
            const runtimeContainer = await this.prisma.workspaceContainer.findUnique({
                where: {
                    workspaceId_type: {
                        workspaceId,
                        type: 'FIBER_RUNTIME',
                    },
                },
            });

            if (!runtimeContainer) {
                this.logger.warn(`[${client.id}] Runtime container not found for workspace: ${workspaceId}`);
                throw new Error('Runtime container not found');
            }

            this.logger.debug(`[${client.id}] Creating exec to list projects`);
            const exec = await this.dockerService.createExec(
                runtimeContainer.containerId,
                {
                    AttachStdout: true,
                    AttachStderr: true,
                    Cmd: ['/bin/bash', '-c', 'ls -d */ 2>/dev/null || echo ""'],
                    WorkingDir: '/workspace',
                }
            );

            this.logger.debug(`[${client.id}] Starting exec to list projects`);
            const stream = await this.dockerService.startExec(exec, {
                hijack: true,
                stdin: false,
            });

            let output = '';

            stream.on('data', (chunk: Buffer) => {
                const data = chunk.toString('utf8');
                output += data;
                this.logger.debug(`[${client.id}] Project list data received: ${data.length} characters`);
            });

            stream.on('end', () => {
                const dirs = output
                    .split('\n')
                    .filter(line => line.trim().length > 0)
                    .map(dir => dir.replace(/\/$/, '').trim())
                    .filter(dir => dir.length > 0);

                this.logger.log(`[${client.id}] Found ${dirs.length} projects in workspace ${workspaceId}: ${dirs.join(', ')}`);

                client.emit('projects:list:response', {
                    workspaceId,
                    projects: dirs.length > 0 ? dirs : [],
                });
                this.logger.debug(`[${client.id}] Project list response emitted`);
            });

            stream.on('error', (error) => {
                this.logger.error(`[${client.id}] Error listing projects: ${error.message}`);
                client.emit('projects:error', {
                    message: error.message,
                });
            });

        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to list projects';
            this.logger.error(`[${client.id}] Failed to list projects: ${message}`);
            client.emit('projects:error', {
                message,
            });
        }
    }

    // apps/terminal-service/src/terminal.gateway.ts

    @SubscribeMessage('build:start')
    async startBuild(
        @ConnectedSocket() client: AuthenticatedSocket,
        @MessageBody() payload: { workspaceId: string; target?: string; cwd?: string; buildId?: string },
    ) {
        this.logger.log(`[${client.id}] Build requested: workspace=${payload.workspaceId}, target="${payload.target || 'default'}", cwd="${payload.cwd || 'default'}"`);

        if (!client.user) {
            this.logger.warn(`[${client.id}] Unauthenticated build attempt`);
            client.emit('build:error', { message: 'Unauthenticated' });
            return;
        }

        const { workspaceId, target, cwd } = payload;

        if (client.currentBuild) {
            this.logger.warn(`[${client.id}] Build already in progress: ${client.currentBuild.buildId}`);
            client.emit('build:error', { message: 'A build is already in progress. Cancel it first.' });
            return;
        }

        try {
            this.logger.debug(`[${client.id}] Fetching workspace: ${workspaceId}`);
            const workspace = await this.prisma.workspace.findUnique({
                where: { id: workspaceId }
            });

            if (!workspace) {
                this.logger.warn(`[${client.id}] Workspace not found: ${workspaceId}`);
                throw new Error('Workspace not found');
            }
            if (workspace.userId !== client.user.id) {
                this.logger.warn(`[${client.id}] User ${client.user.id} does not own workspace ${workspaceId}`);
                throw new Error('You do not own this workspace');
            }
            if (workspace.status !== 'RUNNING') {
                this.logger.warn(`[${client.id}] Workspace ${workspaceId} is not running (status: ${workspace.status})`);
                throw new Error('Workspace runtime is not running');
            }

            void recordWorkspaceActivity(this.prisma, workspaceId, 0);
            this.logger.debug(`[${client.id}] Fetching runtime container for workspace: ${workspaceId}`);
            const runtimeContainer = await this.prisma.workspaceContainer.findUnique({
                where: {
                    workspaceId_type: {
                        workspaceId,
                        type: 'FIBER_RUNTIME',
                    },
                },
            });

            if (!runtimeContainer) {
                this.logger.warn(`[${client.id}] Runtime container not found for workspace: ${workspaceId}`);
                throw new Error('Runtime container not found');
            }

            const container = await this.dockerService.getContainer(runtimeContainer.containerId);
            const details = await container.inspect();

            if (!details.State.Running) {
                this.logger.warn(`[${client.id}] Runtime container is stopped for workspace: ${workspaceId}`);
                throw new Error('Runtime container is stopped');
            }

            // Build working directory - support cwd parameter
            let workingDir = '/workspace';
            if (cwd) {
                // If cwd is provided, normalize it
                workingDir = `/workspace/${cwd.replace(/^\/+/, '')}`;
            } else {
                // Default to the first project directory
                try {
                    // Try to find a project directory
                    const listProjectsExec = await this.dockerService.createExec(
                        runtimeContainer.containerId,
                        {
                            AttachStdout: true,
                            AttachStderr: false,
                            Cmd: ['/bin/bash', '-c', 'ls -d */ 2>/dev/null | head -1 | sed "s|/||"'],
                            WorkingDir: '/workspace',
                        }
                    );
                    const stream = await this.dockerService.startExec(listProjectsExec, {
                        hijack: true,
                        stdin: false,
                    });

                    let projectName = '';
                    await new Promise<void>((resolve) => {
                        stream.on('data', (chunk: Buffer) => {
                            projectName = chunk.toString('utf8').trim();
                        });
                        stream.on('end', resolve);
                    });

                    if (projectName) {
                        workingDir = `/workspace/${projectName}`;
                        this.logger.debug(`[${client.id}] Auto-detected project directory: ${workingDir}`);
                    } else {
                        this.logger.debug(`[${client.id}] No project found, using /workspace`);
                    }
                } catch (error) {
                    this.logger.debug(`[${client.id}] Could not auto-detect project, using /workspace`);
                }
            }

            this.logger.debug(`[${client.id}] Using working directory: ${workingDir}`);

            // Determine build command based on target
            let buildCommand = 'make build';
            if (target === 'release') {
                buildCommand = 'make build-release';
            } else if (target === 'debug') {
                buildCommand = 'make build-debug';
            } else if (target && target !== 'Default Build') {
                buildCommand = `make build-${target.toLowerCase()}`;
            }

            this.logger.debug(`[${client.id}] Creating Docker exec for build: ${buildCommand}`);
            const exec = await this.dockerService.createExec(
                runtimeContainer.containerId,
                {
                    AttachStdout: true,
                    AttachStderr: true,
                    Cmd: ['/bin/bash', '-c', buildCommand],
                    WorkingDir: workingDir,
                    Env: [
                        `WORKSPACE_ID=${workspaceId}`,
                        `USER_ID=${client.user.id}`,
                        'TERM=xterm-256color',
                        'CARGO_TERM_COLOR=always',
                        'RUST_BACKTRACE=1',
                    ],
                }
            );
            this.logger.debug(`[${client.id}] Docker exec created successfully`);

            this.logger.debug(`[${client.id}] Starting Docker exec stream`);
            const rawStream = await this.dockerService.startExec(exec, {
                hijack: true,
                stdin: false,
            });
            this.logger.debug(`[${client.id}] Docker exec stream started, demuxing`);

            // Demux the Docker multiplexed stream into separate stdout/stderr streams.
            const stdoutStream = new PassThrough();
            const stderrStream = new PassThrough();
            this.dockerService.demuxStream(rawStream, stdoutStream, stderrStream);

            const buildId = payload.buildId || uuidv4();
            client.currentBuild = {
                buildId,
                exec,
                stream: rawStream,
                containerId: runtimeContainer.containerId,
                cwd: workingDir,
            };
            this.logger.log(`[${client.id}] Build started with ID: ${buildId}`);

            client.emit('build:started', {
                workspaceId,
                buildId,
                target: target || 'default',
                cwd: workingDir,
                startedAt: new Date().toISOString(),
            });
            this.logger.debug(`[${client.id}] Build started event emitted`);

            let outputBuffer = '';
            let streamsClosed = 0;
            const totalStreams = 2; // stdout + stderr
            let buildStatus: 'success' | 'error' = 'success';
            let buildError: string | null = null;

            const onData = (chunk: Buffer, streamName: 'stdout' | 'stderr') => {
                const data = chunk.toString('utf8');
                outputBuffer += data;
                this.logger.debug(`[${client.id}] Build ${streamName} received: ${data.length} chars`);

                // Check for errors in stderr
                if (streamName === 'stderr' && data.includes('error')) {
                    buildStatus = 'error';
                    buildError = data;
                }

                client.emit('build:output', {
                    workspaceId,
                    buildId,
                    stream: streamName,
                    data,
                });
            };

            let streamEnded = false;

            const onStreamEnd = () => {
                if (streamEnded) return;
                streamEnded = true;

                this.logger.log(`[${client.id}] Build streams ended for run ${buildId}`);
                exec.inspect((err: any, inspectData: any) => {
                    const exitCode = inspectData?.ExitCode ?? 0;
                    // If exit code is non-zero, it's an error
                    if (exitCode !== 0) {
                        buildStatus = 'error';
                        if (!buildError) {
                            buildError = `Build failed with exit code ${exitCode}`;
                        }
                    }

                    this.logger.log(`[${client.id}] Build ${buildId} finished with exit code: ${exitCode}`);
                    this.logger.debug(`[${client.id}] Total output: ${outputBuffer.length} chars`);

                    // Guard: if already cancelled/cleaned up, skip
                    if (!client.currentBuild || client.currentBuild.buildId !== buildId) {
                        this.logger.debug(`[${client.id}] Build ${buildId} already cleaned up, skipping finished event`);
                        return;
                    }

                    client.emit('build:finished', {
                        workspaceId,
                        buildId,
                        exitCode,
                        status: buildStatus,
                        error: buildError,
                        output: outputBuffer,
                        cwd: workingDir,
                        durationMs: Date.now() - (client.currentBuild.startedAt || Date.now()),
                        finishedAt: new Date().toISOString(),
                    });
                    delete client.currentBuild;
                    this.logger.debug(`[${client.id}] Build ${buildId} cleaned up`);
                });
            };

            const onError = (error: Error) => {
                this.logger.error(`[${client.id}] Build stream error for run ${buildId}: ${error.message}`);
                if (!client.currentBuild || client.currentBuild.buildId !== buildId) return;
                client.emit('build:error', {
                    workspaceId,
                    buildId,
                    message: error.message,
                });
                delete client.currentBuild;
                this.logger.debug(`[${client.id}] Build ${buildId} cleaned up after error`);
            };

            stdoutStream.on('data', (chunk) => onData(chunk, 'stdout'));
            stderrStream.on('data', (chunk) => onData(chunk, 'stderr'));
            
            rawStream.on('end', onStreamEnd);
            rawStream.on('close', onStreamEnd);
            rawStream.on('error', onError);

            // Store start time
            client.currentBuild.startedAt = Date.now();

        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to run build';
            this.logger.error(`[${client.id}] Build failed: ${message}`);
            client.emit('build:error', {
                workspaceId,
                message,
            });
            delete client.currentBuild;
            this.logger.debug(`[${client.id}] Build cleaned up after failure`);
        }
    }

    @SubscribeMessage('build:cancel')
    async cancelBuild(
        @ConnectedSocket() client: AuthenticatedSocket,
        @MessageBody() payload: { workspaceId: string; buildId: string },
    ) {
        this.logger.log(`[${client.id}] Build cancellation requested for: ${payload.buildId}`);

        if (!client.currentBuild || client.currentBuild.buildId !== payload.buildId) {
            this.logger.warn(`[${client.id}] No active build found for ID: ${payload.buildId}`);
            client.emit('build:error', { message: 'No active build to cancel' });
            return;
        }

        const { exec, stream, buildId, containerId } = client.currentBuild;
        // Clean up immediately so the onStreamEnd callback is a no-op.
        delete client.currentBuild;

        try {
            this.logger.debug(`[${client.id}] Cancelling build: ${buildId}`);

            // Stop listening on the raw stream so we don't get ghost events.
            if (stream) {
                stream.removeAllListeners();
                this.logger.debug(`[${client.id}] Build stream listeners removed`);
            }

            // Kill the running process in the container.
            try {
                const inspectData = await new Promise<any>((resolve, reject) =>
                    exec.inspect((err: any, data: any) => (err ? reject(err) : resolve(data)))
                );
                const pid: number | undefined = inspectData?.Pid;
                if (pid) {
                    const killExec = await this.dockerService.createExec(containerId, {
                        AttachStdout: false,
                        AttachStderr: false,
                        Cmd: ['kill', '-KILL', String(pid)],
                    });
                    await this.dockerService.startExec(killExec, { hijack: false, stdin: false });
                    this.logger.debug(`[${client.id}] Sent SIGKILL to PID ${pid}`);
                }
            } catch (killError) {
                // Non-fatal: process may have already finished.
                this.logger.debug(`[${client.id}] Exec kill skipped: ${killError}`);
            }

            client.emit('build:cancelled', {
                workspaceId: payload.workspaceId,
                buildId,
            });
            this.logger.log(`[${client.id}] Build ${buildId} cancelled successfully`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to cancel';
            this.logger.error(`[${client.id}] Failed to cancel build: ${message}`);
            client.emit('build:error', { message });
        }
    }

    private extractToken(
        client: AuthenticatedSocket,
    ): string {
        this.logger.debug(`[${client.id}] Extracting token from connection`);

        const authToken =
            client.handshake.auth?.token as string | undefined;

        const authorizationHeader =
            client.handshake.headers.authorization;

        if (authToken) {
            this.logger.debug(`[${client.id}] Token found in auth object`);
            return authToken.replace(/^Bearer\s+/i, '');
        }

        if (authorizationHeader) {
            this.logger.debug(`[${client.id}] Token found in authorization header`);
            return authorizationHeader.replace(
                /^Bearer\s+/i,
                '',
            );
        }

        this.logger.warn(`[${client.id}] No token found in connection`);
        throw new Error('Missing authentication token');
    }
}