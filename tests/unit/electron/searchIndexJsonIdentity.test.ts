import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
})}));
vi.mock('@electron/features/ocr/public/catalog', () => ({visitDocumentOcrCatalogPages: vi.fn()}));

describe('search index JSON identity', () => {
    const documentRevision = requireDocumentRevisionToken('revision-token');
    let tempDir = '';

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-search-index-json-'));
    });

    afterEach(async () => {
        await rm(tempDir, {
            force: true,
            recursive: true,
        });
    });

    it('ignores a valid-looking cached index for a different PDF path', async () => {
        const pdfPath = join(tempDir, 'current.pdf');
        const otherPdfPath = join(tempDir, 'other.pdf');
        await writeFile(`${pdfPath}.index.json`, JSON.stringify({
            schemaVersion: 7,
            documentRevision: {token: documentRevision},
            pdfPath: otherPdfPath,
            createdAt: Date.now(),
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: 'wrong document',
            }],
        }));

        const { loadSearchIndex } = await import('@electron/features/search/indexBuilder');

        await expect(loadSearchIndex(pdfPath, documentRevision)).resolves.toBeNull();
    });
});
