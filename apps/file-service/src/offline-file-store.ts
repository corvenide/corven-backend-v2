// apps/file-service/src/offline-file-store.ts
//
// File operations against the database copy of a workspace (WorkspaceFile),
// used while its runtime container isn't running. Edits are flagged `dirty`
// and deletions become `deleted` tombstones; runtime-service applies both
// to the container the next time the workspace starts.
//
// The mirror* methods keep the copy current while the container IS running.

import { RpcException } from '@nestjs/microservices';

import { PrismaService } from '../../../libs/prisma/src/prisma.service';
import { isIgnoredPath } from '../../../libs/prisma/src/workspace-files';
import { normalizeWorkspacePath } from './file-path.util';
import type {
    CreateDirectoryPayload,
    FilePathPayload,
    RenameFilePayload,
    WorkspaceEntry,
    WorkspacePayload,
    WriteFilePayload,
} from './file.types';

function underPath(path: string) {
    return [{ path }, { path: { startsWith: `${path}/` } }];
}

function nameOf(path: string): string {
    return path.split('/').pop() || path;
}

export class OfflineFileStore {
    constructor(private readonly prisma: PrismaService) { }

    // -------------------------------------------------------------------
    // Operations while the runtime is off
    // -------------------------------------------------------------------

    async list(payload: WorkspacePayload): Promise<WorkspaceEntry[]> {
        const rows = await this.prisma.workspaceFile.findMany({
            where: { workspaceId: payload.workspaceId, deleted: false },
            select: { path: true, isDirectory: true, size: true },
            orderBy: { path: 'asc' },
        });

        const entries = new Map<string, WorkspaceEntry>();

        const addDirectory = (path: string) => {
            if (!entries.has(path)) {
                entries.set(path, { name: nameOf(path), path, type: 'directory' });
            }
        };

        for (const row of rows) {
            if (isIgnoredPath(row.path)) continue;

            if (row.isDirectory) {
                addDirectory(row.path);
            } else {
                entries.set(row.path, { name: nameOf(row.path), path: row.path, type: 'file', size: row.size });
            }

            // Parent directories are implied by the files inside them.
            const parts = row.path.split('/');
            for (let i = 1; i < parts.length; i++) addDirectory(parts.slice(0, i).join('/'));
        }

        return [...entries.values()];
    }

    async read(payload: FilePathPayload) {
        const path = normalizeWorkspacePath(payload.path);

        const row = await this.prisma.workspaceFile.findUnique({
            where: { workspaceId_path: { workspaceId: payload.workspaceId, path } },
        });

        if (!row || row.deleted || row.isDirectory) {
            throw new RpcException(`File not found: ${path}`);
        }

        return { name: nameOf(path), path, type: 'file' as const, content: row.content, size: row.size };
    }

    async create(payload: WriteFilePayload) {
        const path = normalizeWorkspacePath(payload.path);

        if (await this.exists(payload.workspaceId, path)) {
            throw new RpcException(`File already exists: ${path}`);
        }

        await this.upsertFile(payload.workspaceId, path, payload.content ?? '', true);
        return this.read({ ...payload, path });
    }

    async update(payload: WriteFilePayload) {
        const path = normalizeWorkspacePath(payload.path);

        const row = await this.prisma.workspaceFile.findUnique({
            where: { workspaceId_path: { workspaceId: payload.workspaceId, path } },
        });

        if (!row || row.deleted || row.isDirectory) {
            throw new RpcException(`File not found: ${path}`);
        }

        await this.upsertFile(payload.workspaceId, path, payload.content, true);
        return this.read({ ...payload, path });
    }

    async mkdir(payload: CreateDirectoryPayload) {
        const path = normalizeWorkspacePath(payload.path);
        await this.upsertDirectory(payload.workspaceId, path, true);
        return { name: nameOf(path), path, type: 'directory' as const };
    }

    async delete(payload: FilePathPayload) {
        const path = normalizeWorkspacePath(payload.path);

        const marked = await this.prisma.workspaceFile.updateMany({
            where: { workspaceId: payload.workspaceId, deleted: false, OR: underPath(path) },
            data: { deleted: true, dirty: false },
        });

        // A directory with nothing stored under it (only implied by paths)
        // still needs a tombstone so the container copy is removed too.
        if (marked.count === 0) {
            const implied = await this.prisma.workspaceFile.count({
                where: { workspaceId: payload.workspaceId, deleted: false, path: { startsWith: `${path}/` } },
            });

            if (implied === 0) throw new RpcException(`Path not found: ${path}`);
        }

        await this.tombstone(payload.workspaceId, path);
        return { success: true, path };
    }

