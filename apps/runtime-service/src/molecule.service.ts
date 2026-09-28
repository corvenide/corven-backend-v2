// apps/runtime-service/src/molecule.service.ts
//
// Molecule bindings: runs moleculec (baked into the runtime image) on a
// .mol schema in the workspace and writes the generated code next to it,
// <name>.rs for Rust or <name>.h for C. The workspace's periodic snapshot
// picks the new file up like any other file the build writes.

import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import path from 'node:path';

import { recordWorkspaceActivity } from 'libs/prisma/src/workspace-activity';
import { PrismaService } from 'libs/prisma/src/prisma.service';

import { ContractsService } from './contracts.service';

export type MoleculeLanguage = 'rust' | 'c';

const EXTENSIONS: Record<MoleculeLanguage, string> = { rust: '.rs', c: '.h' };

/** Largest schema accepted (schemas are small; this is only a sanity bound). */
const MAX_SCHEMA_BYTES = 256 * 1024;

/**
 * $1 schema, $2 output, $3 language. Writes the output only on success, so a
 * broken schema never clobbers the last good bindings.
 */
const GENERATE_SCRIPT = String.raw`
set -u
if [ ! -f "$1" ]; then echo "Schema not found: $1" >&2; exit 2; fi
if [ "$(wc -c < "$1")" -gt ${MAX_SCHEMA_BYTES} ]; then echo "Schema is too large." >&2; exit 2; fi
tmp="$(mktemp)"
if moleculec --language "$3" --schema-file "$1" > "$tmp" 2> "$tmp.err"; then
    cat "$tmp" > "$2"
    rm -f "$tmp" "$tmp.err"
    wc -c < "$2"
else
    cat "$tmp.err" >&2
    rm -f "$tmp" "$tmp.err"
    exit 1
fi
`;

export interface MoleculeResult {
    schemaPath: string;
    outputPath: string;
    language: MoleculeLanguage;
    bytes: number;
}

@Injectable()
export class MoleculeService {
    constructor(
        private readonly contracts: ContractsService,
        private readonly prisma: PrismaService,
    ) { }

    async generate(payload: {
        workspaceId: string;
        userId: string;
        path: unknown;
        language?: unknown;
    }): Promise<MoleculeResult> {
        const schemaPath = normalizeSchemaPath(payload.path);
        const language = payload.language === 'c' ? 'c' : payload.language === 'rust' || payload.language == null ? 'rust' : null;
        if (!language) throw new RpcException('Language must be "rust" or "c".');

        const outputPath = schemaPath.replace(/\.mol$/, EXTENSIONS[language]);
        const { client, runtimeId } = await this.contracts.runningRuntime(payload.workspaceId, payload.userId);

        const result = await client.executeCommand({
            containerId: runtimeId,
            command: ['bash', '-c', GENERATE_SCRIPT, 'molecule', `/workspace/${schemaPath}`, `/workspace/${outputPath}`, language],
            workingDirectory: '/workspace',
        });

        if (result.exitCode === 127 || /moleculec: (command )?not found/.test(result.stderr)) {
            throw new RpcException('moleculec is not installed in this runtime image. Rebuild docker/ckb-runtime.');
        }
        if (result.exitCode !== 0) {
            throw new RpcException(describeMoleculeError(result.stderr || result.stdout));
        }

        await recordWorkspaceActivity(this.prisma, payload.workspaceId);

        return { schemaPath, outputPath, language, bytes: Number(result.stdout.trim()) || 0 };
    }
}

/** Workspace-relative path to a .mol file; rejects anything outside /workspace. */
export function normalizeSchemaPath(input: unknown): string {
    if (typeof input !== 'string' || !input.trim() || input.includes('\0')) {
        throw new RpcException('Schema path is required.');
    }

    const cleaned = input.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/^workspace\//, '');
    const normalized = path.posix.normalize(cleaned);

    if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
        throw new RpcException('Path must stay inside the workspace.');
    }
    if (!normalized.endsWith('.mol')) throw new RpcException('Pick a Molecule schema (.mol file).');

    return normalized;
}

/** Turns moleculec's panic output into one readable line. */
export function describeMoleculeError(output: string): string {
    const text = output.trim();

    const parse = /line_col: Pos\(\((\d+), (\d+)\)\)/.exec(text);
    if (parse) {
        const expected = /positives: \[([^\]]*)\]/.exec(text)?.[1]?.trim();
        const line = /line: "((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
        return [
            `Syntax error at line ${parse[1]}, column ${parse[2]}`,
            expected ? `: expected ${expected.replace(/_/g, ' ')}` : '',
            line ? ` in \`${line.trim()}\`` : '',
        ].join('');
    }

    // Other failures: the first panic's message, the line after "panicked at …:".
    const lines = text.split('\n');
    const at = lines.findIndex((l) => /panicked at /.test(l));
    if (at >= 0 && lines[at + 1]?.trim()) return `Schema error: ${lines[at + 1].trim()}`;

    const first = lines.find((l) => l.trim());
    return first ? first.trim().slice(0, 500) : 'moleculec failed.';
}
