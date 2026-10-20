// apps/runtime-service/src/runtime-service.module.ts

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PrismaService } from 'libs/prisma/src/prisma.service';

import { BuildCacheService } from './build-cache.service';
import { ContractsService } from './contracts.service';
import { DebuggerService } from './debugger.service';
import { DevnetToolsService } from './devnet-tools.service';
import { DockerModule } from './docker/docker.module';
import { HostScheduler } from './host-scheduler';
import { MoleculeService } from './molecule.service';
import { RuntimeServiceController } from './runtime-service.controller';
import { RuntimeServiceService } from './runtime-service.service';
import { WorkspaceFileSync } from './workspace-file-sync.service';

import { RuntimeHealthService } from './runtime-health.service';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            envFilePath: '.env',
        }),

        DockerModule,
    ],

    controllers: [
        RuntimeServiceController,
    ],

    providers: [
        RuntimeServiceService,
        RuntimeHealthService,
        WorkspaceFileSync,
        HostScheduler,
        BuildCacheService,
        ContractsService,
        DebuggerService,
        DevnetToolsService,
        MoleculeService,
        PrismaService,
    ],

    exports: [
        RuntimeServiceService,
        RuntimeHealthService,
    ],
})
export class RuntimeServiceModule { }