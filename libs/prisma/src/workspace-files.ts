// libs/prisma/src/workspace-files.ts
//
// The database copy of a workspace's source files (the WorkspaceFile table).
// runtime-service refreshes it from the container; file-service serves it
// while the container isn't running.

import type { PrismaService } from './prisma.service';

/** Directories that are never copied to the database or shown in the editor. */
export const IGNORED_SEGMENTS = ['.git', 'node_modules', 'target', 'build', 'dist', '.next'];

/** Largest single file kept in the database copy. */
export const MAX_SNAPSHOT_FILE_BYTES = 512 * 1024;

/** Upper bound on entries per snapshot, to keep one workspace from bloating the DB. */
export const MAX_SNAPSHOT_ENTRIES = 5_000;

export function isIgnoredPath(filePath: string): boolean {
    return filePath.split('/').some((segment) => IGNORED_SEGMENTS.includes(segment));
}

/**
 * Shell script run inside the runtime container. Prints one line per entry:
 *   D<TAB>path
 *   F<TAB>path<TAB>base64-content
 * Paths are relative to /workspace. Base64 keeps the output text-safe.
 */
export const SNAPSHOT_SCRIPT = [
    'cd /workspace || exit 1',
    `find . -mindepth 1 \\( ${IGNORED_SEGMENTS.map((s) => `-name '${s}'`).join(' -o ')} \\) -prune -o \\( -type d -printf 'D\\t%P\\n' \\) -o \\( -type f -size -${MAX_SNAPSHOT_FILE_BYTES / 1024}k -printf 'F\\t%P\\n' \\) | head -n ${MAX_SNAPSHOT_ENTRIES} |`,
    "while IFS='\t' read -r kind p; do",
    '  if [ "$kind" = F ]; then printf \'F\\t%s\\t\' "$p"; base64 -w0 -- "$p"; printf \'\\n\';',
    '  else printf \'D\\t%s\\n\' "$p"; fi',
    'done',
].join('\n');

export interface SnapshotEntry {
    path: string;
    isDirectory: boolean;
    content: string;
    size: number;
}

/** Parses SNAPSHOT_SCRIPT output. Binary files (containing NUL bytes) are skipped. */
export function parseSnapshot(output: string): SnapshotEntry[] {
    const entries: SnapshotEntry[] = [];

    for (const line of output.split('\n')) {
        if (!line) continue;

        const [kind, path, encoded = ''] = line.split('\t');
        if (!path || isIgnoredPath(path)) continue;

        if (kind === 'D') {
            entries.push({ path, isDirectory: true, content: '', size: 0 });
            continue;
        }

        if (kind !== 'F') continue;

        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.includes(0)) continue; // binary

        entries.push({
            path,
            isDirectory: false,
            content: bytes.toString('utf8'),
            size: bytes.length,
        });
    }

    return entries;
}

/**
 * Replaces the stored copy with a fresh snapshot. Rows with unapplied
 * offline edits (dirty / deleted) are kept: they are newer than the container.
 */
export async function replaceSnapshot(
    prisma: PrismaService,
    workspaceId: string,
    entries: SnapshotEntry[],
): Promise<void> {
    await prisma.$transaction(async (tx) => {
        const pending = await tx.workspaceFile.findMany({
            where: { workspaceId, OR: [{ dirty: true }, { deleted: true }] },
            select: { path: true },
        });

        const pendingPaths = new Set(pending.map((row) => row.path));

        await tx.workspaceFile.deleteMany({
            where: { workspaceId, dirty: false, deleted: false },
        });

        const rows = entries
            .filter((entry) => !pendingPaths.has(entry.path))
            .map((entry) => ({ workspaceId, ...entry }));

        for (let i = 0; i < rows.length; i += 500) {
            await tx.workspaceFile.createMany({ data: rows.slice(i, i + 500) });
        }

        await tx.workspace.update({
            where: { id: workspaceId },
            data: { filesSnapshotAt: new Date() },
        });
    });
}
