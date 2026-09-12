import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import type {TOcrPageArtifact} from '@contracts/ocrIndex';
import {OcrCatalogCorruptError} from '@electron/features/ocr/main/ocrCatalogV4';

const state = vi.hoisted(() => {
    const page: TOcrPageArtifact = {
        rotation: 0,
        render: {
            dpi: 300,
            imagePx: {
                w: 1200,
                h: 1600,
            },
        },
        text: 'sparse page',
        words: [],
    };
    const handle = {
        header: {
            version: 4 as const,
            catalogId: '123e4567-e89b-42d3-a456-426614174000',
            source: {pdfPath: '/tmp/large.pdf'},
            documentRevision: {token: 'drt1:v4-consumer'},
            pageCount: 1_000_001,
            generation: 7,
            mappedPageCount: 1,
            complete: false,
        },
        readPage: vi.fn(async (pageNumber: number) => pageNumber === 900_000 ? page : null),
        readWindow: vi.fn(async function* (start: number, count: number) {
            for (let index = 0; index < count; index += 1) {
                yield {
                    pageNumber: start + index,
                    artifact: start + index === 900_000 ? page : null,
                };
            }
        }),
        readWindowMappings: vi.fn(async (start: number, count: number) => Array.from(
            {length: count},
            (_value, index) => ({
                pageNumber: start + index,
                mapping: null,
            }),
        )),
        windowAvailability: vi.fn(async (start: number, count: number) => {
            const value = new Uint8Array(count);
            if (900_000 >= start && 900_000 < start + count) {
                value[900_000 - start] = 1;
            }
            return value;
        }),
        iterateMappedPages: vi.fn(async function* () {
            yield {
                pageNumber: 900_000,
                artifact: page,
            };
        }),
        findFirstUnmapped: vi.fn(async () => 1),
        close: vi.fn(async () => undefined),
    };
    const openCatalog = vi.fn<() => Promise<typeof handle | null>>(async () => handle);
    return {
        page,
        handle,
        openCatalog,
        extractTextFromPdf: vi.fn(async () => []),
        extractTextWithPdfjsWordBoxes: vi.fn(async () => []),
        assertWorkingCopyRevisionSidecarCurrent: vi.fn(async () => undefined),
    };
});

vi.mock('@electron/features/ocr/main/ocrCatalogV4', async () => {
    const actual = await vi.importActual('@electron/features/ocr/main/ocrCatalogV4') as Record<string, unknown>;
    return {
        ...actual,
        openCatalog: state.openCatalog,
    };
});
vi.mock('@electron/features/search/extractTextFromPdf', () => ({extractTextFromPdf: state.extractTextFromPdf}));
vi.mock('@electron/features/search/loadPdfjsTextExtractor', () => ({loadPdfjsTextExtractor: async () => ({extractTextWithPdfjsWordBoxes: state.extractTextWithPdfjsWordBoxes})}));
// assembleSearchablePageText spreads per-character offset arrays and overflows
// the stack for pages above roughly 128 KiB, so budget tests bypass it.
vi.mock('@contracts/search', async () => {
    const actual = await vi.importActual('@contracts/search') as Record<string, unknown>;
    return {
        ...actual,
        assembleSearchablePageText: (items: ReadonlyArray<{text: string}>) => ({
            text: items.map(item => item.text).join(' '),
            itemOffsets: [],
            sourceOffsets: [],
        }),
    };
});
vi.mock('@electron/file-access/documentRevisionSidecar', () => ({assertWorkingCopyRevisionSidecarCurrent: state.assertWorkingCopyRevisionSidecarCurrent}));

const {
    resolveDocumentOcrAvailability,
    resolveDocumentOcrPage,
    resolveDocumentTextCatalogSnapshot,
    resolveDocumentTextCatalogWindow,
} = await import('@electron/features/ocr/main/documentTextCatalog');

const DOCUMENT_REVISION = requireDocumentRevisionToken('drt1:v4-consumer');
const OTHER_DOCUMENT_REVISION = requireDocumentRevisionToken('drt1:v4-consumer-new');
const recoveryTestRoots: string[] = [];

afterEach(async () => {
    await Promise.all(recoveryTestRoots.splice(0).map(root => rm(root, {
        recursive: true,
        force: true,
    })));
});

