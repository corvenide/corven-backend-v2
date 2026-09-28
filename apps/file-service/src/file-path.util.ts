// apps/file-service/src/file-path.util.ts
import { BadRequestException } from '@nestjs/common';
import path from 'node:path';

const WORKSPACE_ROOT = '/workspace';

export function normalizeWorkspacePath(
    inputPath: string,
): string {
    if (
        typeof inputPath !== 'string' ||
        !inputPath.trim()
    ) {
        throw new BadRequestException(
            'File path is required',
        );
    }

    const cleaned = inputPath
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');

    if (cleaned.includes('\0')) {
        throw new BadRequestException(
            'Invalid file path',
        );
    }

    // Drop trailing slashes so "./" and "src/../" are caught below as the
    // workspace root instead of becoming "/workspace/".
    const normalized = path.posix
        .normalize(cleaned)
        .replace(/\/+$/, '');

    if (
        normalized === '..' ||
        normalized.startsWith('../') ||
        path.posix.isAbsolute(normalized)
    ) {
        throw new BadRequestException(
            'Path must remain inside the workspace',
        );
    }

    if (
        normalized === '.' ||
        normalized === ''
    ) {
        throw new BadRequestException(
            'Invalid workspace path',
        );
    }

    return normalized;
}

export function toContainerPath(
    inputPath: string,
): string {
    const normalized =
        normalizeWorkspacePath(inputPath);

    return path.posix.join(
        WORKSPACE_ROOT,
        normalized,
    );
}