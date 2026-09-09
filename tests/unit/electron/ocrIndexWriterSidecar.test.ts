import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdtemp,
    mkdir,
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeOcrIndexV3 } from '@electron/ocr/worker/indexWriter';
import {
    NATIVE_COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER as COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
    loadNativeCompactSearchIndex as loadCompactSearchIndex,
    persistNativeCompactSearchIndex as persistCompactSearchIndex,
} from '@electron/features/search/publicNative';
import { OCR_TEXT_LAYER_INDEX_VERSION } from '@contracts/ocrText';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireEpochMs} from '@contracts/timestamps';
import {requirePageNumber} from '@contracts/pageNumbers';
import {SEARCH_JS_WHOLE_VALUE_MAX_BYTES} from '@electron/features/search/public';

const DOCUMENT_REVISION = requireDocumentRevisionToken('revision-token');

const mocks = vi.hoisted(() => ({assertWorkingCopyRevisionCurrent: vi.fn()}));

vi.mock('@electron/file-access/documentRevisionSidecar', () => ({assertWorkingCopyRevisionSidecarCurrent: mocks.assertWorkingCopyRevisionCurrent}));

function makeDocumentRevision(documentRef: string) {
    return {
        version: 1 as const,
        documentRef: requireDocumentRef(documentRef),
        authority: 'electron-working-copy' as const,
        token: DOCUMENT_REVISION,
        contentRevision: 1,
        mintedAt: requireEpochMs(1),
    };
}

function writeOcrIndexV3ForTest(
    pdfPath: string,
    ocrPageData: Parameters<typeof writeOcrIndexV3>[2],
    pageCount: number,
    languages: string[],
    extractionDpi: number,
    log: Parameters<typeof writeOcrIndexV3>[6],
    signal?: AbortSignal,
) {
    return writeOcrIndexV3(
        pdfPath,
        makeDocumentRevision(pdfPath),
        ocrPageData,
        pageCount,
        languages,
        extractionDpi,
        log,
        signal,
    );
}

