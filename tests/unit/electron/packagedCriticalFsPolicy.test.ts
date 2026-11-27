import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

// ADR 0001: packaged Windows Electron's ASAR fs shim mishandles fs.promises
// metadata calls (lstat/realpath/stat), rejecting valid working-copy paths
// while the sync fs API works. Linux and macOS CI stay green through that
// regression, so this tripwire is the only pre-release signal: these
// packaged-critical files must not import metadata functions from
// fs/promises. Bulk data I/O (readFile, open) stays async and allowed.
const PACKAGED_CRITICAL_FILES = [
    'electron/utils/pathValidator.ts',
    'electron/features/documents/main/documentFilePathResolution.ts',
    'electron/features/documents/main/documentFileReadHandlers.ts',
];

const FORBIDDEN_PROMISE_METADATA_IMPORTS = ['lstat', 'realpath', 'stat', 'access'];

function fsPromisesImportBlocks(source: string) {
    return [...source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'](?:node:)?fs\/promises["']/gu)].map(
        (match) => match[1] ?? '',
    );
}

// A namespace or default import would let metadata calls hide behind a
// prefix (fsp.lstat), so only named-brace imports are allowed at all.
function hasNonBraceFsPromisesImport(source: string) {
    return [...source.matchAll(/import\s+([^;]*?)from\s*["'](?:node:)?fs\/promises["']/gu)].some(
        (match) => !(match[1] ?? '').trimEnd().endsWith('}'),
    );
}

describe('packaged-critical fs policy (ADR 0001)', () => {
    for (const filePath of PACKAGED_CRITICAL_FILES) {
        it(`keeps fs metadata synchronous in ${filePath}`, async () => {
            const source = await readFile(filePath, 'utf8');
            expect(hasNonBraceFsPromisesImport(source), `${filePath} must import fs/promises by named bindings only`).toBe(false);
            for (const importBlock of fsPromisesImportBlocks(source)) {
                const importedNames = importBlock
                    .split(',')
                    .map(
                        (name) =>
                            name
                                .trim()
                                .split(/\s+as\s+/u)[0]
                                ?.trim() ?? '',
                    )
                    .filter(Boolean);
                const forbidden = importedNames.filter((name) => FORBIDDEN_PROMISE_METADATA_IMPORTS.includes(name));
                expect(forbidden, `${filePath} imports fs.promises metadata functions`).toEqual([]);
            }
        });
    }
});
