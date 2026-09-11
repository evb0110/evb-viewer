import {
    describe, expect, it,
} from 'vitest';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const {
    checkArchitectureBoundaryEdge, checkArchitectureBoundarySource,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/architecture/boundary-check.mjs')).href
);

describe('contracts portability boundary', () => {
    it('rejects domain dependencies while allowing substantial portable codecs', () => {
        expect(checkArchitectureBoundaryEdge({
            source: 'packages/contracts/search.ts',
            target: 'packages/pdf-core/pdfSearchCore.ts',
            specifier: '@pdf-core/pdfSearchCore',
        })).toEqual([{
            rule: 'packages-contracts-layer',
            source: 'packages/contracts/search.ts',
            target: 'packages/pdf-core/pdfSearchCore.ts',
            specifier: '@pdf-core/pdfSearchCore',
            message: 'packages/contracts may depend only on itself and i18n-core leaf utilities.',
        }]);

        expect(checkArchitectureBoundarySource(
            'packages/contracts/portableCodec.ts',
            `export function decodePortableValues(values) {
    const decoded = [];
    for (const value of values) {
        if (typeof value === 'string' && value.length > 0) decoded.push(value);
    }
    return decoded;
}
`,
        )).toEqual([]);
    });

    it('rejects Node runtime imports, dynamic loads and globals while allowing portable code', () => {
        const rejectedSources = [
            'import {createHash} from \'node:crypto\';',
            'import fs, {type Stats} from \'node:fs\';',
            'import fs = require(\'fs\');',
            'export {readFile} from \'fs\';',
            'export {type Stats, readFile} from \'node:fs\';',
            'const crypto = await import(\'crypto\');',
            'const fs = require(\'node:fs\');',
            'export function readProcess() { return process.env.NODE_ENV; }',
            'export const bytes = Buffer.from(\'value\');',
        ];

        for (const sourceText of rejectedSources) {
            expect(checkArchitectureBoundarySource('packages/contracts/example.ts', sourceText))
                .toHaveLength(1);
        }

        expect(checkArchitectureBoundarySource(
            'packages/contracts/example.ts',
            'import type {Hash} from \'node:crypto\';\n'
                + 'export {type Stats} from \'node:fs\';\n'
                + 'export function readValue(value: unknown) {\n'
                + '    return globalThis.crypto.subtle && typeof value === \'string\';\n'
                + '}\n',
        )).toEqual([]);
    });
});