describe('writeOcrIndexV3 compact search sidecar', () => {
    let tempDir: string;

    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.assertWorkingCopyRevisionCurrent.mockResolvedValue(undefined);
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-sidecar-'));
    });

    afterEach(async () => {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
    });

    it('preserves OCR v3 JSON files while writing compact text-layer search text', async () => {
        const pdfPath = join(tempDir, 'work.pdf');

        await writeOcrIndexV3ForTest(pdfPath, [
            {
                pageNumber: 1,
                text: 'raw one',
                imageWidth: 100,
                imageHeight: 200,
                words: [
                    {
                        text: 'alpha',
                        x: 0,
                        y: 0,
                        width: 10,
                        height: 10,
                    },
                    {
                        text: 'beta',
                        x: 20,
                        y: 0,
                        width: 10,
                        height: 10,
                    },
                ],
            },
            {
                pageNumber: 2,
                text: 'raw two',
                imageWidth: 100,
                imageHeight: 200,
                words: [],
            },
        ], 2, ['eng'], 300, vi.fn());

        const manifest = JSON.parse(await readFile(`${pdfPath}.ocr/manifest.json`, 'utf-8')) as {pages: Record<string, {
            path: string;
            generation?: string;
        }>;};
        const firstPage = JSON.parse(await readFile(`${pdfPath}.ocr/page-0001.json`, 'utf-8')) as {canonicalText: {generation: string}};
        expect(manifest.pages).toEqual({
            1: {
                path: 'page-0001.json',
                generation: firstPage.canonicalText.generation,
            },
            2: {
                path: 'page-0002.json',
                generation: firstPage.canonicalText.generation,
            },
        });
        await expect(readFile(`${pdfPath}.ocr/page-0001.json`, 'utf-8')).resolves.toContain('"words"');

        const compactIndex = await loadCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            expectedPageCount: 2,
        });
        expect(compactIndex).toEqual({
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2,
            textSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
                version: OCR_TEXT_LAYER_INDEX_VERSION,
            },
            pages: [
                {
                    pageNumber: 1,
                    text: 'raw one',
                },
                {
                    pageNumber: 2,
                    text: 'raw two',
                },
            ],
        });
    });

    it('stages a result catalog without publishing OCR text into the live catalog', async () => {
        const pdfPath = join(tempDir, 'work.pdf');
        const resultPdfPath = join(tempDir, 'ocr-result.pdf');
        const liveCatalogPath = `${pdfPath}.ocr`;
        await mkdir(liveCatalogPath, {recursive: true});
        await writeFile(join(liveCatalogPath, 'manifest.json'), JSON.stringify({
            version: 3,
            documentRevision: {token: DOCUMENT_REVISION},
            createdAt: 1,
            source: {pdfPath},
            pageCount: 1,
            pageBox: 'crop',
            ocr: {
                engine: 'tesseract',
                languages: ['eng'],
                renderDpi: 300,
            },
            pages: {},
        }));

        await writeOcrIndexV3(
            pdfPath,
            makeDocumentRevision(pdfPath),
            [{
                pageNumber: 1,
                text: 'private until apply',
                imageWidth: 100,
                imageHeight: 200,
                words: [],
            }],
            1,
            ['eng'],
            300,
            vi.fn(),
            undefined,
            resultPdfPath,
        );

        await expect(readFile(join(liveCatalogPath, 'manifest.json'), 'utf8'))
            .resolves.not.toContain('private until apply');
        await expect(readFile(join(`${resultPdfPath}.ocr`, 'page-0001.json'), 'utf8'))
            .resolves.toContain('private until apply');
        expect(await loadCompactSearchIndex(resultPdfPath, {documentRevision: DOCUMENT_REVISION})).toBeNull();
    });

    it('invalidates an existing compact sidecar for an oversized direct OCR write', async () => {
        const pdfPath = join(tempDir, 'oversized.pdf');
        await writeFile(pdfPath, Buffer.alloc(SEARCH_JS_WHOLE_VALUE_MAX_BYTES + 1));
        await persistCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
            pages: [{
                pageNumber: requirePageNumber(1),
                text: 'stale text',
            }],
        });

        await writeOcrIndexV3ForTest(pdfPath, [{
            pageNumber: 1,
            text: 'fresh OCR text',
            imageWidth: 100,
            imageHeight: 200,
            words: [],
        }], 1, ['eng'], 300, vi.fn());

        await expect(loadCompactSearchIndex(pdfPath, {documentRevision: DOCUMENT_REVISION})).resolves.toBeNull();
        await expect(readFile(join(`${pdfPath}.ocr`, 'page-0001.json'), 'utf-8'))
            .resolves.toContain('fresh OCR text');
    });

    it('merges a partial OCR rerun into the existing compact sidecar', async () => {
        const pdfPath = join(tempDir, 'partial.pdf');
        await writeOcrIndexV3ForTest(pdfPath, [
            {
                pageNumber: 1,
                text: 'original one',
                imageWidth: 100,
                imageHeight: 200,
                words: [],
            },
            {
                pageNumber: 2,
                text: 'original two',
                imageWidth: 100,
                imageHeight: 200,
                words: [],
            },
        ], 2, ['eng'], 300, vi.fn());

        await writeOcrIndexV3ForTest(pdfPath, [{
            pageNumber: 2,
            text: 'updated two',
            imageWidth: 100,
            imageHeight: 200,
            words: [],
        }], 2, ['eng'], 300, vi.fn());

        const compactIndex = await loadCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            expectedPageCount: 2,
        });
        expect(compactIndex).toEqual({
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2,
            textSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
                version: OCR_TEXT_LAYER_INDEX_VERSION,
            },
            pages: [
                {
                    pageNumber: requirePageNumber(1),
                    text: 'original one',
                },
                {
                    pageNumber: requirePageNumber(2),
                    text: 'updated two',
                },
            ],
        });
    });

    it('ignores generic compact sidecars when preserving partial OCR pages', async () => {
        const pdfPath = join(tempDir, 'generic-collision.pdf');
        await writeOcrIndexV3ForTest(pdfPath, [
            {
                pageNumber: 1,
                text: 'authoritative json one',
                imageWidth: 100,
                imageHeight: 200,
                words: [],
            },
            {
                pageNumber: 2,
                text: 'authoritative json two',
                imageWidth: 100,
                imageHeight: 200,
                words: [],
            },
        ], 2, ['eng'], 300, vi.fn());

        await persistCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2,
            pages: [
                {
                    pageNumber: requirePageNumber(1),
                    text: 'generic sidecar one',
                },
                {
                    pageNumber: requirePageNumber(2),
                    text: 'generic sidecar two',
                },
            ],
        });

        await writeOcrIndexV3ForTest(pdfPath, [{
            pageNumber: 2,
            text: 'updated json two',
            imageWidth: 100,
            imageHeight: 200,
            words: [],
        }], 2, ['eng'], 300, vi.fn());

        const compactIndex = await loadCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            expectedPageCount: 2,
        });
        expect(compactIndex).toEqual({
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2,
            textSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
                version: OCR_TEXT_LAYER_INDEX_VERSION,
            },
            pages: [
                {
                    pageNumber: 1,
                    text: 'authoritative json one',
                },
                {
                    pageNumber: 2,
                    text: 'updated json two',
                },
            ],
        });
    });
});