describe('DocumentTextCatalog v4 consumers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('keeps million-page sparse availability range-based and bounded', async () => {
        const availability = await resolveDocumentOcrAvailability('/tmp/large.pdf', DOCUMENT_REVISION);

        expect(availability).toEqual({
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1_000_001,
            mappedPageCount: 1,
            pageRanges: [{
                firstPage: 900_000,
                lastPage: 900_000,
            }],
            rangesComplete: true,
        });
        expect('pageNumbers' in availability).toBe(false);
        expect(state.handle.windowAvailability).toHaveBeenCalled();
        expect(state.handle.windowAvailability.mock.calls.every(([
            _start,
            count,
        ]) => count <= 256)).toBe(true);
    });

    it('marks a corrupt catalog for OCR rebuild instead of reporting it as absent', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-ocr-catalog-recovery-'));
        recoveryTestRoots.push(root);
        const workingCopyPath = join(root, 'document.pdf');
        await mkdir(`${workingCopyPath}.ocr`);
        state.openCatalog.mockRejectedValueOnce(new OcrCatalogCorruptError('truncated shard index'));

        await expect(resolveDocumentOcrAvailability(workingCopyPath, DOCUMENT_REVISION)).resolves.toMatchObject({
            documentRevision: DOCUMENT_REVISION,
            pageCount: 0,
            mappedPageCount: 0,
            pageRanges: [],
            rangesComplete: true,
            needsReOcr: true,
        });

        const entries = await readdir(root);
        expect(entries.some(entry => entry.startsWith('document.pdf.ocr.') && entry.endsWith('.corrupt'))).toBe(true);
        const recoveryReceipt = entries.find(entry => entry === 'document.pdf.ocr.recovery.json');
        expect(recoveryReceipt).toBeDefined();
        await expect(readFile(join(root, recoveryReceipt!), 'utf8')).resolves.toContain('truncated shard index');

        state.openCatalog.mockResolvedValueOnce(null);
        await expect(resolveDocumentOcrAvailability(workingCopyPath, OTHER_DOCUMENT_REVISION))
            .resolves.not.toHaveProperty('needsReOcr');
    });

    it('addresses one v4 page and one v4 window without a snapshot', async () => {
        await expect(resolveDocumentOcrPage('/tmp/large.pdf', DOCUMENT_REVISION, 900_000))
            .resolves.toMatchObject({
                pageCount: 1_000_001,
                page: {
                    pageNumber: 900_000,
                    source: 'evb-ocr',
                    text: 'sparse page',
                },
            });
        await expect(resolveDocumentTextCatalogWindow(
            '/tmp/large.pdf',
            DOCUMENT_REVISION,
            900_000,
            900_000,
            1_000_001,
        )).resolves.toMatchObject({
            pageCount: 1_000_001,
            pages: [{
                pageNumber: 900_000,
                source: 'evb-ocr',
            }],
        });
        expect(state.handle.readPage).toHaveBeenCalledWith(900_000);
        expect(state.handle.readWindow).toHaveBeenCalledWith(900_000, 1);
    });

    it('rejects an oversized text window before traversing an xlarge catalog', async () => {
        await expect(resolveDocumentTextCatalogWindow(
            '/tmp/large.pdf',
            DOCUMENT_REVISION,
            1,
            65,
            1_000_001,
        )).rejects.toThrow('Invalid document text catalog window');
        expect(state.handle.readWindow).not.toHaveBeenCalled();
        expect(state.extractTextFromPdf).not.toHaveBeenCalled();
    });

    it('rejects a whole-document snapshot before allocating xlarge PDF text', async () => {
        await expect(resolveDocumentTextCatalogSnapshot(
            '/tmp/large.pdf',
            DOCUMENT_REVISION,
            1_000_001,
        )).rejects.toMatchObject({
            code: 'OCR_CATALOG_TOO_LARGE',
            pageCount: 1_000_001,
        });
        expect(state.extractTextFromPdf).not.toHaveBeenCalled();
        expect(state.extractTextWithPdfjsWordBoxes).not.toHaveBeenCalled();
    });

    it('rejects an unbounded snapshot when no catalog supplies a page count', async () => {
        state.openCatalog.mockResolvedValueOnce(null);

        await expect(resolveDocumentTextCatalogSnapshot(
            '/tmp/unknown.pdf',
            DOCUMENT_REVISION,
        )).rejects.toThrow('requires a bounded page count');
        expect(state.extractTextFromPdf).not.toHaveBeenCalled();
        expect(state.extractTextWithPdfjsWordBoxes).not.toHaveBeenCalled();
    });
});

