import type {IPdfViewport} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {loadDocumentTextCatalogPages} from '@app/utils/ocr/loadOcrText';
import {useOcrTextContent} from '@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent';
import {buildSearchIndex} from '@electron/search/indexBuilder';
import {
    resolveDocumentOcrAvailability,
    resolveDocumentOcrPage,
    resolveDocumentTextCatalogSnapshot,
    resolveDocumentTextCatalogWindow,
} from '@electron/ocr/documentTextCatalog';
import {
    createOcrDocumentTextCatalogFixture,
    OCR_CATALOG_FIXTURE_PATH,
    OCR_CATALOG_FIXTURE_REVISION,
} from '@tests/helpers/ocrDocumentTextCatalogFixture';

const state = vi.hoisted(() => ({artifacts: new Map<string, unknown>()}));
const mocks = vi.hoisted(() => ({
    atomicReplace: vi.fn(async () => undefined),
    assertWorkingCopyRevisionSidecarCurrent: vi.fn(async () => undefined),
    extractTextFromPdf: vi.fn(async (_path: string, _options?: {pages?: readonly number[]}) => [] as Array<{
        pageNumber: number;
        text: string;
    }>),
    extractTextWithPdfjs: vi.fn(async () => []),
    extractTextWithPdfjsWordBoxes: vi.fn(async (_path: string, _options?: {signal?: AbortSignal}) => [] as Array<{
        pageNumber: number;
        text: string;
    }>),
    persistCompactSearchIndexBestEffort: vi.fn(async () => undefined),
    ensureNativeSearchIndexBestEffort: vi.fn(async () => undefined),
    resolveAvailabilityViaCapability: vi.fn(),
    resolveCatalogViaCapability: vi.fn(),
    resolvePageViaCapability: vi.fn(),
    stat: vi.fn(async () => ({size: 1})),
}));

function relativeArtifactPath(path: string) {
    const marker = '.ocr/';
    const index = path.indexOf(marker);
    return index < 0 ? path : path.slice(index + marker.length);
}

function enoent(path: string): Error & {code: string} {
    const error = new Error(`ENOENT: ${path}`) as Error & {code: string};
    error.code = 'ENOENT';
    return error;
}

function virtualStat(kind: 'file' | 'directory') {
    return {
        isFile: () => kind === 'file',
        isDirectory: () => kind === 'directory',
        isSymbolicLink: () => false,
        size: 1,
    };
}

function isVirtualCatalogPath(path: string): boolean {
    return path === `${OCR_CATALOG_FIXTURE_PATH}.ocr`
        || path.startsWith(`${OCR_CATALOG_FIXTURE_PATH}.ocr/`);
}

function virtualLstat(path: string) {
    const root = `${OCR_CATALOG_FIXTURE_PATH}.ocr`;
    if (path === root) {
        return virtualStat('directory');
    }
    if (isVirtualCatalogPath(path)) {
        const relativePath = relativeArtifactPath(path);
        if (state.artifacts.has(relativePath)) {
            return virtualStat('file');
        }
        const segments = relativePath.split('/');
        if (segments.length > 1) {
            return virtualStat('directory');
        }
        throw enoent(path);
    }
    return virtualStat('directory');
}

function virtualFileHandle(path: string) {
    const value = state.artifacts.get(relativeArtifactPath(path));
    if (value === undefined) {
        throw enoent(path);
    }
    const bytes = Buffer.from(JSON.stringify(value));
    return {
        async stat() {
            return {size: bytes.byteLength};
        },
        async read(
            buffer: Buffer,
            offset: number,
            length: number,
            position: number,
        ) {
            const available = Math.max(0, bytes.byteLength - position);
            const bytesRead = Math.min(length, available);
            if (bytesRead > 0) {
                bytes.copy(buffer, offset, position, position + bytesRead);
            }
            return {
                bytesRead,
                buffer,
            };
        },
        async readFile(encoding?: BufferEncoding) {
            return encoding === undefined
                ? Buffer.from(bytes)
                : bytes.toString(encoding);
        },
        async close() {},
    };
}

