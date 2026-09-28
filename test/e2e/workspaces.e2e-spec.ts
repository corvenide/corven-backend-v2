import { ApiClient, signedInClient } from './support/api';
import { DATABASE_URL, disconnect, markStartedBefore } from './support/db';

// Workspaces are never started here, so these tests need neither the
// workspace images nor a free server slot. The file tests use a workspace
// that has started before and is now stopped: its files are served from the
// database copy, which is what users edit while a workspace is off.

// The file tests need direct database access for that setup.
const describeFiles = DATABASE_URL ? describe : describe.skip;

describe('Workspaces (e2e)', () => {
    let api: ApiClient;

    beforeAll(async () => {
        ({ api } = await signedInClient());
    });

    afterAll(async () => {
        await disconnect();
    });

    async function createWorkspace(name = `ws-${Date.now()}`) {
        const response = await api.post('/workspaces', { name });
        expect(response.status).toBe(201);
        return response.body as { id: string; name: string; status: string; templateId: string };
    }

    it('lists the project templates', async () => {
        const response = await api.get('/workspace-templates');

        expect(response.status).toBe(200);
        expect(response.body).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: expect.any(String), name: expect.any(String) })]),
        );
    });

    it('creates, lists, reads and deletes a workspace', async () => {
        const created = await createWorkspace('e2e-lifecycle');

        expect(created).toMatchObject({ name: 'e2e-lifecycle', status: 'PENDING' });
        expect(created.templateId).toEqual(expect.any(String));

        const list = await api.get('/workspaces');
        expect(list.status).toBe(200);
        expect(list.body.map((workspace: { id: string }) => workspace.id)).toContain(created.id);

        const one = await api.get(`/workspaces/${created.id}`);
        expect(one.status).toBe(200);
        expect(one.body).toMatchObject({ id: created.id, name: 'e2e-lifecycle' });

        const removed = await api.delete(`/workspaces/${created.id}`);
        expect(removed.status).toBeLessThan(300);

        const afterDelete = await api.get('/workspaces');
        expect(afterDelete.body.map((workspace: { id: string }) => workspace.id)).not.toContain(created.id);
    });

    it('rejects an unknown template', async () => {
        const response = await api.post('/workspaces', { name: 'bad-template', templateId: 'does-not-exist' });

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
    });

    it("keeps each user's workspaces private", async () => {
        const mine = await createWorkspace('private-to-owner');
        const { api: stranger } = await signedInClient();

        const list = await stranger.get('/workspaces');
        expect(list.body.map((workspace: { id: string }) => workspace.id)).not.toContain(mine.id);

        const attempts = [
            ['GET', `/workspaces/${mine.id}`],
            ['DELETE', `/workspaces/${mine.id}`],
            ['GET', `/workspaces/${mine.id}/files`],
            ['GET', `/workspaces/${mine.id}/files/content?path=README.md`],
            ['POST', `/workspaces/${mine.id}/files`],
        ] as const;

        const allowed: string[] = [];
        for (const [method, path] of attempts) {
            const body = method === 'POST' ? { path: 'x.txt', content: 'x' } : undefined;
            const response = await stranger.request(method, path, { body });
            if (response.status < 400) allowed.push(`${method} ${path} -> ${response.status}`);
        }

        expect(allowed).toEqual([]);

        // Still there for the owner.
        expect((await api.get(`/workspaces/${mine.id}`)).status).toBe(200);
    });

    it('has no files before the workspace first starts', async () => {
        const workspace = await createWorkspace('never-started');

        const response = await api.get(`/workspaces/${workspace.id}/files`);

        expect(response.status).toBe(400);
        expect(response.body.message).toMatch(/once the workspace has started/);
    });

    describeFiles('files of a stopped workspace', () => {
        let workspaceId: string;

        beforeAll(async () => {
            workspaceId = (await createWorkspace('e2e-files')).id;
            await markStartedBefore(workspaceId);
        });

        const files = (suffix = '') => `/workspaces/${workspaceId}/files${suffix}`;

        async function listPaths(): Promise<string[]> {
            const response = await api.get(files());
            expect(response.status).toBe(200);
            return response.body.map((entry: { path: string }) => entry.path);
        }

        it('creates, reads, updates, renames and deletes a file', async () => {
            const created = await api.post(files(), { path: 'notes/todo.md', content: '# Todo\n' });
            expect(created.status).toBe(201);

            expect(await listPaths()).toEqual(expect.arrayContaining(['notes', 'notes/todo.md']));

            const read = await api.get(files('/content?path=notes/todo.md'));
            expect(read.status).toBe(200);
            expect(read.body.content).toBe('# Todo\n');

            const updated = await api.put(files(), { path: 'notes/todo.md', content: '# Done\n' });
            expect(updated.status).toBeLessThan(300);
            expect((await api.get(files('/content?path=notes/todo.md'))).body.content).toBe('# Done\n');

            const renamed = await api.put(files('/rename'), { oldPath: 'notes/todo.md', newPath: 'notes/done.md' });
            expect(renamed.status).toBeLessThan(300);
            expect(await listPaths()).toContain('notes/done.md');
            expect(await listPaths()).not.toContain('notes/todo.md');

            const deleted = await api.delete(files('?path=notes/done.md'));
            expect(deleted.status).toBeLessThan(300);
            expect(await listPaths()).not.toContain('notes/done.md');
        });

        it('creates directories', async () => {
            const response = await api.post(`/workspaces/${workspaceId}/directories`, { path: 'contracts/new-contract' });

            expect(response.status).toBe(201);
            expect(await listPaths()).toContain('contracts/new-contract');
        });

        it('reports a missing file', async () => {
            const response = await api.get(files('/content?path=does/not/exist.rs'));

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.status).toBeLessThan(500);
        });

        it.each(['../outside.txt', '../../etc/passwd', 'src/../../escape.txt', './', 'src/../'])(
            'refuses the path %j',
            async (path) => {
                const before = await listPaths();

                const write = await api.post(files(), { path, content: 'nope' });
                expect(write.status).toBeGreaterThanOrEqual(400);
                expect(write.status).toBeLessThan(500);

                const remove = await api.delete(files(`?path=${encodeURIComponent(path)}`));
                expect(remove.status).toBeGreaterThanOrEqual(400);
                expect(remove.status).toBeLessThan(500);

                expect(await listPaths()).toEqual(before);
            },
        );
    });
});
