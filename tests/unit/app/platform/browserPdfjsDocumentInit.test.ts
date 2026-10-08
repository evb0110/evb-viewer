import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {BROWSER_MAX_FULL_READ_BYTES} from '@app/platform/browser/browserDocumentConstants';
import {BrowserDocumentStore} from '@app/platform/browser/browserDocumentRepository';
import {
    createFileSystemFileHandle,
    FakeIndexedDbFactory,
    MemoryStorage,
} from '@tests/unit/app/platform/browserPlatformTestDoubles';

const pdfjsModule = vi.hoisted(() => {
    class MockPdfDataRangeTransport {
        public onDataRange = vi.fn();
        public abort = vi.fn();
        public requestDataRange: ((begin: number, end: number) => void) | null = null;

        constructor(
            public readonly length: number,
            public readonly initialData: Uint8Array,
        ) {}
    }

    return {
        version: '6.3.311',
        GlobalWorkerOptions: { workerSrc: undefined as string | undefined },
        VerbosityLevel: {ERRORS: 3},
        getDocument: vi.fn(),
        PDFDataRangeTransport: MockPdfDataRangeTransport,
    };
});

const browserDocumentStoreMock = vi.hoisted(() => ({
    getContentSnapshot: vi.fn(),
    readRange: vi.fn(),
}));

vi.mock('pdfjs-dist', () => pdfjsModule);
vi.mock('@app/platform/browserDocumentStore', () => ({
    BROWSER_DOCUMENT_CHUNK_SIZE: 1024 * 1024,
    browserDocumentStore: browserDocumentStoreMock,
}));