vi.mock('fs', () => ({existsSync: (path: string) => state.artifacts.has(relativeArtifactPath(path))}));
vi.mock('fs/promises', () => ({
    access: vi.fn(async () => undefined),
    copyFile: vi.fn(async () => undefined),
    cp: vi.fn(async () => undefined),
    lstat: async (path: string) => virtualLstat(path),
    mkdir: vi.fn(async () => undefined),
    mkdtemp: vi.fn(async () => '/tmp/evb-ocr-catalog-test'),
    open: async (path: string) => virtualFileHandle(path),
    readFile: async (path: string) => {
        const value = state.artifacts.get(relativeArtifactPath(path));
        if (value === undefined) throw enoent(path);
        return JSON.stringify(value);
    },
    readdir: vi.fn(async () => []),
    realpath: async (path: string) => path,
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
    stat: mocks.stat,
    unlink: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
}));
vi.mock('node:fs/promises', () => ({
    access: vi.fn(async () => undefined),
    copyFile: vi.fn(async () => undefined),
    cp: vi.fn(async () => undefined),
    lstat: async (path: string) => virtualLstat(path),
    mkdir: vi.fn(async () => undefined),
    mkdtemp: vi.fn(async () => '/tmp/evb-ocr-catalog-test'),
    open: async (path: string) => virtualFileHandle(path),
    readFile: async (path: string) => {
        const value = state.artifacts.get(relativeArtifactPath(path));
        if (value === undefined) throw enoent(path);
        return JSON.stringify(value);
    },
    readdir: vi.fn(async () => []),
    realpath: async (path: string) => path,
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
    stat: mocks.stat,
    unlink: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
}));
vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {warn: vi.fn()}}));
vi.mock('@app/utils/getOcrCapability', () => ({getOcrCapability: () => ({
    resolveDocumentOcrAvailability: (...args: unknown[]) => mocks.resolveAvailabilityViaCapability(...args),
    resolveDocumentOcrPage: (...args: unknown[]) => mocks.resolvePageViaCapability(...args),
    resolveDocumentTextCatalog: (...args: unknown[]) => mocks.resolveCatalogViaCapability(...args),
})}));
vi.mock('@electron/search/extractTextFromPdf', () => ({extractTextFromPdf: mocks.extractTextFromPdf}));
vi.mock('@electron/search/extractTextWithPdfjs', () => ({
    extractTextWithPdfjs: mocks.extractTextWithPdfjs,
    extractTextWithPdfjsWordBoxes: mocks.extractTextWithPdfjsWordBoxes,
}));
vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: mocks.atomicReplace,
    makeSiblingTempPath: (path: string) => `${path}.tmp`,
}));
vi.mock('@electron/search/searchIndexSidecar', () => ({
    COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER: 1,
    persistCompactSearchIndexBestEffort: mocks.persistCompactSearchIndexBestEffort,
}));
vi.mock('@electron/search/nativeSearchIndex', () => ({ensureNativeSearchIndexBestEffort: mocks.ensureNativeSearchIndexBestEffort}));
vi.mock('@electron/file-access/documentRevisionSidecar', () => ({
    assertWorkingCopyRevisionSidecarCurrent: mocks.assertWorkingCopyRevisionSidecarCurrent,
    reconcileWorkingCopyRevisionSidecarJournal: vi.fn(async () => null),
}));
vi.mock('@electron/file-access/workingCopyStore', () => ({normalizePathForLookup: (path: string) => path}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
})}));

function createViewport(): IPdfViewport {
    return {
        viewBox: [
            0,
            0,
            300,
            400,
        ],
        userUnit: 1,
        width: 300,
        height: 400,
        scale: 1,
        rotation: 0,
        offsetX: 0,
        offsetY: 0,
        transform: [
            1,
            0,
            0,
            1,
            0,
            0,
        ],
        rawDims: {
            pageWidth: 300,
            pageHeight: 400,
        },
        clone: createViewport,
        convertToViewportPoint: () => [
            0,
            0,
        ],
        convertToViewportRectangle: () => [
            0,
            0,
            0,
            0,
        ],
        convertToPdfPoint: () => [
            0,
            0,
        ],
    };
}

function comparablePages(pages: ReadonlyArray<{
    pageNumber: number;
    text: string
}>) {
    return pages.map(page => ({
        pageNumber: page.pageNumber,
        text: page.text.replace(/\s+/gu, ' ').trim(),
    }));
}

