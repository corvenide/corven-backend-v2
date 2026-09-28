// libs/prisma/src/workspace-templates.ts
//
// Project templates a workspace can start from. Each one is baked into the
// runtime image, pre-built, at $CORVEN_TEMPLATE_DIR/<id>/<project>
// (docker/ckb-runtime/templates, built by build-templates.sh). Keep this list
// in step with that directory.

export interface WorkspaceTemplate {
    id: string;
    name: string;
    description: string;
    /** Contract crates in contracts/, first one is the main contract. */
    contracts: string[];
}

export const DEFAULT_TEMPLATE_ID = 'hello-world';

export const WORKSPACE_TEMPLATES: readonly WorkspaceTemplate[] = [
    {
        id: 'hello-world',
        name: 'Hello world',
        description: 'The minimal ckb-script-templates contract. A clean starting point.',
        contracts: ['hello-world'],
    },
    {
        id: 'simple-udt',
        name: 'Fungible token (sUDT)',
        description: 'A token type script: the issuer mints, holders transfer, amounts can never grow. With tests.',
        contracts: ['simple-udt'],
    },
    {
        id: 'time-lock',
        name: 'Time lock',
        description: 'A lock script that keeps CKB locked until a block number, then lets its owner spend it. With tests.',
        contracts: ['time-lock'],
    },
];

export function findTemplate(id: string | null | undefined): WorkspaceTemplate | undefined {
    return WORKSPACE_TEMPLATES.find((t) => t.id === id);
}

/** The template for a workspace; unknown or missing ids (older workspaces) get the default. */
export function resolveTemplate(id: string | null | undefined): WorkspaceTemplate {
    return findTemplate(id) ?? findTemplate(DEFAULT_TEMPLATE_ID)!;
}