    async rename(payload: RenameFilePayload) {
        const oldPath = normalizeWorkspacePath(payload.oldPath);
        const newPath = normalizeWorkspacePath(payload.newPath);

        const rows = await this.prisma.workspaceFile.findMany({
            where: { workspaceId: payload.workspaceId, deleted: false, OR: underPath(oldPath) },
        });

        if (!rows.length) throw new RpcException(`Path not found: ${oldPath}`);

        if (await this.exists(payload.workspaceId, newPath)) {
            throw new RpcException(`Destination already exists: ${newPath}`);
        }

        await this.prisma.$transaction(async (tx) => {
            for (const row of rows) {
                const moved = newPath + row.path.slice(oldPath.length);

                await tx.workspaceFile.upsert({
                    where: { workspaceId_path: { workspaceId: payload.workspaceId, path: moved } },
                    create: {
                        workspaceId: payload.workspaceId,
                        path: moved,
                        isDirectory: row.isDirectory,
                        content: row.content,
                        size: row.size,
                        dirty: true,
                    },
                    update: { isDirectory: row.isDirectory, content: row.content, size: row.size, dirty: true, deleted: false },
                });
            }

            await tx.workspaceFile.updateMany({
                where: { workspaceId: payload.workspaceId, OR: underPath(oldPath) },
                data: { deleted: true, dirty: false },
            });
        });

        await this.tombstone(payload.workspaceId, oldPath);
        return { success: true, oldPath, newPath };
    }

    // -------------------------------------------------------------------
    // Keeping the copy current while the runtime is running
    // (best-effort: the container is the source of truth then)
    // -------------------------------------------------------------------

    async mirrorWrite(workspaceId: string, path: string, content: string): Promise<void> {
        if (isIgnoredPath(path)) return;
        await this.upsertFile(workspaceId, path, content, false).catch(() => undefined);
    }

    async mirrorMkdir(workspaceId: string, path: string): Promise<void> {
        if (isIgnoredPath(path)) return;
        await this.upsertDirectory(workspaceId, path, false).catch(() => undefined);
    }

    async mirrorDelete(workspaceId: string, path: string): Promise<void> {
        await this.prisma.workspaceFile
            .deleteMany({ where: { workspaceId, OR: underPath(path) } })
            .catch(() => undefined);
    }

    async mirrorRename(workspaceId: string, oldPath: string, newPath: string): Promise<void> {
        try {
            await this.prisma.$transaction(async (tx) => {
                await tx.workspaceFile.deleteMany({ where: { workspaceId, OR: underPath(newPath) } });

                const rows = await tx.workspaceFile.findMany({
                    where: { workspaceId, OR: underPath(oldPath) },
                    select: { id: true, path: true },
                });

                for (const row of rows) {
                    await tx.workspaceFile.update({
                        where: { id: row.id },
                        data: { path: newPath + row.path.slice(oldPath.length) },
                    });
                }
            });
        } catch {
            // The next snapshot will correct the copy.
        }
    }

    // -------------------------------------------------------------------

    private async exists(workspaceId: string, path: string): Promise<boolean> {
        const count = await this.prisma.workspaceFile.count({
            where: { workspaceId, deleted: false, OR: underPath(path) },
        });
        return count > 0;
    }

    private async upsertFile(workspaceId: string, path: string, content: string, dirty: boolean) {
        const size = Buffer.byteLength(content, 'utf8');

        await this.prisma.workspaceFile.upsert({
            where: { workspaceId_path: { workspaceId, path } },
            create: { workspaceId, path, content, size, isDirectory: false, dirty },
            update: { content, size, isDirectory: false, deleted: false, ...(dirty ? { dirty: true } : {}) },
        });
    }

    private async upsertDirectory(workspaceId: string, path: string, dirty: boolean) {
        await this.prisma.workspaceFile.upsert({
            where: { workspaceId_path: { workspaceId, path } },
            create: { workspaceId, path, isDirectory: true, dirty },
            update: { isDirectory: true, deleted: false, ...(dirty ? { dirty: true } : {}) },
        });
    }

    /** Ensures a `deleted` row exists for `path` itself, so the container copy is removed. */
    private async tombstone(workspaceId: string, path: string): Promise<void> {
        await this.prisma.workspaceFile.upsert({
            where: { workspaceId_path: { workspaceId, path } },
            create: { workspaceId, path, isDirectory: false, deleted: true },
            update: { deleted: true, dirty: false },
        });
    }
}
