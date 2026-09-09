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
});
