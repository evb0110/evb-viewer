import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type {
    IDocumentsFileCapability,
    IDocumentsOpenCapability,
} from '@contracts/electronApiDocuments';
import type { BrowserDocumentStore } from '@app/platform/browserDocumentStore';
import {BROWSER_MAX_FULL_READ_BYTES as BROWSER_FULL_READ_LIMIT} from '@app/platform/browser/browserDocumentConstants';
import {
    FakeIndexedDbFactory,
    MemoryStorage,
    cast,
} from '@tests/unit/app/platform/browserPlatformTestDoubles';

const PDF_SOURCE_OPTIONS = {
    mimeType: 'application/pdf',
    kind: 'source',
    saveKind: 'pdf',
} as const;

const browserPdfCombineWorkerMock = vi.hoisted(() => ({
    canUse: vi.fn(() => false),
    cloneInput: vi.fn((fileName: string, data: Uint8Array) => ({
        fileName,
        data,
    })),
    run: vi.fn(),
}));
const browserDjvuCapabilityMock = vi.hoisted(() => ({
    cancel: vi.fn(async () => ({canceled: true})),
    runConversion: vi.fn(),
}));
const browserAnnotationParseMock = vi.hoisted(() => ({run: vi.fn()}));
const utifMock = vi.hoisted(() => ({
    decode: vi.fn(() => []),
    decodeImage: vi.fn(),
    toRGBA8: vi.fn(() => new Uint8Array()),
}));
const pdfjsModule = vi.hoisted(() => {
    class MockPdfDataRangeTransport {
        public onDataRange = vi.fn();
        public onDataProgress = vi.fn();
    }

    return {
        version: '5.7.284',
        GlobalWorkerOptions: {},
        PDFDataRangeTransport: MockPdfDataRangeTransport,
        VerbosityLevel: {ERRORS: 3},
        getDocument: vi.fn((_rawInit: unknown) => ({promise: Promise.resolve({destroy: vi.fn(async () => {})})})),
    };
});

vi.mock('@app/platform/browser-api/browserPdfCombineWorkerClient', () => ({
    BrowserPdfCombineWorkerUnavailableError: class BrowserPdfCombineWorkerUnavailableError extends Error {},
    canUseBrowserPdfCombineWorker: () => browserPdfCombineWorkerMock.canUse(),
    cloneCombineWorkerInput: (fileName: string, data: Uint8Array) =>
        browserPdfCombineWorkerMock.cloneInput(fileName, data),
    runBrowserPdfCombineWorkerRequest: (type: string, payload: unknown) =>
        browserPdfCombineWorkerMock.run(type, payload),
}));
vi.mock('@app/platform/browser-api/browserDjvuCapability', () => ({browserDjvuCapability: {cancel: browserDjvuCapabilityMock.cancel}}));
vi.mock('@app/platform/browser-api/browserDjvuConversionPipeline', () => ({runBrowserDjvuConversion: browserDjvuCapabilityMock.runConversion}));
vi.mock('@app/platform/browser-api/browserPageOpsWorkerClient', () => ({runBrowserPageOpsWorkerRequest: (...args: unknown[]) => browserAnnotationParseMock.run(...args)}));
vi.mock('utif', () => {
    const decode = (...args: Parameters<typeof utifMock.decode>) => utifMock.decode(...args);
    const decodeImage = (...args: Parameters<typeof utifMock.decodeImage>) => utifMock.decodeImage(...args);
    const toRGBA8 = (...args: Parameters<typeof utifMock.toRGBA8>) => utifMock.toRGBA8(...args);
    return {
        decode,
        decodeImage,
        toRGBA8,
        default: {
            decode,
            decodeImage,
            toRGBA8,
        },
    };
});
vi.mock('pdfjs-dist', () => pdfjsModule);

async function createPdfBytes() {
    const document = await PDFDocument.create();
    document.addPage();
    return new Uint8Array(await document.save());
}

async function getRevisionOptions(
    browserDocumentStore: Pick<BrowserDocumentStore, 'getDocumentRevision'>,
    ref: string,
) {
    const revision = await browserDocumentStore.getDocumentRevision(ref);
    return { expectedDocumentRevisionToken: revision.token };
}

function createMockElement(tagName: string) {
    const listeners = new Map<string, () => void>();
    return {
        tagName: tagName.toUpperCase(),
        accept: '',
        multiple: false,
        type: '',
        style: {},
        files: null,
        content: {
            firstChild: null,
            appendChild() {},
        },
        relList: { supports() { return true; } },
        setAttribute() {},
        appendChild() {},
        append() {},
        remove() {},
        click() {
            listeners.get('change')?.();
        },
        addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
            if (typeof listener === 'function') {
                listeners.set(type, () => listener(new Event(type)));
            }
        },
        removeEventListener() {},
        getContext() {
            return null;
        },
    };
}

interface ILoadBrowserDocumentsFileCapabilityOptions {
    clearSearchCaches?: (pdfPath?: string) => void;
    inputFiles?: File[];
    windowOverrides?: Record<string, unknown>;
}

interface ILoadedBrowserDocumentsFileCapability {
    BROWSER_DOCUMENT_CHUNK_SIZE: number;
    BROWSER_MAX_FULL_READ_BYTES: number;
    browserDocumentStore: BrowserDocumentStore;
    capability: IDocumentsFileCapability;
}

async function loadCreateCombinedPdfFromPaths() {
    const module = await import('@app/platform/browser-api/createBrowserDocumentsFileCapability');
    return module.createBrowserCombinedPdfFromPaths;
}

async function loadBrowserOpenProgressListener(): Promise<
    IDocumentsOpenCapability['onOpenDocumentDirectBatchProgress']
> {
    const module = await import('@app/platform/browser-api/documentsMenuCapability');
    return module.onBrowserOpenDocumentDirectBatchProgress;
}

async function loadBrowserDocumentsFileCapability(
    options?: ILoadBrowserDocumentsFileCapabilityOptions,
): Promise<ILoadedBrowserDocumentsFileCapability> {
    vi.resetModules();
    vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    vi.stubGlobal('window', {
        localStorage,
        sessionStorage,
        addEventListener() {},
        removeEventListener() {},
        setTimeout,
        clearTimeout,
        ...options?.windowOverrides,
    });
    vi.stubGlobal('document', {
        cookie: '',
        body: {
            append() {},
            appendChild() {},
            removeChild() {},
        },
        createElement(tagName: string) {
            const element = createMockElement(tagName);
            if (tagName === 'input' && options?.inputFiles) {
                (element as { files: File[] | null }).files = options.inputFiles;
            }
            return element;
        },
        createElementNS(_namespace: string, tagName: string) {
            return createMockElement(tagName);
        },
        createTextNode(text: string) {
            return { nodeValue: text };
        },
        createComment(text: string) {
            return { nodeValue: text };
        },
        querySelector() {
            return null;
        },
    });

    const [
        { createBrowserDocumentsFileCapability },
        {
            BROWSER_DOCUMENT_CHUNK_SIZE,
            BROWSER_MAX_FULL_READ_BYTES,
            browserDocumentStore,
        },
    ] = await Promise.all([
        import('@app/platform/browser-api/createBrowserDocumentsFileCapability'),
        import('@app/platform/browserDocumentStore'),
    ]);

    return {
        BROWSER_DOCUMENT_CHUNK_SIZE,
        BROWSER_MAX_FULL_READ_BYTES,
        capability: cast<IDocumentsFileCapability>(
            createBrowserDocumentsFileCapability({clearSearchCaches: options?.clearSearchCaches ?? (() => {})}),
        ),
        browserDocumentStore,
    };
}

