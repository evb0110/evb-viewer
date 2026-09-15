import {
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
vi.mock('@electron/image/pdfCombineShared', () => ({createCombinedPdf: vi.fn(async () => {
    throw new Error('malformed combine input');
})}));

describe('Node worker entrypoints', () => {
    it('boots every entrypoint and reports malformed startup payloads without escaping', async () => {
        await import('@electron/features/djvu/main/pdfWorker');
        await import('@electron/features/documents/main/pdfConformanceWorker');
        await import('@electron/features/image-export/main/tiffCombineWorker');
        await import('@electron/features/page-ops/main/cropWorker');
        await import('@electron/image/pdfCombineWorker');
        await import('@electron/features/ocr/worker/main');

        expect(mocks.postMessage).toHaveBeenCalled();
        expect(mocks.postMessage.mock.calls.some(call => call[0]?.type === 'result' && call[0]?.ok === false)).toBe(true);
        expect(mocks.on).toHaveBeenCalledWith('message', expect.any(Function));
    });
});
