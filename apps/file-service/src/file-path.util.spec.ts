import { BadRequestException } from '@nestjs/common';

import { normalizeWorkspacePath, toContainerPath } from './file-path.util';

describe('normalizeWorkspacePath', () => {
    it.each([
        ['src/main.rs', 'src/main.rs'],
        ['./src/main.rs', 'src/main.rs'],
        ['src//lib/../main.rs', 'src/main.rs'],
        ['  Cargo.toml  ', 'Cargo.toml'],
        ['contracts\\hello-world\\src\\main.rs', 'contracts/hello-world/src/main.rs'],
        // A leading slash means "from the workspace root", not the filesystem root.
        ['/src/main.rs', 'src/main.rs'],
        ['contracts/', 'contracts'],
        ['//etc/passwd', 'etc/passwd'],
    ])('normalizes %j to %j', (input, expected) => {
        expect(normalizeWorkspacePath(input)).toBe(expected);
    });

    it.each([
        '..',
        '../secrets',
        '../../etc/passwd',
        'src/../../outside',
        '..\\..\\etc\\passwd',
        '/../etc/passwd',
    ])('rejects %j, which would leave the workspace', (input) => {
        expect(() => normalizeWorkspacePath(input)).toThrow('Path must remain inside the workspace');
    });

    it.each(['', '   ', '.', './', './/', 'src/..', 'src/../'])('rejects %j, which is the workspace root, not a file in it', (input) => {
        expect(() => normalizeWorkspacePath(input)).toThrow(BadRequestException);
    });

    it('rejects paths containing a NUL byte', () => {
        expect(() => normalizeWorkspacePath('src/main.rs\0.png')).toThrow('Invalid file path');
    });

    it('rejects non-string input', () => {
        expect(() => normalizeWorkspacePath(undefined as unknown as string)).toThrow('File path is required');
        expect(() => normalizeWorkspacePath({} as unknown as string)).toThrow('File path is required');
    });
});

describe('toContainerPath', () => {
    it('places the path under /workspace', () => {
        expect(toContainerPath('contracts/hello-world/src/main.rs')).toBe(
            '/workspace/contracts/hello-world/src/main.rs',
        );
        expect(toContainerPath('/Cargo.toml')).toBe('/workspace/Cargo.toml');
    });

    it('never resolves outside /workspace', () => {
        expect(() => toContainerPath('../etc/shadow')).toThrow(BadRequestException);
    });
});
