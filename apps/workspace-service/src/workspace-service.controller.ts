// apps/workspace-service/src/workspace-service.controller.ts
import { Controller } from '@nestjs/common';
import {
    MessagePattern,
    Payload,
} from '@nestjs/microservices';

import { WorkspaceService } from './workspace-service.service';

@Controller()
export class WorkspaceServiceController {
    constructor(
        private readonly workspaceService: WorkspaceService,
    ) { }

    @MessagePattern({ cmd: 'workspace.create' })
    create(
        @Payload()
        data: {
            userId: string;
            name: string;
            templateId?: string;
            temporary?: boolean;
            guest?: boolean;
        },
    ) {
        return this.workspaceService.create(data);
    }

    @MessagePattern({ cmd: 'workspace.setTemporary' })
    setTemporary(
        @Payload()
        data: { userId: string; workspaceId: string; temporary: boolean; guest?: boolean },
    ) {
        return this.workspaceService.setTemporary(data);
    }

    @MessagePattern({ cmd: 'workspace.findMine' })
    findMine(@Payload() data: { userId: string }) {
        return this.workspaceService.findMine(data.userId);
    }

    @MessagePattern({ cmd: 'workspace.findOne' })
    findOne(
        @Payload()
        data: {
            userId: string;
            workspaceId: string;
        },
    ) {
        return this.workspaceService.findOne(
            data.userId,
            data.workspaceId,
        );
    }

    @MessagePattern({ cmd: 'workspace.start' })
    start(
        @Payload()
        data: {
            userId: string;
            workspaceId: string;
        },
    ) {
        return this.workspaceService.start(
            data.userId,
            data.workspaceId,
        );
    }

    @MessagePattern({ cmd: 'workspace.stop' })
    stop(
        @Payload()
        data: {
            userId: string;
            workspaceId: string;
        },
    ) {
        return this.workspaceService.stop(
            data.userId,
            data.workspaceId,
        );
    }

    @MessagePattern({ cmd: 'workspace.status' })
    status(
        @Payload()
        data: {
            userId: string;
            workspaceId: string;
        },
    ) {
        return this.workspaceService.getStatus(
            data.userId,
            data.workspaceId,
        );
    }

    @MessagePattern({ cmd: 'workspace.delete' })
    delete(
        @Payload()
        data: {
            userId: string;
            workspaceId: string;
        },
    ) {
        return this.workspaceService.delete(
            data.userId,
            data.workspaceId,
        );
    }
}