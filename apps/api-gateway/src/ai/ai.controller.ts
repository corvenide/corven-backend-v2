// apps/api-gateway/src/ai/ai.controller.ts
//
//   GET  /api/ai/status   is the assistant configured, which models
//   POST /api/ai/chat     streams a reply as server-sent events:
//                           event: delta  data: {"text": "..."}
//                           event: done   data: {"model", "stopReason", "inputTokens", "outputTokens"}
//                           event: error  data: {"message": "..."}

import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Headers,
    HttpException,
    Post,
    Req,
    Res,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { ApiGatewayService } from '../api-gateway.service';
import { RateLimiter } from '../auth-session';
import { AiError, AiService, type ChatContext } from './ai.service';

interface ChatBody {
    workspaceId?: string;
    model?: string;
    messages?: unknown;
    activeFile?: { path?: unknown; content?: unknown; selection?: unknown };
    output?: { kind?: unknown; content?: unknown };
}

function asString(value: unknown, max: number): string {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

@Controller('ai')
export class AiController {
    /** Per user; replies cost money, so keep a ceiling. */
    private readonly limiter = new RateLimiter(
        Number(process.env.AI_REQUESTS_PER_10_MIN) || 40,
        10 * 60_000,
    );

    constructor(
        private readonly ai: AiService,
        private readonly gateway: ApiGatewayService,
    ) { }

    @Get('status')
    async status(@Headers('authorization') authorization: string) {
        await this.authenticate(authorization);
        return this.ai.status();
    }

    @Post('chat')
    async chat(
        @Headers('authorization') authorization: string,
        @Body() body: ChatBody,
        @Req() req: Request,
        @Res() res: Response,
    ) {
        const user = await this.authenticate(authorization);

        if (!this.ai.enabled) {
            throw new ServiceUnavailableException(
                'The AI assistant is not configured. Add ANTHROPIC_API_KEY to backend/.env and restart the gateway.',
            );
        }

        const messages = this.ai.prepareMessages(body?.messages);
        if (!messages.length) throw new BadRequestException('Send at least one user message.');

        try {
            this.limiter.consume(`ai:${user.id}`);
        } catch {
            throw new HttpException('You’ve sent a lot of AI requests. Wait a few minutes and try again.', 429);
        }

        const context: ChatContext = {};

        if (body?.workspaceId) {
            // Also confirms the user owns the workspace.
            const workspace: any = await this.gateway.findOneWorkspace(user.id, String(body.workspaceId));
            context.workspaceName = workspace?.name;

            try {
                const entries: any = await this.gateway.listFiles(user.id, String(body.workspaceId));
                if (Array.isArray(entries)) {
                    context.files = entries
                        .filter((entry) => entry?.type === 'file' && typeof entry.path === 'string')
                        .map((entry) => entry.path as string)
                        .sort();
                }
            } catch {
                // Files unavailable (e.g. never started); answer without them.
            }
        }

        const filePath = asString(body?.activeFile?.path, 500);
        if (filePath) {
            context.activeFile = {
                path: filePath,
                content: asString(body?.activeFile?.content, 200_000),
                selection: asString(body?.activeFile?.selection, 20_000) || undefined,
            };
        }

        const outputContent = asString(body?.output?.content, 200_000);
        if (outputContent) {
            const kind = body?.output?.kind;
            context.output = {
                kind: kind === 'test' || kind === 'terminal' ? kind : 'build',
                content: outputContent,
            };
        }

        const model = this.ai.resolveModel(typeof body?.model === 'string' ? body.model : undefined);

        // -- Stream --------------------------------------------------------------
        const abort = new AbortController();
        req.on('close', () => abort.abort());

        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const send = (event: string, data: unknown) => {
            if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        // Keeps proxies from closing a quiet connection while Claude thinks.
        const keepAlive = setInterval(() => {
            if (!res.writableEnded) res.write(': ping\n\n');
        }, 15_000);

        try {
            const result = await this.ai.stream(model, messages, this.ai.buildContext(context), {
                signal: abort.signal,
                onText: (text) => send('delta', { text }),
            });

            send('done', result);
        } catch (error) {
            if (!abort.signal.aborted) {
                send('error', {
                    message: error instanceof AiError ? error.message : 'Something went wrong while generating a reply.',
                });
            }
        } finally {
            clearInterval(keepAlive);
            res.end();
        }
    }

    private async authenticate(authorization?: string): Promise<{ id: string }> {
        const [scheme, token] = (authorization ?? '').trim().split(/\s+/);

        if (scheme?.toLowerCase() !== 'bearer' || !token) {
            throw new UnauthorizedException('Missing or invalid authorization header');
        }

        const result = await this.gateway.verifyToken(token);
        if (!result?.valid || !result.user?.id) throw new UnauthorizedException('Invalid token');

        return result.user;
    }
}