describe('browserPdfjsDocumentInit', () => {
    beforeEach(() => {
        vi.resetModules();
        pdfjsModule.getDocument.mockReset();
        pdfjsModule.GlobalWorkerOptions.workerSrc = undefined;
        browserDocumentStoreMock.getContentSnapshot.mockReset();
        browserDocumentStoreMock.readRange.mockReset();
        browserDocumentStoreMock.getContentSnapshot.mockResolvedValue({
            size: 3 * 1024 * 1024,
            contentSignature: 'content-token-1',
        });
        browserDocumentStoreMock.readRange.mockImplementation(async (_path: string, _offset: number, length: number) => new Uint8Array(length));
    });

    it('configures pdf.js worker source and leaves worker mode enabled', async () => {
        const {
            createPdfjsDocumentInit,
            getPdfjsLib,
        } = await import('@app/platform/browser-api/browserPdfjsDocumentInit');
        const {
            getPdfjsAssetDir,
            getViewerAssetResolver,
        } = await import('@app/utils/viewerAssets');

        const pdfjsLib = await getPdfjsLib();
        const input = new Uint8Array([
            1,
            2,
            3,
        ]);
        const init = createPdfjsDocumentInit(pdfjsLib, input);

        expect(pdfjsModule.GlobalWorkerOptions.workerSrc).toBe(getViewerAssetResolver().pdfWorkerUrl());
        expect(init).not.toHaveProperty('disableWorker');
        expect(init).toMatchObject({
            data: expect.any(Uint8Array),
            verbosity: pdfjsModule.VerbosityLevel.ERRORS,
            standardFontDataUrl: getPdfjsAssetDir('standard_fonts'),
            cMapUrl: getPdfjsAssetDir('cmaps'),
            cMapPacked: true,
            wasmUrl: getPdfjsAssetDir('wasm'),
            iccUrl: getPdfjsAssetDir('iccs'),
            useSystemFonts: false,
        });
        const initData = init.data;
        expect(initData).not.toBe(input);
        expect(Array.from(initData)).toEqual(Array.from(input));
        expect(Array.from(input)).toEqual([
            1,
            2,
            3,
        ]);
    });

    it('aggregates short browser ranges before delivering them to PDF.js', async () => {
        const {
            createPdfjsDocumentInitFromBrowserDocument,
            getPdfjsLib,
        } = await import('@app/platform/browser-api/browserPdfjsDocumentInit');

        const pdfjsLib = await getPdfjsLib();
        const init = await createPdfjsDocumentInitFromBrowserDocument(
            pdfjsLib,
            'browser://documents/test.pdf',
        );
        const range = 'range' in init ? init.range : undefined;
        if (!range) {
            throw new Error('Expected a PDF.js range transport for the large browser document');
        }

        browserDocumentStoreMock.readRange.mockImplementation(async (_path: string, offset: number, length: number) => {
            if (offset === 1024 * 1024) {
                expect(length).toBe(12);
                return new Uint8Array(8);
            }
            if (offset === (1024 * 1024) + 8) {
                expect(length).toBe(4);
                return new Uint8Array(4);
            }
            return new Uint8Array(length);
        });

        range.requestDataRange?.(1024 * 1024, (1024 * 1024) + 12);

        await vi.waitFor(() => {
            expect(range.onDataRange).toHaveBeenCalledTimes(1);
        });
        expect(range.onDataRange).toHaveBeenCalledWith(1024 * 1024, expect.objectContaining({ byteLength: 12 }));
    });

    it('aborts browser range transport when the source signature changes', async () => {
        const onRangeReadFailure = vi.fn();
        const {
            createPdfjsDocumentInitFromBrowserDocument,
            getPdfjsLib,
        } = await import('@app/platform/browser-api/browserPdfjsDocumentInit');

        const pdfjsLib = await getPdfjsLib();
        const init = await createPdfjsDocumentInitFromBrowserDocument(
            pdfjsLib,
            'browser://documents/test.pdf',
            { onRangeReadFailure },
        );
        const range = 'range' in init ? init.range : undefined;
        if (!range) {
            throw new Error('Expected a PDF.js range transport for the large browser document');
        }

        browserDocumentStoreMock.getContentSnapshot.mockResolvedValue({
            size: 3 * 1024 * 1024,
            contentSignature: 'content-token-2',
        });
        range.requestDataRange?.(1024 * 1024, (1024 * 1024) + 12);

        await vi.waitFor(() => {
            expect(onRangeReadFailure).toHaveBeenCalledTimes(1);
        });
        expect(range.onDataRange).not.toHaveBeenCalled();
    });

    it('refuses an oversized range request instead of allocating a whole large PDF', async () => {
        const onRangeReadFailure = vi.fn();
        const {
            createPdfjsDocumentInitFromBrowserDocument,
            getPdfjsLib,
        } = await import('@app/platform/browser-api/browserPdfjsDocumentInit');

        const pdfjsLib = await getPdfjsLib();
        const init = await createPdfjsDocumentInitFromBrowserDocument(
            pdfjsLib,
            'browser://documents/large.pdf',
            {onRangeReadFailure},
        );
        const range = 'range' in init ? init.range : undefined;
        if (!range) {
            throw new Error('Expected a PDF.js range transport for the large browser document');
        }

        range.requestDataRange?.(0, BROWSER_MAX_FULL_READ_BYTES + 1);

        await vi.waitFor(() => {
            expect(onRangeReadFailure).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('safe')}));
        });
        expect(browserDocumentStoreMock.readRange).toHaveBeenCalledTimes(1);
        expect(range.onDataRange).not.toHaveBeenCalled();
    });

    it.each([
        'initial-after',
        'range-before',
        'range-after',
    ] as const)('rejects a same-size, same-time physical replacement at %s', async boundary => {
        vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
        vi.stubGlobal('window', {localStorage: new MemoryStorage()});
        vi.stubGlobal('document', {cookie: ''});
        try {
            const bytes = new Uint8Array(3 * 1024 * 1024);
            let currentFile = new File([bytes], 'physical.pdf', {lastModified: 11});
            const handle = createFileSystemFileHandle({
                name: currentFile.name,
                getFile: async () => currentFile,
            });
            const store = new BrowserDocumentStore();
            const ref = await store.registerFile(currentFile, {saveHandle: handle});
            const replace = () => {
                bytes[bytes.length - 1] = 9;
                currentFile = new File([bytes], currentFile.name, {lastModified: 11});
            };
            browserDocumentStoreMock.getContentSnapshot.mockImplementation((path: string) => store.getContentSnapshot(path));
            let replaceAfterRead = boundary === 'initial-after';
            browserDocumentStoreMock.readRange.mockImplementation(async (path: string, offset: number, length: number) => {
                const result = await store.readRange(path, offset, length);
                if (replaceAfterRead) {
                    replaceAfterRead = false;
                    replace();
                }
                return result;
            });
            const {
                createPdfjsDocumentInitFromBrowserDocument, getPdfjsLib,
            } = await import('@app/platform/browser-api/browserPdfjsDocumentInit');
            const lib = await getPdfjsLib();
            if (boundary === 'initial-after') {
                await expect(createPdfjsDocumentInitFromBrowserDocument(lib, ref)).rejects.toThrow('Browser PDF source changed');
                return;
            }
            const onRangeReadFailure = vi.fn();
            const init = await createPdfjsDocumentInitFromBrowserDocument(lib, ref, {onRangeReadFailure});
            const range = 'range' in init ? init.range : undefined;
            if (!range) throw new Error('Expected a PDF.js range transport');
            if (boundary === 'range-before') replace();
            else replaceAfterRead = true;
            range.requestDataRange?.(1024 * 1024, 2 * 1024 * 1024);
            await vi.waitFor(() => {
                expect(onRangeReadFailure).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('Browser PDF source changed')}));
            });
            expect(range.onDataRange).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
