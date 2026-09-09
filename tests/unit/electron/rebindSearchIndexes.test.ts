import {
    mkdtemp,
    readFile,
    rm,
    stat,
    truncate,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requirePageNumber} from '@contracts/pageNumbers';
import * as searchIndexBuilder from '@electron/features/search/indexBuilder';
import * as searchIndexSidecar from '@electron/features/search/searchIndexSidecar';
import {
    loadCompactSearchIndex,
    persistCompactSearchIndex,
    persistCompactSearchIndexStreaming,
} from '@electron/features/search/searchIndexSidecar';
import {loadSearchIndex} from '@electron/features/search/indexBuilder';
import {
    rebindSearchIndexes,
    SEARCH_JS_WHOLE_VALUE_MAX_BYTES,
} from '@electron/features/search/public';

const OLD_TOKEN = requireDocumentRevisionToken('drt1:rebind:old');
const NEW_TOKEN = requireDocumentRevisionToken('drt1:rebind:new');

vi.mock('@electron/features/ocr/public/catalog', () => ({visitDocumentOcrCatalogPages: vi.fn()}));

describe('search index revision rebind', () => {
    let root = '';

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(root, {
            recursive: true,
            force: true,
        });
    });

    it('preserves small legacy and compact indexes while rebinding their revision', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-search-rebind-small-'));
        const path = join(root, 'working.pdf');
        await writeFile(path, '%PDF fixture');
        await writeFile(`${path}.index.json`, JSON.stringify({
            schemaVersion: 7,
            documentRevision: {token: OLD_TOKEN},
            pdfPath: path,
            createdAt: 1,
            pageCount: 1,
            pages: [{
                pageNumber: requirePageNumber(1),
                text: 'small',
            }],
        }));
        await persistCompactSearchIndex(path, {
            documentRevision: OLD_TOKEN,
            pageCount: 1,
            pages: [{
                pageNumber: requirePageNumber(1),
                text: 'small',
            }],
        });

        await expect(rebindSearchIndexes(path, OLD_TOKEN, NEW_TOKEN)).resolves.toBe(true);
        await expect(loadSearchIndex(path, NEW_TOKEN)).resolves.toMatchObject({
            documentRevision: {token: NEW_TOKEN},
            pageCount: 1,
            pages: [{
                pageNumber: requirePageNumber(1),
                text: 'small',
            }],
        });
        await expect(loadCompactSearchIndex(path, {documentRevision: NEW_TOKEN})).resolves.toMatchObject({
            documentRevision: NEW_TOKEN,
            pageCount: 1,
            pages: [{
                pageNumber: requirePageNumber(1),
                text: 'small',
            }],
        });
    });

    it('removes a sparse high-page-count v3 sidecar without loading or persisting either index', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-search-rebind-xlarge-'));
        const path = join(root, 'working.pdf');
        const pageCount = 201;
        await writeFile(path, '%PDF fixture');
        await writeFile(`${path}.index.json`, JSON.stringify({
            schemaVersion: 7,
            documentRevision: {token: OLD_TOKEN},
            pdfPath: path,
            createdAt: 1,
            pageCount,
            pages: [{
                pageNumber: requirePageNumber(1),
                text: 'sparse',
            }],
        }));
        await persistCompactSearchIndexStreaming(
            path,
            {
                documentRevision: OLD_TOKEN,
                pageCount,
            },
            [{
                pageNumber: requirePageNumber(1),
                text: 'sparse',
            }],
        );

        const loadLegacy = vi.spyOn(searchIndexBuilder, 'loadSearchIndex');
        const loadCompact = vi.spyOn(searchIndexSidecar, 'loadCompactSearchIndex');
        const persistCompact = vi.spyOn(searchIndexSidecar, 'persistCompactSearchIndex');

        await expect(rebindSearchIndexes(path, OLD_TOKEN, NEW_TOKEN)).resolves.toBe(true);

        expect(loadLegacy).not.toHaveBeenCalled();
        expect(loadCompact).not.toHaveBeenCalled();
        expect(persistCompact).not.toHaveBeenCalled();
        await expect(stat(`${path}.index.json`)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(stat(`${path}.index.evb-search-v2.bin`)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(readFile(`${path}.index.json`, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('uses only file-size metadata for a large source before invalidating its sidecars', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-search-rebind-size-'));
        const path = join(root, 'working.pdf');
        await writeFile(path, '%PDF fixture');
        await truncate(path, SEARCH_JS_WHOLE_VALUE_MAX_BYTES + 1);
        await writeFile(`${path}.index.json`, JSON.stringify({
            schemaVersion: 7,
            documentRevision: {token: OLD_TOKEN},
            pdfPath: path,
            createdAt: 1,
            pageCount: 1,
            pages: [{
                pageNumber: requirePageNumber(1),
                text: 'large source',
            }],
        }));
        await persistCompactSearchIndex(path, {
            documentRevision: OLD_TOKEN,
            pageCount: 1,
            pages: [{
                pageNumber: requirePageNumber(1),
                text: 'large source',
            }],
        });

        const loadLegacy = vi.spyOn(searchIndexBuilder, 'loadSearchIndex');
        const loadCompact = vi.spyOn(searchIndexSidecar, 'loadCompactSearchIndex');
        const persistCompact = vi.spyOn(searchIndexSidecar, 'persistCompactSearchIndex');

        await expect(rebindSearchIndexes(path, OLD_TOKEN, NEW_TOKEN)).resolves.toBe(true);

        expect(loadLegacy).not.toHaveBeenCalled();
        expect(loadCompact).not.toHaveBeenCalled();
        expect(persistCompact).not.toHaveBeenCalled();
        await expect(stat(`${path}.index.json`)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(stat(`${path}.index.evb-search-v2.bin`)).rejects.toMatchObject({code: 'ENOENT'});
    });
});
