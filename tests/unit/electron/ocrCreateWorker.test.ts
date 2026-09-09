import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    existsSync: vi.fn(() => true),
    workerCtor: vi.fn(),
}));

vi.mock('electron', () => ({app: {isPackaged: false}}));
vi.mock('fs', () => ({existsSync: mocks.existsSync}));
vi.mock('worker_threads', () => {
    function MockWorker(workerPath: string, options: unknown) {
        mocks.workerCtor(workerPath, options);
    }
    return {Worker: MockWorker};
});
vi.mock('@electron/features/ocr/main/paths', () => ({getOcrToolPaths: () => ({
    tesseract: '/tools/tesseract',
    tessdata: '/tools/tessdata',
    pdftoppm: '/tools/pdftoppm',
    pdftotext: '/tools/pdftotext',
    pdfimages: '/tools/pdfimages',
    popplerDataDir: '/tools/poppler-data',
    popplerFontConfigDir: '/tools/fontconfig',
    qpdf: '/tools/qpdf',
    unpaper: '/tools/unpaper',
})}));
vi.mock('@electron/features/page-ops/public', () => ({resolveNativePageOpsPath: () => '/tools/evb-pdf-page-ops'}));
vi.mock('@electron/utils/appTempDir', () => ({getAppTempDir: () => '/tmp/evb-viewer'}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

const { createOcrWorker } = await import('@electron/features/ocr/main/createOcrWorker.worker');

describe('createOcrWorker', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.existsSync.mockReturnValue(true);
    });

    it('starts OCR workers with conservative resource limits', () => {
        createOcrWorker();

        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        const workerOptions = mocks.workerCtor.mock.calls[0]?.[1] as {
            resourceLimits?: {
                maxOldGenerationSizeMb?: number;
                maxYoungGenerationSizeMb?: number;
                stackSizeMb?: number;
            };
            workerData?: Record<string, unknown>;
        };
        expect(workerOptions.workerData).toMatchObject({
            tesseractBinary: '/tools/tesseract',
            pdfPageOpsBinary: '/tools/evb-pdf-page-ops',
            tempDir: '/tmp/evb-viewer',
        });
        expect(workerOptions.resourceLimits).toMatchObject({
            maxOldGenerationSizeMb: 768,
            maxYoungGenerationSizeMb: 64,
            stackSizeMb: 8,
        });
    });
});