describe('DocumentTextCatalog reader agreement', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.stat.mockResolvedValue({size: 1});
        state.artifacts.clear();
        useOcrTextContent().clearCache();
        mocks.resolveAvailabilityViaCapability.mockImplementation(resolveDocumentOcrAvailability);
        mocks.resolveCatalogViaCapability.mockImplementation(resolveDocumentTextCatalogSnapshot);
        mocks.resolvePageViaCapability.mockImplementation(resolveDocumentOcrPage);
    });

    it('serves a representative large viewer document without extracting all-page PDF geometry', async () => {
        const fixture = createOcrDocumentTextCatalogFixture(Array.from(
            {length: 406},
            (_value, index) => ({
                pageNumber: index + 1,
                text: `page ${index + 1}`,
            }),
        ));
        state.artifacts = new Map(fixture.artifacts);

        const viewer = useOcrTextContent();
        await expect(viewer.hasPageOcrData(fixture.path, fixture.revision, 406)).resolves.toBe(true);
        await expect(viewer.getOcrTextContent(
            fixture.path,
            fixture.revision,
            406,
            createViewport(),
        )).resolves.not.toBeNull();

        expect(mocks.resolveAvailabilityViaCapability).toHaveBeenCalledOnce();
        expect(mocks.resolvePageViaCapability).toHaveBeenCalledOnce();
        expect(mocks.resolveCatalogViaCapability).not.toHaveBeenCalled();
        expect(mocks.extractTextWithPdfjsWordBoxes).not.toHaveBeenCalled();
    });

    it('routes path-backed PDFs above 16 MiB through bounded Poppler windows', async () => {
        const fixture = createOcrDocumentTextCatalogFixture([{
            pageNumber: 1,
            text: 'large document page',
        }]);
        state.artifacts = new Map(fixture.artifacts);
        mocks.stat.mockResolvedValue({size: 17 * 1024 * 1024});
        mocks.extractTextFromPdf.mockResolvedValue([]);

        const snapshot = await resolveDocumentTextCatalogSnapshot(
            fixture.path,
            fixture.revision,
            65,
        );

        expect(snapshot.pages[0]).toMatchObject({
            pageNumber: 1,
            source: 'evb-ocr',
        });
        expect(mocks.extractTextWithPdfjsWordBoxes).not.toHaveBeenCalled();
        expect(mocks.extractTextFromPdf).toHaveBeenCalledTimes(2);
        expect(mocks.extractTextFromPdf.mock.calls.map(call => call[1]?.pages)).toEqual([
            Array.from({length: 64}, (_value, index) => index + 1),
            [65],
        ]);
    });

    it('passes scalar extraction cancellation into the PDF reader', async () => {
        const fixture = createOcrDocumentTextCatalogFixture([{
            pageNumber: 1,
            text: 'logical sidecar text',
        }]);
        state.artifacts = new Map(fixture.artifacts);
        const controller = new AbortController();
        const extractionStarted = Promise.withResolvers<undefined>();
        const releaseExtraction = Promise.withResolvers<undefined>();
        mocks.extractTextWithPdfjsWordBoxes.mockImplementationOnce(async (_path, options) => {
            extractionStarted.resolve(undefined);
            await releaseExtraction.promise;
            options?.signal?.throwIfAborted();
            return [];
        });

        const snapshotPromise = resolveDocumentTextCatalogSnapshot(
            fixture.path,
            fixture.revision,
            1,
            {signal: controller.signal},
        );
        await extractionStarted.promise;
        expect(mocks.extractTextWithPdfjsWordBoxes).toHaveBeenCalledWith(
            fixture.path,
            {signal: controller.signal},
        );
        controller.abort(new DOMException('DOCX export was canceled.', 'AbortError'));
        releaseExtraction.resolve(undefined);

        await expect(snapshotPromise).rejects.toMatchObject({name: 'AbortError'});
    });

    it('keeps logical OCR sidecars while reading catalog PDF bytes from a physical backing path', async () => {
        const fixture = createOcrDocumentTextCatalogFixture([{
            pageNumber: 1,
            text: 'logical sidecar text',
        }]);
        const physicalPath = '/Users/alice/Documents/source.pdf';
        state.artifacts = new Map(fixture.artifacts);
        mocks.extractTextWithPdfjsWordBoxes.mockResolvedValue([{
            pageNumber: 1,
            text: 'physical PDF text',
        }]);
        mocks.extractTextFromPdf.mockResolvedValue([{
            pageNumber: 1,
            text: 'physical window text',
        }]);

        const snapshot = await resolveDocumentTextCatalogSnapshot(
            fixture.path,
            fixture.revision,
            1,
            {sourcePdfPath: physicalPath},
        );
        const window = await resolveDocumentTextCatalogWindow(
            fixture.path,
            fixture.revision,
            1,
            1,
            1,
            {sourcePdfPath: physicalPath},
        );

        expect(mocks.assertWorkingCopyRevisionSidecarCurrent).toHaveBeenCalledWith(
            fixture.path,
            fixture.revision,
        );
        expect(mocks.stat).toHaveBeenCalledWith(physicalPath);
        expect(mocks.extractTextWithPdfjsWordBoxes).toHaveBeenCalledWith(physicalPath);
        expect(mocks.extractTextFromPdf).toHaveBeenCalledWith(
            physicalPath,
            expect.objectContaining({pages: [1]}),
        );
        expect(snapshot.pages[0]).toMatchObject({
            pageNumber: 1,
            source: 'evb-ocr',
        });
        expect(snapshot.pages[0]?.text).toContain('logical sidecar text');
        expect(window.pages[0]).toMatchObject({
            pageNumber: 1,
            source: 'evb-ocr',
        });
        expect(window.pages[0]?.text).toContain('logical sidecar text');
    });

    it('uses the physical backing for large catalog extraction when page count is unknown', async () => {
        const fixture = createOcrDocumentTextCatalogFixture([{
            pageNumber: 1,
            text: 'logical sidecar text',
        }]);
        const physicalPath = '/Users/alice/Documents/large-source.pdf';
        state.artifacts = new Map(fixture.artifacts);
        mocks.stat.mockResolvedValue({size: 17 * 1024 * 1024});
        mocks.extractTextFromPdf.mockResolvedValue([{
            pageNumber: 1,
            text: 'physical PDF text',
        }]);

        await resolveDocumentTextCatalogSnapshot(
            fixture.path,
            fixture.revision,
            undefined,
            {sourcePdfPath: physicalPath},
        );

        expect(mocks.extractTextFromPdf).toHaveBeenCalledWith(physicalPath);
        expect(mocks.extractTextFromPdf).not.toHaveBeenCalledWith(fixture.path);
    });

    it('returns identical page text through viewer, search, and export readers', async () => {
        const fixture = createOcrDocumentTextCatalogFixture([
            {
                pageNumber: 1,
                text: 'native-looking first page',
            },
            {
                pageNumber: 2,
                text: 'EVB OCR second page',
            },
            {
                pageNumber: 3,
                text: 'foreign-looking third page',
            },
        ]);
        state.artifacts = new Map(fixture.artifacts);

        const exportPages = await loadDocumentTextCatalogPages(fixture.path, fixture.revision);
        const viewer = useOcrTextContent();
        const viewerPages = await Promise.all([
            1,
            2,
            3,
        ].map(async pageNumber => {
            const content = await viewer.getOcrTextContent(
                fixture.path,
                fixture.revision,
                pageNumber,
                createViewport(),
            );
            return {
                pageNumber,
                text: content?.items.map(item => item.str).join(' ') ?? '',
            };
        }));
        const search = await buildSearchIndex(fixture.path, [], {
            documentRevision: fixture.revision,
            pageCount: fixture.manifest.pageCount,
        });
        const canonical = await resolveDocumentTextCatalogSnapshot(
            fixture.path,
            fixture.revision,
            fixture.manifest.pageCount,
        );

        const expected = comparablePages(exportPages ?? []);
        expect(comparablePages(viewerPages)).toEqual(expected);
        expect(comparablePages(search.pages)).toEqual(expected);
        expect(comparablePages(canonical.pages)).toEqual(expected);
        expect(mocks.extractTextFromPdf).not.toHaveBeenCalled();
        expect(mocks.extractTextWithPdfjs).not.toHaveBeenCalled();
    });

    it.each([
        [
            'stale manifest revision',
            (artifacts: Map<string, unknown>) => {
                const manifest = structuredClone(artifacts.get('manifest.json')) as {documentRevision: {token: string}};
                manifest.documentRevision.token = 'stale-revision';
                artifacts.set('manifest.json', manifest);
            },
        ],
        [
            'zero render width',
            (artifacts: Map<string, unknown>) => {
                const page = structuredClone(artifacts.get('page-0001.json')) as {render: {imagePx: {w: number}}};
                page.render.imagePx.w = 0;
                artifacts.set('page-0001.json', page);
            },
        ],
    ])('strict readers refuse %s', async (_label, mutate) => {
        const fixture = createOcrDocumentTextCatalogFixture([{
            pageNumber: 1,
            text: 'must not leak',
        }]);
        mutate(fixture.artifacts);
        state.artifacts = new Map(fixture.artifacts);

        const exportPages = await loadDocumentTextCatalogPages(OCR_CATALOG_FIXTURE_PATH, OCR_CATALOG_FIXTURE_REVISION);
        const viewerContent = await useOcrTextContent().getOcrTextContent(
            OCR_CATALOG_FIXTURE_PATH,
            OCR_CATALOG_FIXTURE_REVISION,
            1,
            createViewport(),
        );
        const search = await buildSearchIndex(OCR_CATALOG_FIXTURE_PATH, [], {
            documentRevision: OCR_CATALOG_FIXTURE_REVISION,
            pageCount: 1,
        });

        expect(exportPages?.some(page => page.text.includes('must not leak')) ?? false).toBe(false);
        expect(viewerContent?.items.some(item => item.str.includes('must not leak')) ?? false).toBe(false);
        expect(search.pages.some(page => page.text.includes('must not leak'))).toBe(false);
    });
});
