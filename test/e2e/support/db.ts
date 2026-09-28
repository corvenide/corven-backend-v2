// Direct database access for test setup the API can't do on its own.
// Needs E2E_DATABASE_URL (test/e2e/run.sh sets it).

import { Client } from 'pg';

export const DATABASE_URL = process.env.E2E_DATABASE_URL;

let client: Client | null = null;

async function db(): Promise<Client> {
    if (!DATABASE_URL) throw new Error('E2E_DATABASE_URL is not set');

    if (!client) {
        client = new Client({ connectionString: DATABASE_URL });
        await client.connect();
    }

    return client;
}

/**
 * Makes a workspace look like one that has started before and is now
 * stopped. Its files are then served from the database copy, which is what
 * users edit while a workspace is off.
 */
export async function markStartedBefore(workspaceId: string): Promise<void> {
    const result = await (await db()).query(
        `UPDATE "Workspace" SET "filesSnapshotAt" = now(), "status" = 'STOPPED' WHERE "id" = $1`,
        [workspaceId],
    );

    if (result.rowCount !== 1) throw new Error(`Workspace ${workspaceId} not found`);
}

export async function disconnect(): Promise<void> {
    await client?.end();
    client = null;
}
