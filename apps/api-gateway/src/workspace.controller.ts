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
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { findTemplate } from 'libs/prisma/src/workspace-templates';
import { ApiGatewayService } from './api-gateway.service';
import { getUserFromAuthorizationHeader } from './auth-helpers';
import { CreateWorkspaceDto } from './dto/workspace.dto';

@Controller('workspaces')
export class WorkspaceController {
    constructor(private readonly gatewayService: ApiGatewayService) { }

    @Post()
    async createWorkspace(
        @Headers('authorization') authorization: string,
        @Body() body: CreateWorkspaceDto & { temporary?: boolean },
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);

        if (body.templateId && !findTemplate(body.templateId)) {
            throw new BadRequestException(`Unknown project template: ${body.templateId}`);
        }

        return this.gatewayService.createWorkspace({
            userId: user.id,
            name: body.name,
            templateId: body.templateId,
            temporary: body.temporary === true,
            guest: user.isGuest === true,
        });
    }

    @Patch(':id')
    async updateWorkspace(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
        @Body() body: { temporary?: unknown },
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);

        if (typeof body?.temporary !== 'boolean') {
            throw new BadRequestException('temporary must be true or false');
        }

        return this.gatewayService.setWorkspaceTemporary({
            userId: user.id,
            workspaceId,
            temporary: body.temporary,
            guest: user.isGuest === true,
        });
    }

    @Get()
    async findMyWorkspaces(@Headers('authorization') authorization: string) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.findMyWorkspaces(user.id);
    }

    @Get(':id')
    async findOneWorkspace(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.findOneWorkspace(user.id, workspaceId);
    }

    @Delete(':id')
    async deleteWorkspace(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.deleteWorkspace(user.id, workspaceId);
    }

    @Post(':id/start')
    async startWorkspace(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.startWorkspace(user.id, workspaceId);
    }

    @Post(':id/heartbeat')
    @HttpCode(200)
    async workspaceHeartbeat(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.workspaceHeartbeat(user.id, workspaceId);
    }

    @Post(':id/devnet/start')
    async startDevnet(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.startDevnet(user.id, workspaceId);
    }

    @Get(':id/contracts')
    async listContracts(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.listContracts(user.id, workspaceId);
    }

    @Get(':id/contracts/:name/binary')
    async contractBinary(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
        @Param('name') name: string,
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.contractBinary(user.id, workspaceId, name);
    }

    @Get(':id/deployments')
    async listDeployments(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.listDeployments(user.id, workspaceId);
    }

    @Post(':id/deployments/devnet')
    async deployDevnet(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
        @Body() body: { contract?: string; upgradable?: boolean },
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.deployDevnet(user.id, workspaceId, String(body?.contract ?? ''), body?.upgradable !== false);
    }

    @Post(':id/deployments')
    async recordDeployment(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
        @Body() body: Record<string, unknown>,
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.recordDeployment(user.id, workspaceId, body ?? {});
    }

    @Post(':id/debug/run')
    @HttpCode(200)
    async debugRunContract(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
        @Body() body: { contract?: string },
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.debugRunContract(user.id, workspaceId, String(body?.contract ?? ''));
    }

    @Get(':id/debug/transactions')
    async debugTransactions(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.debugTransactions(user.id, workspaceId);
    }

    @Post(':id/debug/tx')
    @HttpCode(200)
    async debugTransaction(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
        @Body() body: { txHash?: string; replace?: unknown },
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.debugTransaction(user.id, workspaceId, String(body?.txHash ?? ''), (body as any)?.replace);
    }

    // =========================================
    // Workspace files
    // =========================================

    @Get(':id/files')
    async listWorkspaceFiles(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.listFiles(user.id, workspaceId);
    }

    @Get(':id/files/content')
    async readWorkspaceFile(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
        @Query('path') filePath: string,
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.readFile(user.id, workspaceId, filePath);
    }

    @Put(':id/files/content')
    async writeWorkspaceFile(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
        @Query('path') filePath: string,
        @Body() body: { content: string },
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.createFile(user.id, workspaceId, filePath, body?.content ?? '');
    }

    @Delete(':id/files')
    async deleteWorkspaceFile(
        @Headers('authorization') authorization: string,
        @Param('id') workspaceId: string,
        @Query('path') filePath: string,
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.deleteFile(user.id, workspaceId, filePath);
    }
}
