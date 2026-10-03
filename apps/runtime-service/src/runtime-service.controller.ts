// apps/runtime-service/src/runtime-service.controller.ts

import { Controller } from '@nestjs/common';

import {
    MessagePattern,
    Payload,
} from '@nestjs/microservices';

import { RuntimeServiceService } from './runtime-service.service';
import { ContractsService, type RecordDeploymentInput } from './contracts.service';
import { DebuggerService } from './debugger.service';
import { DevnetToolsService } from './devnet-tools.service';
import { MoleculeService } from './molecule.service';

import type {
    BuildWorkspacePayload,
    DeleteWorkspacePayload,
    ExecuteRuntimeCommandPayload,
    ResetWorkspacePayload,
    RunContractPayload,
    StartWorkspacePayload,
    StopWorkspacePayload,
    TestWorkspacePayload,
    WorkspaceStatusPayload,
} from './runtime.types';

@Controller()
export class RuntimeServiceController {
    constructor(
        private readonly runtimeService: RuntimeServiceService,
        private readonly contracts: ContractsService,
        private readonly debuggerService: DebuggerService,
        private readonly devnetTools: DevnetToolsService,
        private readonly molecule: MoleculeService,
    ) { }

    // -- Devnet tools --------------------------------------------------------------

    @MessagePattern({ cmd: 'runtime.devnet.accounts' })
    devnetAccounts(@Payload() payload: WorkspaceStatusPayload) {
        return this.devnetTools.accounts(payload);
    }

    @MessagePattern({ cmd: 'runtime.devnet.scripts' })
    devnetScripts(@Payload() payload: WorkspaceStatusPayload) {
        return this.devnetTools.systemScripts(payload);
    }

    @MessagePattern({ cmd: 'runtime.devnet.rpc' })
    devnetRpc(@Payload() payload: WorkspaceStatusPayload & { request: unknown }) {
        return this.devnetTools.rpc(payload);
    }

    // -- Debugger ----------------------------------------------------------------

    @MessagePattern({ cmd: 'runtime.debug.run' })
    debugRun(@Payload() payload: WorkspaceStatusPayload & { contract: string }) {
        return this.debuggerService.runContract(payload);
    }

    @MessagePattern({ cmd: 'runtime.debug.transactions' })
    debugTransactions(@Payload() payload: WorkspaceStatusPayload) {
        return this.debuggerService.listTransactions(payload);
    }

    @MessagePattern({ cmd: 'runtime.debug.tx' })
    debugTransaction(@Payload() payload: WorkspaceStatusPayload & { txHash: string; replace?: string[] }) {
        return this.debuggerService.debugTransaction(payload);
    }

    // -- Molecule ----------------------------------------------------------------

    @MessagePattern({ cmd: 'runtime.molecule.generate' })
    generateMolecule(@Payload() payload: WorkspaceStatusPayload & { path: string; language?: string }) {
        return this.molecule.generate(payload);
    }

    // -- Contracts and deployments ---------------------------------------------

    @MessagePattern({ cmd: 'runtime.contracts.list' })
    listContracts(@Payload() payload: WorkspaceStatusPayload) {
        return this.contracts.listContracts(payload);
    }

    @MessagePattern({ cmd: 'runtime.contracts.binary' })
    contractBinary(@Payload() payload: WorkspaceStatusPayload & { contract: string }) {
        return this.contracts.readBinary(payload);
    }

    @MessagePattern({ cmd: 'runtime.deploy.devnet' })
    deployDevnet(@Payload() payload: WorkspaceStatusPayload & { contract: string; upgradable?: boolean }) {
        return this.contracts.deployDevnet(payload);
    }

    @MessagePattern({ cmd: 'runtime.deployments.list' })
    listDeployments(@Payload() payload: WorkspaceStatusPayload) {
        return this.contracts.listDeployments(payload);
    }

    @MessagePattern({ cmd: 'runtime.deployments.record' })
    recordDeployment(@Payload() payload: RecordDeploymentInput) {
        return this.contracts.recordDeployment(payload);
    }

    @MessagePattern({
        cmd: 'runtime.health',
    })
    health() {
        return this.runtimeService.health();
    }

    @MessagePattern({
        cmd: 'runtime.start',
    })
    startWorkspace(
        @Payload()
        payload: StartWorkspacePayload,
    ) {
        return this.runtimeService.startWorkspace(payload);
    }

    @MessagePattern({ cmd: 'runtime.preview.resolve' })
    resolvePreview(@Payload() payload: WorkspaceStatusPayload & { port: number }) {
        return this.runtimeService.resolvePreview(payload);
    }

    @MessagePattern({
        cmd: 'runtime.heartbeat',
    })
    heartbeat(
        @Payload()
        payload: WorkspaceStatusPayload,
    ) {
        return this.runtimeService.heartbeat(payload);
    }

    @MessagePattern({
        cmd: 'runtime.devnet.start',
    })
    startDevnet(
        @Payload()
        payload: WorkspaceStatusPayload,
    ) {
        return this.runtimeService.startDevnet(payload);
    }

    @MessagePattern({
        cmd: 'runtime.devnet.stop',
    })
    stopDevnet(
        @Payload()
        payload: WorkspaceStatusPayload,
    ) {
        return this.runtimeService.stopDevnet(payload);
    }

    @MessagePattern({
        cmd: 'runtime.devnet.info',
    })
    devnetInfo(
        @Payload()
        payload: WorkspaceStatusPayload,
    ) {
        return this.runtimeService.getDevnetInfo(payload);
    }

    @MessagePattern({
        cmd: 'runtime.stop',
    })
    stopWorkspace(
        @Payload()
        payload: StopWorkspacePayload,
    ) {
        return this.runtimeService.stopWorkspace(payload);
    }

    @MessagePattern({
        cmd: 'runtime.status',
    })
    getWorkspaceStatus(
        @Payload()
        payload: WorkspaceStatusPayload,
    ) {
        return this.runtimeService.getWorkspaceStatus(payload);
    }

    @MessagePattern({
        cmd: 'runtime.delete',
    })
    deleteWorkspace(
        @Payload()
        payload: DeleteWorkspacePayload,
    ) {
        return this.runtimeService.deleteWorkspace(payload);
    }

    @MessagePattern({
        cmd: 'runtime.reset',
    })
    resetWorkspace(
        @Payload()
        payload: ResetWorkspacePayload,
    ) {
        return this.runtimeService.resetWorkspace(
            payload.workspaceId,
            payload.userId,
        );
    }

    @MessagePattern({
        cmd: 'runtime.execute',
    })
    executeCommand(
        @Payload()
        payload: ExecuteRuntimeCommandPayload,
    ) {
        return this.runtimeService.executeRuntimeCommand(
            payload.workspaceId,
            payload.command,
            payload.workingDirectory,
            payload.userId,
        );
    }

    @MessagePattern({
        cmd: 'runtime.build',
    })
    buildWorkspace(
        @Payload()
        payload: BuildWorkspacePayload,
    ) {
        return this.runtimeService.buildProject(
            payload.workspaceId,
            payload.userId,
        );
    }

    @MessagePattern({
        cmd: 'runtime.test',
    })
    testWorkspace(
        @Payload()
        payload: TestWorkspacePayload,
    ) {
        return this.runtimeService.testProject(
            payload.workspaceId,
            payload.userId,
        );
    }

    @MessagePattern({
        cmd: 'runtime.run-contract',
    })
    runContract(
        @Payload()
        payload: RunContractPayload,
    ) {
        return this.runtimeService.runDefaultContract(
            payload.workspaceId,
            payload.userId,
        );
    }
}