describe('createBrowserDocumentsFileCapability', {timeout: 20_000}, () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        browserPdfCombineWorkerMock.canUse.mockReset();
        browserPdfCombineWorkerMock.canUse.mockReturnValue(false);
        browserPdfCombineWorkerMock.cloneInput.mockClear();
        browserPdfCombineWorkerMock.run.mockReset();
        browserDjvuCapabilityMock.runConversion.mockReset();
        browserAnnotationParseMock.run.mockReset();
        utifMock.decode.mockReset();
        utifMock.decode.mockReturnValue([]);
        utifMock.decodeImage.mockReset();
        utifMock.toRGBA8.mockReset();
        utifMock.toRGBA8.mockReturnValue(new Uint8Array());
        pdfjsModule.getDocument.mockReset();
        pdfjsModule.getDocument.mockReturnValue({promise: Promise.resolve({destroy: vi.fn(async () => {})})});
    });

    it('returns typed unsupported results for desktop-only folder actions', async () => {
        const { capability } = await loadBrowserDocumentsFileCapability();

        await expect(capability.openFolderDialog()).resolves.toBeNull();
        await expect(capability.openFolderDialogStructured!()).resolves.toEqual({
            ok: false,
            reason: 'requires-native-backend',
            message: 'Folder dialogs require the desktop app.',
        });
        await expect(capability.showItemInFolder('browser://documents/source.pdf')).resolves.toBe(false);
        await expect(capability.showItemInFolderStructured!('browser://documents/source.pdf')).resolves.toEqual({
            ok: false,
            reason: 'requires-native-backend',
            message: 'Showing files in a folder requires the desktop app.',
        });
    });

    it('parses a working copy through WASM after checking the browser full-read budget', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const workingRef = await browserDocumentStore.createStoredDocument(
            'writer-parse.pdf',
            await createPdfBytes(),
            {
                ...PDF_SOURCE_OPTIONS,
                kind: 'working',
            },
        );
        const revisionOptions = await getRevisionOptions(browserDocumentStore, workingRef);
        browserAnnotationParseMock.run.mockResolvedValue({data: new TextEncoder().encode([
            JSON.stringify({
                format: 'evb-pdf-annotation-parse',
                schemaVersion: 1,
                pageCount: 1,
                chunkBytes: 4 * 1024 * 1024,
            }),
            JSON.stringify({
                chunkIndex: 0,
                entries: [{
                    kind: 'foreign',
                    pageIndex: 0,
                    objectNumber: 4,
                    generationNumber: 0,
                    name: 'link',
                    subtype: 'Link',
                    reason: 'unsupported annotation subtype /Link',
                }],
            }),
        ].join('\n') + '\n')});

        await expect(capability.parsePdfAnnotations(workingRef, revisionOptions)).resolves.toEqual({
            documentRevisionToken: revisionOptions.expectedDocumentRevisionToken,
            pageCount: 1,
            entities: [],
            foreign: [{
                kind: 'foreign',
                pageIndex: 0,
                objectNumber: 4,
                generationNumber: 0,
                name: 'link',
                subtype: 'Link',
                reason: 'unsupported annotation subtype /Link',
            }],
        });
        expect(browserAnnotationParseMock.run).toHaveBeenCalledWith(
            'parseAnnotations',
            {data: expect.any(Uint8Array)},
            {
                dedicated: true,
                signal: undefined,
            },
        );
    });

    it('rejects an oversized parse before reading the working copy', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const workingRef = await browserDocumentStore.createStoredDocument(
            'oversized-parse.pdf',
            Uint8Array.of(37),
            {
                ...PDF_SOURCE_OPTIONS,
                kind: 'working',
            },
        );
        const revisionOptions = await getRevisionOptions(browserDocumentStore, workingRef);
        const statSpy = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: BROWSER_FULL_READ_LIMIT + 1,
            modifiedAt: 0,
        });
        const readSpy = vi.spyOn(browserDocumentStore, 'read');

        try {
            await expect(capability.parsePdfAnnotations(workingRef, revisionOptions)).rejects.toThrow(
                `Parsing PDF annotations is unavailable in the browser for inputs larger than ${BROWSER_FULL_READ_LIMIT / (1024 * 1024)}MB`,
            );
            expect(readSpy).not.toHaveBeenCalled();
        } finally {
            statSpy.mockRestore();
            readSpy.mockRestore();
        }
    });

    it('registers browser files for open after ingestion completes', async () => {
        const file = new File([Uint8Array.of(1, 2, 3)], 'drop.pdf', { type: 'application/pdf' });
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();

        const refs = await capability.registerFilesForOpen([file]);

        expect(refs).toHaveLength(1);
        const [ref] = refs;
        expect(ref).toBeDefined();
        await expect(browserDocumentStore.read(ref as string)).resolves.toEqual(Uint8Array.of(1, 2, 3));
    });

    it.each([
        {
            name: 'combine',
            open: (capability: IDocumentsFileCapability) => capability.openCombineDialog(),
            acceptKey: 'application/octet-stream',
            expectedExtensions: [
                '.djvu',
                '.djv',
            ],
        },
        {
            name: 'image',
            open: (capability: IDocumentsFileCapability) => capability.openImageDialog(),
            acceptKey: 'image/*',
            expectedExtensions: [],
        },
    ])('applies the browser $name picker format policy', async ({
        open,
        acceptKey,
        expectedExtensions,
    }) => {
        const showOpenFilePicker = vi.fn(async () => []);
        const { capability } = await loadBrowserDocumentsFileCapability({ windowOverrides: { showOpenFilePicker } });

        await expect(open(capability)).resolves.toBeNull();

        const firstCall = showOpenFilePicker.mock.calls[0] as [{types?: Array<{ accept: Record<string, string[]>; }>;}] | undefined;
        const accept = firstCall?.[0]?.types?.[0]?.accept;
        expect(showOpenFilePicker).toHaveBeenCalledTimes(1);
        expect(accept?.['image/*']).not.toContain('.svgz');
        if (expectedExtensions.length > 0) {
            expect(accept?.[acceptKey]).toEqual(expectedExtensions);
        }
    });

    it('surfaces first file-handle denial before using the fallback on the next user action', async () => {
        const pdfBytes = await createPdfBytes();
        const pickedPdf = new File([pdfBytes], 'fallback.pdf', { type: 'application/pdf' });
        const deniedHandle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'denied.pdf',
            getFile: vi.fn(async () => {
                throw new DOMException('Not allowed', 'NotAllowedError');
            }),
        });
        const showOpenFilePicker = vi.fn(async () => [deniedHandle]);
        const { capability } = await loadBrowserDocumentsFileCapability({
            inputFiles: [pickedPdf],
            windowOverrides: { showOpenFilePicker },
        });

        await expect(capability.openDocumentDialog()).rejects.toMatchObject({
            message: 'browser-file-picker-setup-denied',
            name: 'BrowserFilePickerSetupDeniedError',
        });
        const fallbackResult = await capability.openDocumentDialog();

        expect(showOpenFilePicker).toHaveBeenCalledTimes(1);
        expect(fallbackResult?.kind).toBe('pdf');
    });

    it('rejects oversized browser combine inputs before reading the input PDFs', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const createCombinedPdfFromPaths = await loadCreateCombinedPdfFromPaths();
        const firstRef = await browserDocumentStore.createStoredDocument(
            'first.pdf',
            Uint8Array.of(1),
            {...PDF_SOURCE_OPTIONS},
        );
        const secondRef = await browserDocumentStore.createStoredDocument(
            'second.pdf',
            Uint8Array.of(2),
            {...PDF_SOURCE_OPTIONS},
        );
        const statSpy = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: (BROWSER_FULL_READ_LIMIT / 2) + 1,
            modifiedAt: 0,
        });
        const readSpy = vi.spyOn(browserDocumentStore, 'read');

        await expect(createCombinedPdfFromPaths([
            firstRef,
            secondRef,
        ])).rejects.toThrow(
            'Combining documents is unavailable in the browser for inputs larger than 16MB',
        );

        expect(readSpy).not.toHaveBeenCalled();
        statSpy.mockRestore();
        readSpy.mockRestore();
    });

    it('validates oversized browser PDFs through range reads without a full read', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const path = 'browser://documents/source/large-validation.pdf';
        const largeSize = BROWSER_FULL_READ_LIMIT + 1;
        const statSpy = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: largeSize,
            modifiedAt: 0,
        });
        const signatureSpy = vi.spyOn(browserDocumentStore, 'getContentSignature').mockResolvedValue('large-validation');
        const readSpy = vi.spyOn(browserDocumentStore, 'read').mockRejectedValue(
            new Error('full browser reads are forbidden for this test'),
        );
        const readRangeSpy = vi.spyOn(browserDocumentStore, 'readRange').mockResolvedValue(
            new Uint8Array(4 * 1024 * 1024),
        );
        pdfjsModule.getDocument.mockReturnValue({promise: Promise.resolve({destroy: vi.fn(async () => {})})});

        await expect(capability.validatePdfPath(path)).resolves.toEqual({
            isValid: true,
            tool: 'browser',
            errors: [],
            warnings: [],
        });

        expect(readSpy).not.toHaveBeenCalled();
        expect(readRangeSpy).toHaveBeenCalledWith(path, 0, 4 * 1024 * 1024);
        expect(signatureSpy).toHaveBeenCalled();
        statSpy.mockRestore();
        signatureSpy.mockRestore();
        readSpy.mockRestore();
        readRangeSpy.mockRestore();
    });

    it('requests later PDF ranges through the public validator without reading the whole source', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const path = 'browser://documents/source/multi-range-validation.pdf';
        const chunkSize = 4 * 1024 * 1024;
        const largeSize = BROWSER_FULL_READ_LIMIT + 1;
        const statSpy = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: largeSize,
            modifiedAt: 0,
        });
        const signatureSpy = vi.spyOn(browserDocumentStore, 'getContentSignature').mockResolvedValue('multi-range-validation');
        const readSpy = vi.spyOn(browserDocumentStore, 'read').mockRejectedValue(
            new Error('whole browser reads are forbidden for this test'),
        );
        const readRangeSpy = vi.spyOn(browserDocumentStore, 'readRange').mockImplementation(
            async (_path, _offset, length) => new Uint8Array(length),
        );
        pdfjsModule.getDocument.mockImplementation((rawInit: unknown) => {
            const init = rawInit as {range: {
                requestDataRange: (begin: number, end: number) => void;
                onDataRange: (...args: unknown[]) => void;
            }};
            const destroy = vi.fn(async () => {});
            const promise = new Promise<{destroy: typeof destroy}>(resolve => {
                init.range.onDataRange = () => resolve({destroy});
                init.range.requestDataRange(chunkSize, chunkSize * 2);
            });
            return {
                promise,
                destroy,
            };
        });

        await expect(capability.validatePdfPath(path)).resolves.toEqual({
            isValid: true,
            tool: 'browser',
            errors: [],
            warnings: [],
        });

        expect(readSpy).not.toHaveBeenCalled();
        expect(readRangeSpy).toHaveBeenNthCalledWith(1, path, 0, chunkSize);
        expect(readRangeSpy).toHaveBeenNthCalledWith(2, path, chunkSize, chunkSize);
        expect(readRangeSpy).toHaveBeenCalledTimes(2);
        statSpy.mockRestore();
        signatureSpy.mockRestore();
        readSpy.mockRestore();
        readRangeSpy.mockRestore();
    });

    it('propagates a failed later PDF range through the public validator without a whole read', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const path = 'browser://documents/source/failed-range-validation.pdf';
        const chunkSize = 4 * 1024 * 1024;
        const largeSize = BROWSER_FULL_READ_LIMIT + 1;
        const statSpy = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: largeSize,
            modifiedAt: 0,
        });
        const signatureSpy = vi.spyOn(browserDocumentStore, 'getContentSignature').mockResolvedValue('failed-range-validation');
        const readSpy = vi.spyOn(browserDocumentStore, 'read').mockRejectedValue(
            new Error('whole browser reads are forbidden for this test'),
        );
        const rangeFailure = new Error('second PDF range failed');
        const readRangeSpy = vi.spyOn(browserDocumentStore, 'readRange').mockImplementation(
            async (_path, offset, length) => {
                if (offset === 0) {
                    return new Uint8Array(length);
                }
                throw rangeFailure;
            },
        );
        pdfjsModule.getDocument.mockImplementation((rawInit: unknown) => {
            const init = rawInit as {range: {
                requestDataRange: (begin: number, end: number) => void;
                onDataRange: (...args: unknown[]) => void;
            }};
            const destroy = vi.fn(async () => {});
            const promise = new Promise<{destroy: typeof destroy}>(() => {
                init.range.onDataRange = () => undefined;
                init.range.requestDataRange(chunkSize, chunkSize * 2);
            });
            return {
                promise,
                destroy,
            };
        });

        await expect(capability.validatePdfPath(path)).resolves.toEqual({
            isValid: false,
            tool: 'browser',
            errors: ['second PDF range failed'],
            warnings: [],
        });

        expect(readSpy).not.toHaveBeenCalled();
        expect(readRangeSpy).toHaveBeenNthCalledWith(1, path, 0, chunkSize);
        expect(readRangeSpy).toHaveBeenNthCalledWith(2, path, chunkSize, chunkSize);
        expect(readRangeSpy).toHaveBeenCalledTimes(2);
        statSpy.mockRestore();
        signatureSpy.mockRestore();
        readSpy.mockRestore();
        readRangeSpy.mockRestore();
    });

    it.skip('enforces the 500-page limit on the browser main-thread fallback', async () => {
        const {browserDocumentStore} = await loadBrowserDocumentsFileCapability();
        const createCombinedPdfFromPaths = await loadCreateCombinedPdfFromPaths();
        const source = await PDFDocument.create();
        for (let page = 0; page < 501; page += 1) {
            source.addPage();
        }
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'too-many-pages.pdf',
            new Uint8Array(await source.save()),
            {...PDF_SOURCE_OPTIONS},
        );

        await expect(createCombinedPdfFromPaths([sourceRef]))
            .rejects.toThrow('ERR_BROWSER_PDF_COMBINE_TOO_MANY_PAGES');
    });

    it('emits browser batch-open progress while combining multiple inputs', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const [
            createCombinedPdfFromPaths,
            onOpenDocumentDirectBatchProgress,
        ] = await Promise.all([
            loadCreateCombinedPdfFromPaths(),
            loadBrowserOpenProgressListener(),
        ]);
        const firstRef = await browserDocumentStore.createStoredDocument(
            'first.pdf',
            Uint8Array.of(1, 2, 3),
            {...PDF_SOURCE_OPTIONS},
        );
        const secondRef = await browserDocumentStore.createStoredDocument(
            'second.pdf',
            Uint8Array.of(4, 5, 6),
            {...PDF_SOURCE_OPTIONS},
        );
        browserPdfCombineWorkerMock.canUse.mockReturnValue(true);
        browserPdfCombineWorkerMock.run.mockResolvedValue({data: Uint8Array.of(9, 8, 7)});

        const progressEvents: Array<{
            operation: string;
            requestId: string;
            processed: number;
            total: number;
            percent: number;
            elapsedMs: number;
            estimatedRemainingMs: number | null;
        }> = [];
        const stopListening = onOpenDocumentDirectBatchProgress((progress) => {
            progressEvents.push(progress);
        });

        try {
            await createCombinedPdfFromPaths(
                [
                    firstRef,
                    secondRef,
                ],
                { requestId: 'browser-batch-1' },
            );
        } finally {
            stopListening();
        }

        expect(progressEvents).toEqual(expect.arrayContaining([
            expect.objectContaining({
                operation: 'document-open',
                requestId: 'browser-batch-1',
                processed: 1,
                total: 2,
            }),
            expect.objectContaining({
                operation: 'document-open',
                requestId: 'browser-batch-1',
                processed: 2,
                total: 2,
                percent: 95,
            }),
        ]));
    });

    it('offloads supported mixed PDF and raster-image combine jobs to the browser worker', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const createCombinedPdfFromPaths = await loadCreateCombinedPdfFromPaths();
        const pdfRef = await browserDocumentStore.createStoredDocument(
            'first.pdf',
            Uint8Array.of(1, 2, 3),
            {...PDF_SOURCE_OPTIONS},
        );
        const imageRef = await browserDocumentStore.createStoredDocument(
            'photo.png',
            Uint8Array.of(4, 5, 6),
            {
                mimeType: 'image/png',
                kind: 'source',
                saveKind: 'generic',
            },
        );
        browserPdfCombineWorkerMock.canUse.mockReturnValue(true);
        browserPdfCombineWorkerMock.run.mockResolvedValue({data: Uint8Array.of(7, 8, 9)});

        const result = await createCombinedPdfFromPaths([
            pdfRef,
            imageRef,
        ]);

        expect(result).toEqual(Uint8Array.of(7, 8, 9));
        expect(browserPdfCombineWorkerMock.run).toHaveBeenCalledWith('combinePdfs', {inputs: [
            {
                fileName: 'first.pdf',
                data: Uint8Array.of(1, 2, 3),
            },
            {
                fileName: 'photo.png',
                data: Uint8Array.of(4, 5, 6),
            },
        ]});
    });

    it.skip('converts DjVu files before combining mixed browser batches', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const createCombinedPdfFromPaths = await loadCreateCombinedPdfFromPaths();
        const pdfBytes = await createPdfBytes();
        const pdfRef = await browserDocumentStore.createStoredDocument(
            'first.pdf',
            pdfBytes,
            {...PDF_SOURCE_OPTIONS},
        );
        const djvuRef = await browserDocumentStore.createStoredDocument(
            'scan.djvu',
            Uint8Array.of(1, 2, 3),
            {
                mimeType: 'application/octet-stream',
                kind: 'source',
                saveKind: 'generic',
            },
        );
        let convertedRef: string | null = null;
        browserDjvuCapabilityMock.runConversion.mockImplementation(async (_djvuPath: string, outputPath: string) => {
            convertedRef = outputPath;
            await browserDocumentStore.write(outputPath, pdfBytes);
            return {
                success: true,
                pdfPath: outputPath,
            };
        });

        const result = await createCombinedPdfFromPaths([
            pdfRef,
            djvuRef,
        ]);
        const combinedPdf = await PDFDocument.load(result);

        expect(combinedPdf.getPageCount()).toBe(2);
        expect(browserDjvuCapabilityMock.runConversion).toHaveBeenCalledWith(
            djvuRef,
            expect.stringMatching(/^browser:\/\/documents\//u),
            expect.objectContaining({
                pdfStrategy: 'compact-djvu-aware',
                subsample: 2,
                preserveBookmarks: false,
                jobId: expect.stringMatching(/^browser-pdf-combine-djvu-/u),
            }),
        );
        expect(convertedRef).not.toBeNull();
        await expect(browserDocumentStore.exists(convertedRef!)).resolves.toBe(false);
    });

    it('cancels browser DjVu pre-conversion when the combine signal aborts', async () => {
        const {browserDocumentStore} = await loadBrowserDocumentsFileCapability();
        const createCombinedPdfFromPaths = await loadCreateCombinedPdfFromPaths();
        const djvuRef = await browserDocumentStore.createStoredDocument(
            'scan.djvu',
            Uint8Array.of(1, 2, 3),
            {
                mimeType: 'application/octet-stream',
                kind: 'source',
                saveKind: 'generic',
            },
        );
        let finishConversion: (() => void) | undefined;
        let conversionJobId: string | undefined;
        browserDjvuCapabilityMock.runConversion.mockImplementationOnce(async (
            _djvuPath: string,
            _outputPath: string,
            options: {jobId?: string},
        ) => new Promise(resolve => {
            conversionJobId = options.jobId;
            finishConversion = () => resolve({success: true});
        }));
        browserDjvuCapabilityMock.cancel.mockImplementationOnce(async () => {
            finishConversion?.();
            return {canceled: true};
        });
        const controller = new AbortController();
        const promise = createCombinedPdfFromPaths([djvuRef], {signal: controller.signal});
        await vi.waitFor(() => {
            expect(browserDjvuCapabilityMock.runConversion).toHaveBeenCalledTimes(1);
        });
        const jobId = conversionJobId;
        expect(jobId).toEqual(expect.stringMatching(/^browser-pdf-combine-djvu-/u));
        controller.abort(new DOMException('combine canceled', 'AbortError'));

        await expect(promise).rejects.toThrow('combine canceled');
        expect(browserDjvuCapabilityMock.cancel).toHaveBeenCalledWith(jobId);
    });

    it('keeps unsupported image combine formats on the direct fallback path', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const createCombinedPdfFromPaths = await loadCreateCombinedPdfFromPaths();
        const svgRef = await browserDocumentStore.createStoredDocument(
            'vector.svg',
            Uint8Array.of(60, 115, 118, 103, 62),
            {
                mimeType: 'image/svg+xml',
                kind: 'source',
                saveKind: 'generic',
            },
        );
        browserPdfCombineWorkerMock.canUse.mockReturnValue(true);

        await expect(createCombinedPdfFromPaths([svgRef])).rejects.toThrow();
        expect(browserPdfCombineWorkerMock.run).not.toHaveBeenCalled();
    });

    it('cleans up transient combine refs when opening picked browser inputs fails', async () => {
        vi.stubGlobal('crypto', {
            ...(globalThis.crypto ?? {}),
            randomUUID: vi.fn(() => 'open-failure-ref'),
        });
        const brokenPng = new File([Uint8Array.of(1, 2, 3)], 'broken.png', { type: 'image/png' });
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({ inputFiles: [brokenPng] });
        const failedRef = 'browser://documents/open-failure-ref/broken.png';

        await expect(capability.openCombineDialog()).rejects.toThrow();
        await expect(browserDocumentStore.exists(failedRef)).resolves.toBe(false);
    });

    it.skip('creates one PDF page per TIFF frame on the direct browser fallback path', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const createCombinedPdfFromPaths = await loadCreateCombinedPdfFromPaths();
        const tinyPngBytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 160, 90, 111, 167, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130);
        const tiffRef = await browserDocumentStore.createStoredDocument(
            'scan.tif',
            Uint8Array.of(1, 2, 3),
            {
                mimeType: 'image/tiff',
                kind: 'source',
                saveKind: 'generic',
            },
        );

        utifMock.decode.mockReturnValue([
            {
                width: 2,
                height: 2,
            },
            {
                width: 1,
                height: 3,
            },
        ] as never);
        utifMock.toRGBA8
            .mockReturnValueOnce(new Uint8Array(2 * 2 * 4).fill(255))
            .mockReturnValueOnce(new Uint8Array(1 * 3 * 4).fill(128));

        const putImageData = vi.fn();
        vi.stubGlobal('ImageData', class {
            public constructor(
                public readonly data: Uint8ClampedArray,
                public readonly width: number,
                public readonly height: number,
            ) {}
        });
        vi.stubGlobal('document', {
            cookie: '',
            body: {
                append() {},
                appendChild() {},
                removeChild() {},
            },
            createElement(tagName: string) {
                if (tagName === 'canvas') {
                    return {
                        width: 0,
                        height: 0,
                        getContext() {
                            return { putImageData };
                        },
                        toBlob(callback: (blob: Blob | null) => void) {
                            callback(new Blob([tinyPngBytes], { type: 'image/png' }));
                        },
                    };
                }

                return createMockElement(tagName);
            },
            createElementNS(_namespace: string, tagName: string) {
                return createMockElement(tagName);
            },
            createTextNode(text: string) {
                return { nodeValue: text };
            },
            createComment(text: string) {
                return { nodeValue: text };
            },
            querySelector() {
                return null;
            },
        });

        const result = await createCombinedPdfFromPaths([tiffRef]);
        const document = await PDFDocument.load(result);

        expect(document.getPageCount()).toBe(2);
        expect(utifMock.decode).toHaveBeenCalledTimes(1);
        expect(utifMock.decodeImage).toHaveBeenCalledTimes(2);
        expect(putImageData).toHaveBeenCalledTimes(2);
        expect(browserPdfCombineWorkerMock.run).not.toHaveBeenCalled();
    });

    it.skip('does not add direct-batch PDF or DjVu sources to recents when opening a generated PDF', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const pdfBytes = await createPdfBytes();
        const pdfRef = await browserDocumentStore.createStoredDocument(
            'first.pdf',
            pdfBytes,
            {...PDF_SOURCE_OPTIONS},
        );
        const djvuRef = await browserDocumentStore.createStoredDocument(
            'second.djvu',
            Uint8Array.of(1),
            {
                mimeType: 'image/vnd.djvu',
                kind: 'source',
                saveKind: 'generic',
            },
        );
        browserDjvuCapabilityMock.runConversion.mockImplementation(async (_path: string, outputRef: string) => {
            await browserDocumentStore.write(outputRef, pdfBytes);
            return {success: true};
        });

        const result = await capability.openDocumentDirectBatch([
            pdfRef,
            djvuRef,
        ]);

        expect(result).toEqual(expect.objectContaining({
            kind: 'pdf',
            isGenerated: true,
        }));
        await expect(capability.recentFiles.get()).resolves.toEqual([]);
    });

    it('keeps recent entries when direct browser handle reopen is denied', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'denied.pdf',
            getFile: vi.fn(async () => {
                throw new DOMException('Not allowed', 'NotAllowedError');
            }),
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'denied.pdf',
            new Uint8Array(),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: handle,
                storageMode: 'handle',
            },
        );
        await browserDocumentStore.touchRecentFile(sourceRef);

        await expect(capability.openDocumentDirect(sourceRef)).resolves.toBeNull();
        const recentFiles = await capability.recentFiles.get();
        expect(recentFiles).toEqual([expect.objectContaining({
            originalPath: sourceRef,
            fileName: 'denied.pdf',
        })]);
    });

    it('rejects oversized sources during direct open before reading them', async () => {
        const {
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const getFile = vi.fn(async () => ({
            size: BROWSER_MAX_FULL_READ_BYTES + 1,
            slice(start?: number, end?: number) {
                const requestedLength = Math.max(0, (end ?? 0) - (start ?? 0));
                return new Blob([new Uint8Array(requestedLength)], { type: 'application/pdf' });
            },
        }));
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'huge.pdf',
            getFile,
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'huge.pdf',
            new Uint8Array(),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: handle,
                storageMode: 'handle',
            },
        );

        await expect(capability.openDocumentDirect(sourceRef)).rejects.toThrow(
            'Opening documents is unavailable in the browser for inputs larger than 16MB. Use the native app for files this large.',
        );
    });

    it('streams oversized browser saves to an existing file handle', async () => {
        const {
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const writes: Uint8Array[] = [];
        const savedBytes = new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1);
        const queryPermission = vi.fn(async () => 'granted' as const);
        const requestPermission = vi.fn(async () => 'granted' as const);
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'large-save.pdf',
            getFile: vi.fn(async () => new File([savedBytes], 'large-save.pdf', { type: 'application/pdf' })),
            queryPermission,
            requestPermission,
            createWritable: vi.fn(async () => ({
                write: vi.fn(async (chunk: ArrayBuffer) => {
                    const chunkBytes = new Uint8Array(chunk);
                    const offset = writes.reduce((sum, current) => sum + current.byteLength, 0);
                    savedBytes.set(chunkBytes, offset);
                    writes.push(chunkBytes);
                }),
                close: vi.fn(async () => {}),
            })),
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'large-save.pdf',
            new Uint8Array(),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: handle,
                storageMode: 'handle',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const oversizedBytes = new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1);
        oversizedBytes[0] = 37;
        oversizedBytes[1] = 80;
        oversizedBytes[2] = 68;
        oversizedBytes[3] = 70;
        await browserDocumentStore.writeForBootstrap(workingRef, oversizedBytes, 'test-setup');

        await expect(capability.saveFileStructured(
            workingRef,
            await getRevisionOptions(browserDocumentStore, workingRef),
        )).resolves.toMatchObject({ ok: true });

        expect(queryPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
        expect(requestPermission).not.toHaveBeenCalled();
        const savedEntry = await browserDocumentStore.requireEntry(sourceRef);
        expect(savedEntry.storageMode).toBe('handle');
        await expect(browserDocumentStore.stat(sourceRef)).resolves.toEqual({
            size: BROWSER_MAX_FULL_READ_BYTES + 1,
            modifiedAt: expect.any(Number),
        });
        expect(writes.length).toBeGreaterThan(1);
        expect(writes[0]?.slice(0, 4)).toEqual(Uint8Array.of(37, 80, 68, 70));
    });

    it('requests browser write permission before saving to an existing file handle', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const queryPermission = vi.fn(async () => 'prompt' as const);
        const requestPermission = vi.fn(async () => 'granted' as const);
        const createWritable = vi.fn(async () => ({
            write: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        }));
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'needs-permission.pdf',
            getFile: vi.fn(async () => new File([Uint8Array.of(1)], 'needs-permission.pdf', { type: 'application/pdf' })),
            queryPermission,
            requestPermission,
            createWritable,
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'needs-permission.pdf',
            new Uint8Array(),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: handle,
                storageMode: 'handle',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        await browserDocumentStore.writeForBootstrap(workingRef, Uint8Array.of(37, 80, 68, 70), 'test-setup');

        await expect(capability.saveFileStructured(
            workingRef,
            await getRevisionOptions(browserDocumentStore, workingRef),
        )).resolves.toMatchObject({ ok: true });

        expect(queryPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
        expect(requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
        expect(createWritable).toHaveBeenCalledOnce();
    });

    it('rejects browser structured saves without a revision token', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'missing-revision.pdf',
            Uint8Array.of(37, 80, 68, 70),
            {...PDF_SOURCE_OPTIONS},
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);

        await expect(capability.saveFileStructured(workingRef)).resolves.toMatchObject({
            ok: false,
            reason: 'write-failed',
            message: expect.stringContaining('Document revision token is required'),
        });
    });

    it('rejects browser structured saves with a stale revision token', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'stale-revision.pdf',
            Uint8Array.of(37, 80, 68, 70),
            {...PDF_SOURCE_OPTIONS},
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const staleRevisionOptions = await getRevisionOptions(browserDocumentStore, workingRef);
        await browserDocumentStore.writeForBootstrap(
            workingRef,
            Uint8Array.of(37, 80, 68, 70, 10),
            'test-advance-revision',
        );

        await expect(capability.saveFileStructured(workingRef, staleRevisionOptions)).resolves.toMatchObject({
            ok: false,
            reason: 'write-failed',
            message: expect.stringContaining('Document changed while this edit was being prepared'),
        });
    });

    it.each([
        {
            name: 'structured save',
            invoke: (
                capability: IDocumentsFileCapability,
                workingRef: string,
                revisionOptions: Awaited<ReturnType<typeof getRevisionOptions>>,
            ) => capability.saveFileStructured(workingRef, revisionOptions),
            expected: {
                ok: false,
                reason: 'user-canceled',
            },
        },
        {
            name: 'PDF data save',
            invoke: async (
                capability: IDocumentsFileCapability,
                workingRef: string,
                revisionOptions: Awaited<ReturnType<typeof getRevisionOptions>>,
            ) => capability.savePdfData(workingRef, await createPdfBytes(), revisionOptions),
            expected: {
                isValid: false,
                errors: [],
            },
        },
    ])('preserves caches when a browser $name is canceled', async ({
        invoke,
        expected,
    }) => {
        const showSaveFilePicker = vi.fn(async () => {
            throw new DOMException('Canceled', 'AbortError');
        });
        const clearSearchCaches = vi.fn();
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({
            clearSearchCaches,
            windowOverrides: { showSaveFilePicker },
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'cancel-save.pdf',
            await createPdfBytes(),
            PDF_SOURCE_OPTIONS,
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);

        await expect(invoke(
            capability,
            workingRef,
            await getRevisionOptions(browserDocumentStore, workingRef),
        )).resolves.toMatchObject(expected);
        expect(clearSearchCaches).not.toHaveBeenCalled();
    });

    it('stages browser PDF data in the working copy without publishing the source', async () => {
        const showSaveFilePicker = vi.fn(async () => {
            throw new Error('Working-copy-only staging must not open a save picker');
        });
        const createWritable = vi.fn(async () => ({
            write: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        }));
        const sourceHandle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'working-copy-only.pdf',
            getFile: vi.fn(async () => new File([], 'working-copy-only.pdf', {type: 'application/pdf'})),
            createWritable,
        });
        const clearSearchCaches = vi.fn();
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({
            clearSearchCaches,
            windowOverrides: {showSaveFilePicker},
        });
        const sourceBytes = await createPdfBytes();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'working-copy-only.pdf',
            sourceBytes,
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: sourceHandle,
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const stagedDocument = await PDFDocument.create();
        stagedDocument.addPage();
        stagedDocument.addPage();
        const stagedBytes = new Uint8Array(await stagedDocument.save());
        const revisionOptions = await getRevisionOptions(browserDocumentStore, workingRef);

        const result = await capability.savePdfData(
            workingRef,
            stagedBytes,
            {
                ...revisionOptions,
                workingCopyOnly: true,
            },
        );

        expect(result).toMatchObject({
            isValid: true,
            errors: [],
            warnings: [],
        });
        await expect(browserDocumentStore.read(workingRef)).resolves.toEqual(stagedBytes);
        await expect(browserDocumentStore.read(sourceRef)).resolves.toEqual(sourceBytes);
        expect(showSaveFilePicker).not.toHaveBeenCalled();
        expect(createWritable).not.toHaveBeenCalled();
        expect(clearSearchCaches).toHaveBeenCalledOnce();
    });

    it('streams browser PDF data chunks into staged document chunks before saving', async () => {
        const clearSearchCaches = vi.fn();
        const writes: Uint8Array[] = [];
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'chunked-save.pdf',
            getFile: vi.fn(async () => new File([new Uint8Array()], 'chunked-save.pdf', { type: 'application/pdf' })),
            createWritable: vi.fn(async () => ({
                write: vi.fn(async (chunk: ArrayBuffer) => {
                    writes.push(new Uint8Array(chunk));
                }),
                close: vi.fn(async () => {}),
            })),
        });
        const {
            BROWSER_DOCUMENT_CHUNK_SIZE,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({ clearSearchCaches });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'chunked-save.pdf',
            await createPdfBytes(),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: handle,
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const writeSpy = vi.spyOn(browserDocumentStore, 'write');
        const pdfPrefix = await createPdfBytes();
        const data = new Uint8Array(BROWSER_DOCUMENT_CHUNK_SIZE + 17);
        data.set(pdfPrefix.subarray(0, Math.min(pdfPrefix.byteLength, data.byteLength)));
        data[data.byteLength - 1] = 23;

        const result = await capability.savePdfDataChunks(workingRef, data.byteLength, [
            data.subarray(0, 3),
            data.subarray(3, BROWSER_DOCUMENT_CHUNK_SIZE + 5),
            data.subarray(BROWSER_DOCUMENT_CHUNK_SIZE + 5),
        ], await getRevisionOptions(browserDocumentStore, workingRef));

        expect(result).toMatchObject({
            isValid: true,
            errors: [],
            warnings: [],
        });
        expect(writeSpy).not.toHaveBeenCalled();
        const entry = await browserDocumentStore.requireEntry(workingRef);
        expect(entry.storageMode).toBe('chunked');
        await expect(browserDocumentStore.readRange(workingRef, 0, 3)).resolves.toEqual(data.subarray(0, 3));
        await expect(browserDocumentStore.readRange(
            workingRef,
            data.byteLength - 1,
            1,
        )).resolves.toEqual(Uint8Array.of(23));
        expect(writes.length).toBe(2);
        expect(clearSearchCaches).toHaveBeenCalledOnce();
    });

    it('does not report oversized invalid browser PDF data chunks as valid', async () => {
        const clearSearchCaches = vi.fn();
        const {
            BROWSER_DOCUMENT_CHUNK_SIZE,
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({ clearSearchCaches });
        const originalBytes = await createPdfBytes();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'invalid-oversized-chunked-save.pdf',
            originalBytes,
            {...PDF_SOURCE_OPTIONS},
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        pdfjsModule.getDocument.mockImplementationOnce(() => ({promise: Promise.resolve().then(() => {
            throw new Error('invalid oversized pdf');
        })}));
        async function* invalidOversizedChunks() {
            let bytesWritten = 0;
            const totalBytes = BROWSER_MAX_FULL_READ_BYTES + 1;
            while (bytesWritten < totalBytes) {
                const length = Math.min(BROWSER_DOCUMENT_CHUNK_SIZE, totalBytes - bytesWritten);
                yield new Uint8Array(length);
                bytesWritten += length;
            }
        }

        const result = await capability.savePdfDataChunks(
            workingRef,
            BROWSER_MAX_FULL_READ_BYTES + 1,
            invalidOversizedChunks(),
        );

        expect(result).toMatchObject({
            isValid: false,
            errors: ['invalid oversized pdf'],
        });
        await expect(browserDocumentStore.read(workingRef)).resolves.toEqual(originalBytes);
        expect(clearSearchCaches).not.toHaveBeenCalled();
    });

    it('saves oversized valid browser PDF data chunks after range-backed validation', async () => {
        const clearSearchCaches = vi.fn();
        let writtenBytes = 0;
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'valid-oversized-chunked-save.pdf',
            createWritable: vi.fn(async () => ({
                write: vi.fn(async (chunk: ArrayBuffer) => {
                    writtenBytes += chunk.byteLength;
                }),
                close: vi.fn(async () => {}),
            })),
        });
        const {
            BROWSER_DOCUMENT_CHUNK_SIZE,
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({ clearSearchCaches });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'valid-oversized-chunked-save.pdf',
            await createPdfBytes(),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: handle,
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const pdfPrefix = await createPdfBytes();
        async function* validOversizedChunks() {
            let bytesWritten = 0;
            const totalBytes = BROWSER_MAX_FULL_READ_BYTES + 1;
            while (bytesWritten < totalBytes) {
                const length = Math.min(BROWSER_DOCUMENT_CHUNK_SIZE, totalBytes - bytesWritten);
                const chunk = new Uint8Array(length);
                if (bytesWritten === 0) {
                    chunk.set(pdfPrefix.subarray(0, Math.min(pdfPrefix.byteLength, chunk.byteLength)));
                }
                yield chunk;
                bytesWritten += length;
            }
        }

        const result = await capability.savePdfDataChunks(
            workingRef,
            BROWSER_MAX_FULL_READ_BYTES + 1,
            validOversizedChunks(),
            await getRevisionOptions(browserDocumentStore, workingRef),
        );

        expect(result).toMatchObject({
            isValid: true,
            errors: [],
            warnings: [],
        });
        expect(pdfjsModule.getDocument).toHaveBeenCalledWith(expect.objectContaining({length: BROWSER_MAX_FULL_READ_BYTES + 1}));
        expect(writtenBytes).toBe(BROWSER_MAX_FULL_READ_BYTES + 1);
        expect(clearSearchCaches).toHaveBeenCalledOnce();
    });

    it('fails browser saves without opening the writer when write permission is denied', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const queryPermission = vi.fn(async () => 'prompt' as const);
        const requestPermission = vi.fn(async () => 'denied' as const);
        const createWritable = vi.fn(async () => ({
            write: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        }));
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'denied.pdf',
            getFile: vi.fn(async () => new File([Uint8Array.of(1)], 'denied.pdf', { type: 'application/pdf' })),
            queryPermission,
            requestPermission,
            createWritable,
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'denied.pdf',
            new Uint8Array(),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: handle,
                storageMode: 'handle',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        await browserDocumentStore.writeForBootstrap(workingRef, Uint8Array.of(37, 80, 68, 70), 'test-setup');

        await expect(capability.saveFileStructured(
            workingRef,
            await getRevisionOptions(browserDocumentStore, workingRef),
        )).resolves.toMatchObject({
            ok: false,
            reason: 'write-failed',
            message: expect.stringContaining('Browser write permission was not granted for this file.'),
        });

        expect(createWritable).not.toHaveBeenCalled();
    });

    it('streams oversized browser save-as to a picked file handle', async () => {
        const writes: Uint8Array[] = [];
        const savedBytes = new Uint8Array(BROWSER_FULL_READ_LIMIT + 1);
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'exported-large.pdf',
            getFile: vi.fn(async () => new File([savedBytes], 'exported-large.pdf', { type: 'application/pdf' })),
            createWritable: vi.fn(async () => ({
                write: vi.fn(async (chunk: ArrayBuffer) => {
                    const chunkBytes = new Uint8Array(chunk);
                    const offset = writes.reduce((sum, current) => sum + current.byteLength, 0);
                    savedBytes.set(chunkBytes, offset);
                    writes.push(chunkBytes);
                }),
                close: vi.fn(async () => {}),
            })),
        });
        const {
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({ windowOverrides: { showSaveFilePicker: vi.fn(async () => handle) } });
        expect(BROWSER_MAX_FULL_READ_BYTES).toBe(BROWSER_FULL_READ_LIMIT);
        const workingRef = await browserDocumentStore.createStoredDocument(
            'oversized.pdf',
            new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1),
            {
                mimeType: 'application/pdf',
                kind: 'working',
                saveKind: 'pdf',
            },
        );

        const sourceRef = await capability.savePdfAs(
            workingRef,
            undefined,
            await getRevisionOptions(browserDocumentStore, workingRef),
        );

        expect(sourceRef).not.toBeNull();
        const sourceEntry = sourceRef
            ? await browserDocumentStore.requireEntry(sourceRef)
            : null;
        expect(sourceEntry?.storageMode).toBe('handle');
        expect(sourceEntry?.saveHandle).toBe(handle);
        await expect(browserDocumentStore.stat(sourceRef!)).resolves.toEqual({
            size: BROWSER_MAX_FULL_READ_BYTES + 1,
            modifiedAt: expect.any(Number),
        });
        expect(writes.length).toBeGreaterThan(1);
    });

    it('serializes regular saves from working copies that share one source', async () => {
        const firstWriteStarted = Promise.withResolvers<undefined>();
        const releaseFirstWrite = Promise.withResolvers<undefined>();
        let writableIndex = 0;
        const createWritable = vi.fn(async () => {
            const index = writableIndex++;
            return {
                write: vi.fn(async () => {
                    if (index === 0) {
                        firstWriteStarted.resolve(undefined);
                        await releaseFirstWrite.promise;
                    }
                }),
                close: vi.fn(async () => undefined),
            };
        });
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'shared.pdf',
            getFile: vi.fn(async () => new File([], 'shared.pdf', {type: 'application/pdf'})),
            createWritable,
        });
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'shared.pdf',
            Uint8Array.of(37, 80, 68, 70),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: handle,
            },
        );
        const firstWorkingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const secondWorkingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        await browserDocumentStore.writeForBootstrap(
            firstWorkingRef,
            Uint8Array.of(37, 80, 68, 70, 1),
            'first-save-test',
        );
        await browserDocumentStore.writeForBootstrap(
            secondWorkingRef,
            Uint8Array.of(37, 80, 68, 70, 2),
            'second-save-test',
        );

        const firstSave = capability.saveFileStructured(
            firstWorkingRef,
            await getRevisionOptions(browserDocumentStore, firstWorkingRef),
        );
        const secondSave = capability.saveFileStructured(
            secondWorkingRef,
            await getRevisionOptions(browserDocumentStore, secondWorkingRef),
        );
        await firstWriteStarted.promise;
        await new Promise<undefined>(resolve => setImmediate(() => resolve(undefined)));
        expect(createWritable).toHaveBeenCalledOnce();

        releaseFirstWrite.resolve(undefined);
        await expect(Promise.all([
            firstSave,
            secondSave,
        ])).resolves.toEqual([
            expect.objectContaining({ok: true}),
            expect.objectContaining({ok: true}),
        ]);
        expect(createWritable).toHaveBeenCalledTimes(2);
    });

    it('does not deadlock when a regular save queues behind Save As for the same source', async () => {
        const saveAsWriteStarted = Promise.withResolvers<undefined>();
        const releaseSaveAsWrite = Promise.withResolvers<undefined>();
        const saveAsHandle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'save-as.pdf',
            getFile: vi.fn(async () => new File([], 'save-as.pdf', {type: 'application/pdf'})),
            createWritable: vi.fn(async () => ({
                write: vi.fn(async () => {
                    saveAsWriteStarted.resolve(undefined);
                    await releaseSaveAsWrite.promise;
                }),
                close: vi.fn(async () => {}),
            })),
        });
        const originalCreateWritable = vi.fn(async () => ({
            write: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        }));
        const originalHandle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'original.pdf',
            getFile: vi.fn(async () => new File([], 'original.pdf', {type: 'application/pdf'})),
            createWritable: originalCreateWritable,
        });
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({windowOverrides: {showSaveFilePicker: vi.fn(async () => saveAsHandle)}});
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'original.pdf',
            Uint8Array.of(37, 80, 68, 70),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: originalHandle,
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const revisionOptions = await getRevisionOptions(browserDocumentStore, workingRef);

        const saveAsPromise = capability.savePdfAs(workingRef, undefined, revisionOptions);
        await saveAsWriteStarted.promise;
        const regularSavePromise = capability.saveFileStructured(workingRef, revisionOptions);
        await new Promise<undefined>(resolve => setImmediate(() => resolve(undefined)));
        releaseSaveAsWrite.resolve(undefined);

        await expect(saveAsPromise).resolves.not.toBeNull();
        await expect(regularSavePromise).resolves.toMatchObject({
            ok: false,
            reason: 'write-failed',
            message: expect.stringContaining('source changed'),
        });
        expect(originalCreateWritable).not.toHaveBeenCalled();
    });

    it('blocks browser save-as when a working copy exceeds the full-read budget', async () => {
        const {
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const workingRef = await browserDocumentStore.createStoredDocument(
            'oversized.pdf',
            new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1),
            {
                mimeType: 'application/pdf',
                kind: 'working',
                saveKind: 'pdf',
            },
        );

        await expect(capability.savePdfAs(
            workingRef,
            undefined,
            await getRevisionOptions(browserDocumentStore, workingRef),
        )).rejects.toThrow(
            `Saving documents is unavailable in the browser for inputs larger than ${BROWSER_MAX_FULL_READ_BYTES / (1024 * 1024)}MB`,
        );
    });

    it('does not download or retain a DOCX output when its writer is already canceled', async () => {
        const createObjectURL = vi.fn(() => 'blob:docx-canceled');
        const revokeObjectURL = vi.fn();
        const NativeURL = URL;
        class TestURL extends NativeURL {}
        Object.defineProperties(TestURL, {
            createObjectURL: {value: createObjectURL},
            revokeObjectURL: {value: revokeObjectURL},
        });
        vi.stubGlobal('URL', TestURL);
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({windowOverrides: {showSaveFilePicker: undefined}});
        const outputPath = await capability.saveDocxAs('/tmp/work.pdf');
        expect(outputPath).not.toBeNull();
        if (!outputPath) {
            throw new Error('Expected browser DOCX output path');
        }

        const controller = new AbortController();
        controller.abort(new DOMException('DOCX export was canceled.', 'AbortError'));
        const writeDocxFile = capability.writeDocxFile as (
            path: string,
            data: Uint8Array,
            signal?: AbortSignal,
        ) => Promise<boolean>;

        await expect(writeDocxFile(outputPath, Uint8Array.of(1, 2, 3), controller.signal))
            .rejects.toMatchObject({name: 'AbortError'});
        await expect(browserDocumentStore.exists(outputPath)).resolves.toBe(false);
        expect(createObjectURL).not.toHaveBeenCalled();
        expect(revokeObjectURL).not.toHaveBeenCalled();
    });

    it('revokes a browser DOCX download when cancellation lands after URL creation', async () => {
        const controller = new AbortController();
        const createObjectURL = vi.fn(() => {
            controller.abort(new DOMException('DOCX export was canceled.', 'AbortError'));
            return 'blob:docx-canceled-after-url';
        });
        const revokeObjectURL = vi.fn();
        const NativeURL = URL;
        class TestURL extends NativeURL {}
        Object.defineProperties(TestURL, {
            createObjectURL: {value: createObjectURL},
            revokeObjectURL: {value: revokeObjectURL},
        });
        vi.stubGlobal('URL', TestURL);
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({windowOverrides: {showSaveFilePicker: undefined}});
        const outputPath = await capability.saveDocxAs('/tmp/work.pdf');
        expect(outputPath).not.toBeNull();
        if (!outputPath) {
            throw new Error('Expected browser DOCX output path');
        }

        const click = vi.fn();
        const documentStub = cast<{createElement: (tagName: string) => {click: () => void}}>(globalThis.document);
        const createElement = documentStub.createElement.bind(documentStub);
        vi.spyOn(documentStub, 'createElement').mockImplementation((tagName: string) => {
            const element = createElement(tagName);
            if (tagName === 'a') {
                element.click = click;
            }
            return element;
        });

        await expect(capability.writeDocxFile(outputPath, Uint8Array.of(1, 2, 3), controller.signal))
            .rejects.toMatchObject({name: 'AbortError'});
        await expect(browserDocumentStore.exists(outputPath)).resolves.toBe(false);
        expect(createObjectURL).toHaveBeenCalledOnce();
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:docx-canceled-after-url');
        expect(click).not.toHaveBeenCalled();
    });

    it('fails early for oversized browser download fallback saves without a handle', async () => {
        const {
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({windowOverrides: {showSaveFilePicker: undefined}});
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'source.pdf',
            Uint8Array.of(1),
            {...PDF_SOURCE_OPTIONS},
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        await browserDocumentStore.writeForBootstrap(
            workingRef,
            new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1),
            'test-setup',
        );

        await expect(capability.savePdfAs(
            workingRef,
            undefined,
            await getRevisionOptions(browserDocumentStore, workingRef),
        )).rejects.toThrow(
            'Use the native app for files this large.',
        );
    });
});
