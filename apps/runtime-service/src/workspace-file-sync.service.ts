// apps/runtime-service/src/workspace-file-sync.service.ts
//
// Keeps the database copy of a workspace's source files (WorkspaceFile) in
// step with its runtime container:
//   - snapshot():   container -> database (after start, periodically, before stop)
//   - applyOffline(): database -> container (edits made while it was stopped)
//   - restoreCopy():  database -> container (whole copy, after moving hosts)
//
// Every method takes the Docker client for the workspace's host.

import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from 'libs/prisma/src/prisma.service';
import {
    IGNORED_SEGMENTS,
    parseSnapshot,
    replaceSnapshot,
    SNAPSHOT_SCRIPT,
} from 'libs/prisma/src/workspace-files';

import type { DockerClient } from './docker/docker.service';

@Injectable()
export class WorkspaceFileSync {
    private readonly logger = new Logger(WorkspaceFileSync.name);

    /** Workspaces with a snapshot in progress, to avoid overlapping runs. */
    private readonly inFlight = new Set<string>();

    constructor(private readonly prisma: PrismaService) { }

    /** Copies the container's source files into the database. */
    async snapshot(workspaceId: string, containerId: string, docker: DockerClient): Promise<boolean> {
        if (this.inFlight.has(workspaceId)) return false;
        this.inFlight.add(workspaceId);

        const startedAt = Date.now();

        try {
            const result = await docker.executeCommand({
                containerId,
                command: ['bash', '-c', SNAPSHOT_SCRIPT],
                workingDirectory: '/workspace',
            });

            if (result.exitCode !== 0) {
                throw new Error(result.stderr.trim() || `exit code ${result.exitCode}`);
            }

            const entries = parseSnapshot(result.stdout);
            await replaceSnapshot(this.prisma, workspaceId, entries);

            this.logger.debug(
                `Snapshot of ${workspaceId}: ${entries.length} entries in ${Date.now() - startedAt}ms`,
            );

            return true;
        } catch (error) {
            this.logger.warn(
                `Snapshot of ${workspaceId} failed: ${error instanceof Error ? error.message : error}`,
            );
            return false;
        } finally {
            this.inFlight.delete(workspaceId);
        }
    }

    /**
     * Applies edits made in the editor while the container was stopped.
     * Offline edits win over the container's copy of the same file.
     */
    async applyOffline(workspaceId: string, containerId: string, docker: DockerClient): Promise<number> {
        const pending = await this.prisma.workspaceFile.findMany({
            where: { workspaceId, OR: [{ dirty: true }, { deleted: true }] },
            orderBy: { path: 'asc' },
        });

        if (!pending.length) return 0;

        let applied = 0;

        for (const row of pending) {
            const target = `/workspace/${row.path}`;

            const result = row.deleted
                ? await docker.executeCommand({
                      containerId,
                      command: ['rm', '-rf', '--', target],
                      workingDirectory: '/workspace',
                  })
                : row.isDirectory
                  ? await docker.executeCommand({
                        containerId,
                        command: ['mkdir', '-p', '--', target],
                        workingDirectory: '/workspace',
                    })
                  : await docker.executeCommand({
                        containerId,
                        command: ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'apply', target],
                        workingDirectory: '/workspace',
                        input: row.content,
                    });

            if (result.exitCode !== 0) {
                this.logger.warn(`Could not apply offline change to ${row.path}: ${result.stderr.trim()}`);
                continue;
            }

            applied += 1;

            if (row.deleted) {
                await this.prisma.workspaceFile.delete({ where: { id: row.id } }).catch(() => undefined);
            } else {
                await this.prisma.workspaceFile
                    .updateMany({
                        // Only clear the flag if nobody edited it again meanwhile.
                        where: { id: row.id, updatedAt: row.updatedAt },
                        data: { dirty: false },
                    })
                    .catch(() => undefined);
            }
        }

        this.logger.log(`Applied ${applied}/${pending.length} offline change(s) to ${workspaceId}`);
        return applied;
    }

    /**
     * Rebuilds a workspace on a new host from the database copy: every stored
     * file is written, and files from the fresh template that aren't in the
     * copy (the user had deleted them) are removed. Build output isn't
     * stored, so the first build on the new host is a full one.
     */
    async restoreCopy(workspaceId: string, containerId: string, docker: DockerClient): Promise<void> {
        const stored = await this.prisma.workspaceFile.findMany({
            where: { workspaceId, deleted: false },
            select: { path: true },
        });

        if (!stored.length) return;

        const keep = new Set(stored.map((row) => row.path));

        // Remove template entries the copy doesn't have (deepest first).
        const listing = await docker.executeCommand({
            containerId,
            command: [
                'bash', '-c',
                `cd /workspace && find . -mindepth 1 \\( ${IGNORED_SEGMENTS.map((s) => `-name '${s}'`).join(' -o ')} \\) -prune -o -printf '%P\\n'`,
            ],
            workingDirectory: '/workspace',
        });

        const extras = listing.stdout
            .split('\n')
            .filter(Boolean)
            .filter((path) => !keep.has(path) && !path.endsWith('.fiberdev-initialized'))
            // A directory is kept if anything under it is kept.
            .filter((path) => ![...keep].some((kept) => kept.startsWith(`${path}/`)))
            .sort((a, b) => b.length - a.length);

        for (const path of extras) {
            await docker.executeCommand({
                containerId,
                command: ['rm', '-rf', '--', `/workspace/${path}`],
                workingDirectory: '/workspace',
            });
        }

        // Write everything by marking it as an offline edit.
        await this.prisma.workspaceFile.updateMany({
            where: { workspaceId, deleted: false },
            data: { dirty: true },
        });

        await this.applyOffline(workspaceId, containerId, docker);

        this.logger.log(
            `Restored ${stored.length} entries of ${workspaceId} on ${docker.hostId} (removed ${extras.length} template entries)`,
        );
    }
}
