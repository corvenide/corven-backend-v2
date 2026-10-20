import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    Param,
    Post,
    Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { WORKSPACE_TEMPLATES } from 'libs/prisma/src/workspace-templates';
import { MetricsService } from 'libs/logger/src/metrics.service';
import { ApiGatewayService } from './api-gateway.service';
import { createPreviewToken } from './preview-proxy';
import { getUserFromAuthorizationHeader } from './auth-helpers';

@Controller()
export class ApiGatewayController {
    constructor(
        private readonly gatewayService: ApiGatewayService,
        private readonly metricsService: MetricsService,
    ) { }

    // =========================================
    // Health and Metrics
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

    @Get('metrics')
    async getMetrics(@Res() res: Response) {
        res.setHeader('Content-Type', this.metricsService.getContentType());
        res.send(await this.metricsService.getMetrics());
    }

    // =========================================
    // Templates & Previews
    // =========================================

    @Get('workspace-templates')
    listWorkspaceTemplates() {
        return WORKSPACE_TEMPLATES;
    }

    @Post('workspaces/:id/preview')
    @HttpCode(200)
    async openPreview(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
        @Body() body: { port?: number },
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        const port = Number(body?.port);

        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new BadRequestException('port must be a number between 1 and 65535');
        }

        await this.gatewayService.resolvePreview(user.id, workspaceId, port);

        return {
            port,
            path: `preview/${createPreviewToken(user.id, workspaceId, port)}/`,
        };
    }
}
