// libs/prisma/src/workspace-activity.ts
//
// Records that a workspace is in use, so the idle reaper in runtime-service
// doesn't stop it. Called on terminal input, builds, tests, file edits and
// the IDE heartbeat; throttled per process so busy workspaces don't write to
// the database on every keystroke.

import type { PrismaService } from './prisma.service';

const lastRecorded = new Map<string, number>();

export async function recordWorkspaceActivity(
    prisma: PrismaService,
    workspaceId: string,
    minIntervalMs = 30_000,
): Promise<void> {
    const now = Date.now();
    const previous = lastRecorded.get(workspaceId) ?? 0;

    if (now - previous < minIntervalMs) return;

    lastRecorded.set(workspaceId, now);

    if (lastRecorded.size > 5_000) {
        for (const [id, at] of lastRecorded) {
            if (now - at > minIntervalMs) lastRecorded.delete(id);
        }
    }

    try {
        await prisma.workspace.update({
            where: { id: workspaceId },
            data: { lastActivityAt: new Date(now) },
        });
    } catch {
        // Activity tracking must never break the action that triggered it.
    }
}
