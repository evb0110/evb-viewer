import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('search publicNative lazy imports', () => {
    it('uses module-local literal loaders for packaged runtime imports', async () => {
        const source = await readFile(
            join(process.cwd(), 'electron/features/search/publicNative.ts'),
            'utf8',
        );

        expect(source).not.toMatch(/import\(\s*['"]@electron\/features\/search\//u);
        expect(source).toMatch(/import\(['"]\.\/searchIndexSidecar['"]\)/u);
        expect(source).toMatch(/import\(['"]\.\/searchIndexBuilderPublic['"]\)/u);
        expect(source).toMatch(/import\(['"]\.\/rebindSearchIndexes['"]\)/u);
    });
});
