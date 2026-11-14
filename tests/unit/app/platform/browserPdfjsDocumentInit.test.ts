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
        expect(range.onDataRange).toHaveBeenCalledWith(1024 * 1024, expect.objectContaining({ byteLength: 12 }), true);
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

    it('serves a range larger than 16 MiB as chunk-sized deliveries', async () => {
        const onRangeReadFailure = vi.fn();
        const size = BROWSER_MAX_FULL_READ_BYTES * 2;
        browserDocumentStoreMock.getContentSnapshot.mockResolvedValue({
            size,
            contentSignature: 'content-token-1',
        });
        browserDocumentStoreMock.readRange.mockImplementation(async (_path: string, offset: number, length: number) =>
            new Uint8Array(length).fill(offset / (1024 * 1024)));
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

        const begin = 1024 * 1024;
        const end = begin + BROWSER_MAX_FULL_READ_BYTES + 5;
        range.requestDataRange?.(begin, end);

        await vi.waitFor(() => {
            expect(vi.mocked(range.onDataRange).mock.calls.at(-1)?.[2]).toBe(true);
        });
        const deliveries = vi.mocked(range.onDataRange).mock.calls as Array<[number, Uint8Array, boolean]>;
        expect(onRangeReadFailure).not.toHaveBeenCalled();
        expect(deliveries.every(([
            deliveryBegin,
            chunk,
        ]) => deliveryBegin === begin && chunk.byteLength <= 1024 * 1024)).toBe(true);
        expect(deliveries.map(([
            , , isLast,
        ]) => isLast).filter(Boolean)).toEqual([true]);
        let offset = begin;
        for (const [
            , chunk,
        ] of deliveries) {
            expect([
                chunk[0],
                chunk.at(-1),
            ]).toEqual([
                offset / (1024 * 1024),
                offset / (1024 * 1024),
            ]);
            offset += chunk.byteLength;
        }
        expect(offset).toBe(end);
    });

    // A working copy reads the file it opened as one snapshot, so a same-size, same-time replacement of the
    // file never mixes into the bytes the viewer reads; Save finds the change.
    it('keeps reading the bytes it opened after a same-size, same-time replacement of the file', async () => {
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
            const source = await store.registerFile(currentFile, {saveHandle: handle});
            const ref = await store.cloneAsWorkingCopy(source);
            browserDocumentStoreMock.getContentSnapshot.mockImplementation((path: string) => store.getContentSnapshot(path));
            browserDocumentStoreMock.readRange.mockImplementation((path: string, offset: number, length: number) => store.readRange(path, offset, length));
            const {
                createPdfjsDocumentInitFromBrowserDocument, getPdfjsLib,
            } = await import('@app/platform/browser-api/browserPdfjsDocumentInit');
            const init = await createPdfjsDocumentInitFromBrowserDocument(await getPdfjsLib(), ref, {onRangeReadFailure: vi.fn()});
            const range = 'range' in init ? init.range : undefined;
            if (!range) throw new Error('Expected a PDF.js range transport');
            bytes[bytes.length - 1] = 9;
            currentFile = new File([bytes], currentFile.name, {lastModified: 11});
            range.requestDataRange?.(2 * 1024 * 1024, 3 * 1024 * 1024);
            await vi.waitFor(() => expect(range.onDataRange).toHaveBeenCalled());
            const delivered = vi.mocked(range.onDataRange).mock.calls.map(([, chunk]) => chunk as Uint8Array);
            expect(delivered.at(-1)?.at(-1)).toBe(0);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
