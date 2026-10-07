import { expiredTemporaryWhere, guestWorkspaceLimit, temporaryExpiresAt, temporaryWorkspaceTtlMs } from './temporary-workspaces';

describe('temporary workspaces', () => {
    const day = 24 * 60 * 60 * 1000;

    it('defaults to 24 hours and reads the env', () => {
        expect(temporaryWorkspaceTtlMs({})).toBe(day);
        expect(temporaryWorkspaceTtlMs({ TEMPORARY_WORKSPACE_HOURS: '2' })).toBe(2 * 60 * 60 * 1000);
        expect(temporaryWorkspaceTtlMs({ TEMPORARY_WORKSPACE_HOURS: 'nope' })).toBe(day);
    });

    it('expires from the last use, falling back to creation', () => {
        const createdAt = new Date('2026-10-01T00:00:00Z');
        const lastActivityAt = new Date('2026-10-02T00:00:00Z');
        expect(temporaryExpiresAt({ temporary: true, createdAt, lastActivityAt: null }, {})?.toISOString()).toBe('2026-10-02T00:00:00.000Z');
        expect(temporaryExpiresAt({ temporary: true, createdAt, lastActivityAt }, {})?.toISOString()).toBe('2026-10-03T00:00:00.000Z');
        expect(temporaryExpiresAt({ temporary: false, createdAt, lastActivityAt }, {})).toBeNull();
    });

    it('builds the expiry filter', () => {
        const now = Date.parse('2026-10-03T00:00:00Z');
        const where = expiredTemporaryWhere(now, {});
        expect(where.temporary).toBe(true);
        expect((where.OR[0].lastActivityAt as { lt: Date }).lt.toISOString()).toBe('2026-10-02T00:00:00.000Z');
    });

    it('limits guests', () => {
        expect(guestWorkspaceLimit({})).toBe(2);
        expect(guestWorkspaceLimit({ GUEST_WORKSPACE_LIMIT: '5' })).toBe(5);
    });
});
