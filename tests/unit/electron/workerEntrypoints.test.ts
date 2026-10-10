import {
    beforeAll,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    close: vi.fn(),
    on: vi.fn(),
    postMessage: vi.fn(),
    workerData: {
        tesseractBinary: '/tmp/tesseract',
        tessdataPath: '/tmp/tessdata',
        pdftoppmBinary: '/tmp/pdftoppm',
        qpdfBinary: '/tmp/qpdf',
        tempDir: '/tmp',
    },
}));

vi.mock('worker_threads', () => ({
    parentPort: {
        close: mocks.close,
        on: mocks.on,
        off: vi.fn(),
        postMessage: mocks.postMessage,
    },
    workerData: mocks.workerData,
}));
const entrypoints = [
    [
        () => import('@electron/features/djvu/main/pdfWorker'),
        'Invalid DjVu PDF worker payload',
    ],
    [
        () => import('@electron/features/documents/main/pdfConformanceWorker'),
        'Invalid PDF conformance worker payload',
    ],
    [
        () => import('@electron/features/image-export/main/tiffCombineWorker'),
        'Invalid TIFF combine worker payload',
    ],
    [
        () => import('@electron/features/page-ops/main/cropWorker'),
        'Invalid crop worker payload',
    ],
    [
        () => import('@electron/image/pdfCombineWorker'),
        'No input files were provided',
    ],
] as const;

const startupMessages: unknown[][] = [];
const cancellationListeners: boolean[] = [];

beforeAll(async () => {
    // Cold module loading is setup. Keep each entrypoint's result separately
    // so an error from one worker cannot stand in for the other four.
    for (const [load] of entrypoints) {
        mocks.postMessage.mockClear();
        mocks.on.mockClear();
        await load();
        startupMessages.push(mocks.postMessage.mock.calls.map(call => call[0]));
        cancellationListeners.push(mocks.on.mock.calls.some(([
            event,
            listener,
        ]) => (
            event === 'message' && typeof listener === 'function'
        )));
    }
});

describe('Node worker entrypoints', () => {
    it('boots every entrypoint and reports malformed startup payloads without escaping', () => {
        expect(startupMessages).toEqual(entrypoints.map(([
            , error,
        ]) => [expect.objectContaining({
            type: 'result',
            ok: false,
            error,
        })]));
        expect(cancellationListeners).toEqual([
            true,
            true,
            true,
            true,
            false,
        ]);
    });
});
