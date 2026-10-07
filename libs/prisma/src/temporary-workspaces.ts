// libs/prisma/src/temporary-workspaces.ts
//
// Temporary workspaces (all guest workspaces, and any a signed-in user marks
// temporary) are deleted once they have gone unused for a while. "Used"
// means the same as for idle stops: the open IDE tab, terminal input,
// builds, tests and file edits all bump lastActivityAt.

/** How long a temporary workspace survives without use. TEMPORARY_WORKSPACE_HOURS, default 24. */
export function temporaryWorkspaceTtlMs(env: NodeJS.ProcessEnv = process.env): number {
    const hours = Number(env.TEMPORARY_WORKSPACE_HOURS);
    return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;
}

/** Guests may keep this many temporary workspaces at once. GUEST_WORKSPACE_LIMIT, default 2. */
export function guestWorkspaceLimit(env: NodeJS.ProcessEnv = process.env): number {
    const limit = Number(env.GUEST_WORKSPACE_LIMIT);
    return Number.isInteger(limit) && limit > 0 ? limit : 2;
}

/** When a temporary workspace will be deleted if nobody uses it before then. */
export function temporaryExpiresAt(
    workspace: { temporary: boolean; lastActivityAt: Date | null; createdAt: Date },
    env: NodeJS.ProcessEnv = process.env,
): Date | null {
    if (!workspace.temporary) return null;
    const lastUse = workspace.lastActivityAt ?? workspace.createdAt;
    return new Date(lastUse.getTime() + temporaryWorkspaceTtlMs(env));
}

/** Prisma filter for temporary workspaces that are past their time. */
export function expiredTemporaryWhere(now = Date.now(), env: NodeJS.ProcessEnv = process.env) {
    const cutoff = new Date(now - temporaryWorkspaceTtlMs(env));

    return {
        temporary: true,
        status: { not: 'DELETED' as const },
        OR: [
            { lastActivityAt: { lt: cutoff } },
            { lastActivityAt: null, createdAt: { lt: cutoff } },
        ],
    };
}
