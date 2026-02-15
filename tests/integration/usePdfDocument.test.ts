import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const loggerError = vi.fn();
const loggerDebug = vi.fn();

vi.mock('@app/utils/browser-logger', () => ({BrowserLogger: {
    error: loggerError,
    warn: vi.fn(),
    debug: loggerDebug,
}}));

interface ILoadingTask {
    promise: Promise<unknown>;
    destroy: ReturnType<typeof vi.fn>;
}

interface IPdfjsDataRangeTransport {
    onDataRange: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    requestDataRange: ((begin: number, end: number) => Promise<void>) | null;
    onError?: (error: unknown) => void;
}

class MockPdfDataRangeTransport implements IPdfjsDataRangeTransport {
    public onDataRange = vi.fn();
    public abort = vi.fn();
    public requestDataRange: ((begin: number, end: number) => Promise<void>) | null = null;

    constructor(length: number, initialData: Uint8Array) {
        void length;
        void initialData;
    }
}

const pdfjsState: {
    GlobalWorkerOptions: { workerSrc: string };
    VerbosityLevel: { ERRORS: number };
    getDocument: ReturnType<typeof vi.fn>;
    PDFDataRangeTransport?: typeof MockPdfDataRangeTransport;
} = {
    GlobalWorkerOptions: { workerSrc: '' },
    VerbosityLevel: { ERRORS: 0 },
    getDocument: vi.fn(),
    PDFDataRangeTransport: MockPdfDataRangeTransport,
};

vi.mock('pdfjs-dist', () => pdfjsState);

const electronApi = {readFileRange: vi.fn()};

vi.mock('@app/utils/electron', () => ({getElectronAPI: () => electronApi}));

const { usePdfDocument } = await import('@app/composables/pdf/usePdfDocument');

describe('usePdfDocument failure handling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        pdfjsState.PDFDataRangeTransport = MockPdfDataRangeTransport;
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage: vi.fn(async () => ({getViewport: vi.fn(() => ({
                    width: 100,
                    height: 200,
                }))})),
                destroy: vi.fn(),
            }),
            destroy: vi.fn(),
        } as ILoadingTask);
    });

    it('returns null and clears loading when PDF.js range transport API is unavailable', async () => {
        pdfjsState.PDFDataRangeTransport = undefined;
        electronApi.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));

        const documentState = usePdfDocument();
        const result = await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/a.pdf',
            size: 3,
        });

        expect(result).toBeNull();
        expect(documentState.isLoading.value).toBe(false);
        expect(loggerError).toHaveBeenCalledWith(
            'pdf-document',
            'Failed to load PDF',
            expect.any(Error),
        );
    });

    it('returns null and clears loading when initial range read fails', async () => {
        electronApi.readFileRange.mockRejectedValue(new Error('read failed'));

        const documentState = usePdfDocument();
        const result = await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/b.pdf',
            size: 7,
        });

        expect(result).toBeNull();
        expect(documentState.isLoading.value).toBe(false);
        expect(loggerError).toHaveBeenCalledWith(
            'pdf-document',
            'Failed to load PDF',
            expect.any(Error),
        );
    });
});