describe('DocumentTextCatalog availability validation (SRCH-004)', () => {
    it('does not trust a complete header over per-page artifact availability', async () => {
        const header = state.handle.header;
        const originalMappedPageCount = header.mappedPageCount;
        header.complete = true;
        header.mappedPageCount = header.pageCount;
        try {
            const availability = await resolveDocumentOcrAvailability('/tmp/large.pdf', DOCUMENT_REVISION);

            expect(availability).toEqual({
                documentRevision: DOCUMENT_REVISION,
                pageCount: 1_000_001,
                mappedPageCount: 1,
                pageRanges: [{
                    firstPage: 900_000,
                    lastPage: 900_000,
                }],
                rangesComplete: true,
            });
            expect(state.handle.windowAvailability).toHaveBeenCalled();
        } finally {
            header.complete = false;
            header.mappedPageCount = originalMappedPageCount;
        }
    });
});

describe('DocumentTextCatalog bounded, revision-safe reads (SRCH-005)', () => {
    const MIB = 1024 * 1024;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        state.assertWorkingCopyRevisionSidecarCurrent.mockReset();
        state.assertWorkingCopyRevisionSidecarCurrent.mockResolvedValue(undefined);
    });

    it('rejects an invalid window before opening the catalog', async () => {
        await expect(resolveDocumentTextCatalogWindow(
            '/tmp/large.pdf',
            DOCUMENT_REVISION,
            1,
            65,
            1_000_001,
        )).rejects.toThrow('Invalid document text catalog window');
        expect(state.openCatalog).not.toHaveBeenCalled();
    });

    it('rejects an oversized snapshot page count before opening the catalog', async () => {
        await expect(resolveDocumentTextCatalogSnapshot(
            '/tmp/large.pdf',
            DOCUMENT_REVISION,
            1_000_001,
        )).rejects.toMatchObject({code: 'OCR_CATALOG_TOO_LARGE'});
        expect(state.openCatalog).not.toHaveBeenCalled();
    });

    it('stops pulling window pages once the window text budget is exceeded', async () => {
        let pulled = 0;
        state.handle.readWindow.mockImplementationOnce(async function* (start: number, count: number) {
            for (let index = 0; index < count; index += 1) {
                pulled += 1;
                yield {
                    pageNumber: start + index,
                    artifact: {
                        ...state.page,
                        text: 'x'.repeat(16 * MIB),
                    },
                };
            }
        });

        await expect(resolveDocumentTextCatalogWindow(
            '/tmp/large.pdf',
            DOCUMENT_REVISION,
            900_000,
            900_009,
            1_000_001,
        )).rejects.toThrow('bounded text budget');
        expect(pulled).toBe(5);
    });

    it('does not emit a window read across a working-copy revision change', async () => {
        state.extractTextFromPdf.mockImplementationOnce(async () => {
            state.assertWorkingCopyRevisionSidecarCurrent.mockRejectedValue(new Error('stale revision'));
            return [];
        });

        await expect(resolveDocumentTextCatalogWindow(
            '/tmp/large.pdf',
            DOCUMENT_REVISION,
            900_000,
            900_000,
            1_000_001,
        )).rejects.toThrow('stale revision');
    });

    it('stops pulling snapshot pages once the aggregate text budget is exceeded', async () => {
        let pulled = 0;
        state.openCatalog.mockResolvedValueOnce({
            ...state.handle,
            header: {
                ...state.handle.header,
                pageCount: 10,
                mappedPageCount: 10,
            },
            iterateMappedPages: vi.fn(async function* () {
                for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
                    pulled += 1;
                    yield {
                        pageNumber,
                        artifact: {
                            ...state.page,
                            text: 'x'.repeat(3 * MIB),
                        },
                    };
                }
            }),
        });

        await expect(resolveDocumentTextCatalogSnapshot(
            '/tmp/small.pdf',
            DOCUMENT_REVISION,
            10,
        )).rejects.toThrow('aggregate text budget');
        expect(pulled).toBe(3);
    });

    it('does not return a snapshot across a working-copy revision change', async () => {
        state.openCatalog.mockResolvedValueOnce({
            ...state.handle,
            header: {
                ...state.handle.header,
                pageCount: 10,
                mappedPageCount: 1,
            },
            iterateMappedPages: vi.fn(async function* () {
                yield {
                    pageNumber: 1,
                    artifact: state.page,
                };
            }),
        });
        state.extractTextWithPdfjsWordBoxes.mockImplementationOnce(async () => {
            state.assertWorkingCopyRevisionSidecarCurrent.mockRejectedValue(new Error('stale revision'));
            return [];
        });

        await expect(resolveDocumentTextCatalogSnapshot(
            '/tmp/small.pdf',
            DOCUMENT_REVISION,
            10,
        )).rejects.toThrow('stale revision');
    });
});
