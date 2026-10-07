import {randomUUID} from 'node:crypto';
import {
    mkdtemp,
    readFile,
    writeFile,
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
import type {TOcrJobStorageBudget} from '@electron/features/ocr/pipeline/ocrJobStorageBudget';
import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';
import {createAbortError} from '@electron/utils/abort';
import {detectSourceDpiFromPageSizes} from '@electron/pdf/sourceDpiDetection';
import type {IJobBrokerRequest} from '@electron/resources/jobBroker';

const mocks = vi.hoisted(() => ({
    acquire: vi.fn(),
    runOcrCommand: vi.fn(),
    readPngDimensions: vi.fn(),
    runOcrFileBased: vi.fn(),
    persistOcrPageCheckpoint: vi.fn(),
}));

vi.mock('@electron/resources/jobBroker', () => ({mainJobBroker: {acquire: (request: IJobBrokerRequest) => mocks.acquire(request)}}));
vi.mock('@electron/features/ocr/main/ocrRuntimePolicy', () => ({getOcrRuntimePolicy: () => ({globalPageSlots: 2})}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runOcrCommand(...args)}));
vi.mock('@evb/scan-cleanup/core/rasterLayerDimensions', () => ({readPngDimensions: (path: string) => mocks.readPngDimensions(path)}));
vi.mock('@electron/features/ocr/pipeline/tesseractRunner', () => ({
    getPngDimensionsFromFile: async () => ({
        width: 2550,
        height: 3300,
    }),
    runOcrFileBased: (...args: unknown[]) => mocks.runOcrFileBased(...args),
}));
vi.mock('@electron/features/ocr/pipeline/persistOcrPageCheckpoint', () => ({persistOcrPageCheckpoint: (...args: unknown[]) => mocks.persistOcrPageCheckpoint(...args)}));

const {processOcrPages} = await import('@electron/features/ocr/pipeline/runOcrJob');

type TPageContext = Parameters<typeof processOcrPages>[2];

const storageBudget = {
    violation: null,
    assertWithinBudget: async () => ({
        availableBytes: Number.MAX_SAFE_INTEGER,
        usedBytes: 0,
    }),
    assertFailureWithinBudget: async (_message: string | undefined) => undefined,
    fail: (error: unknown): never => {
        throw error;
    },
    reserve: async bytes => ({
        bytes,
        release: () => undefined,
    }),
    reconcileCheckpoints: async () => undefined,
    commitCheckpoint: (reservations) => {
        reservations.forEach(reservation => reservation.release());
    },
    withReservation: async <T>(_bytes: number, task: () => Promise<T>) => task(),
    stop: async () => undefined,
    describe: () => ({
        checkpointDir: 'checkpoints',
        maxBytes: 0,
        minFreeBytes: 0,
        pollIntervalMs: 0,
    }),
} satisfies TOcrJobStorageBudget;

let checkpointDir: string;
const events: string[] = [];
const acquireRequests: IJobBrokerRequest[] = [];

function grantResourceSlots() {
    mocks.acquire.mockImplementation(async (request: IJobBrokerRequest) => {
        events.push('resource-acquire');
        acquireRequests.push(request);
        return {
            token: 'lease',
            resources: request.resources,
            release: () => true,
        };
    });
}

function createContext(overrides: Partial<TPageContext> = {}): TPageContext {
    return {
        jobId: randomUUID(),
        log: () => undefined,
        sessionId: 'session',
        paths: {
            tesseractBinary: '/tmp/tesseract',
            tessdataPath: '/tmp/tessdata',
            pdftoppmBinary: '/tmp/pdftoppm',
            qpdfBinary: '/tmp/qpdf',
            tempDir: checkpointDir,
        },
        getPopplerSourcePdfPath: () => join(checkpointDir, 'source.pdf'),
        preparePopplerFallback: async () => ({
            pdfPath: join(checkpointDir, 'source.pdf'),
            warnings: [],
        }),
        extractionDpi: 300,
        tesseractThreads: 1,
        pageSizeByNumber: new Map(),
        pageSourceDpiByNumber: new Map(),
        options: {},
        checkpointDir,
        checkpointPage: vi.fn(async () => undefined),
        signal: new AbortController().signal,
        storageBudget,
        trackTempFile: path => path,
        ...overrides,
    };
}

async function runSinglePage(context: TPageContext) {
    return processOcrPages([{
        pageNumber: 1,
        languages: ['eng'],
    }], 1, context);
}

describe('OCR worker page processing guards (SRCH-006)', () => {
    it('keeps page inputs when native termination is unproven', async () => {
        const inputPath = join(checkpointDir, 'session-page-1.png');
        await writeFile(inputPath, 'owned page input');
        const failure = markUnprovenNativeTermination(new Error('preprocessing timeout'), 'child still owns page input');
        mocks.runOcrCommand.mockResolvedValueOnce({
            stdout: '',
            stderr: '',
            exitCode: 0,
        }).mockRejectedValueOnce(failure);
        const base = createContext();
        const context = createContext({
            options: {preprocessingMode: 'clean'},
            paths: {
                ...base.paths,
                scanCleanupBinary: '/scan-cleanup',
            },
            pageSizeByNumber: new Map([[
                1,
                {
                    width: 8.5,
                    height: 11,
                },
            ]]),
        });
        await expect(runSinglePage(context)).rejects.toBe(failure);
        expect(await readFile(inputPath, 'utf8')).toBe('owned page input');
    });

    beforeEach(async () => {
        vi.clearAllMocks();
        events.length = 0;
        acquireRequests.length = 0;
        checkpointDir = await mkdtemp(join(tmpdir(), 'evb-ocr-page-processing-'));
        grantResourceSlots();
        mocks.runOcrCommand.mockImplementation(async (_binary: string, args: string[]) => {
            events.push(`pdftoppm:${args[args.indexOf('-r') + 1] ?? '?'}`);
            return {
                stdout: '',
                stderr: '',
                exitCode: 0,
            };
        });
        mocks.readPngDimensions.mockImplementation(async (path: string) => (path.endsWith('-size-probe.png')
            ? {
                width: 68,
                height: 88,
            }
            : {
                width: 2550,
                height: 3300,
            }));
        mocks.runOcrFileBased.mockImplementation(async () => {
            events.push('tesseract');
            return {
                success: true,
                pageData: {
                    words: [],
                    text: 'hello',
                    imageWidth: 2550,
                    imageHeight: 3300,
                },
                pdfPath: join(checkpointDir, 'page-1-ocr.pdf'),
            };
        });
        mocks.persistOcrPageCheckpoint.mockResolvedValue(undefined);
    });

    afterEach(async () => {
        await rm(checkpointDir, {
            recursive: true,
            force: true,
        });
    });

    it.each([
        {
            width: 16,
            height: 20,
        },
        {
            width: 20,
            height: 16,
        },
    ])('OCRs a safe $width by $height inch scan in a mixed-DPI batch', async ({
        width, height,
    }) => {
        const source = detectSourceDpiFromPageSizes([
            {
                pageNumber: 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: width * 72,
                heightPoints: height * 72,
                rotation: 0,
                dominantImageWidthPx: width * 150,
                dominantImageHeightPx: height * 150,
                dominantImageWidthPoints: width * 72,
                dominantImageHeightPoints: height * 72,
            },
            {
                pageNumber: 2,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 612,
                heightPoints: 792,
                rotation: 0,
                dominantImageWidthPx: 5100,
                dominantImageHeightPx: 6600,
                dominantImageWidthPoints: 612,
                dominantImageHeightPoints: 792,
            },
        ]);
        expect(source?.documentDpi).toBe(600);
        const lowDpi = (await source?.getPageRaster(1))?.dpi;
        expect(lowDpi).toBe(150);
        const result = await processOcrPages([
            {
                pageNumber: 1,
                languages: ['eng'],
            },
            {
                pageNumber: 2,
                languages: ['eng'],
            },
        ], 1, createContext({
            extractionDpi: source?.documentDpi ?? 300,
            pageSourceDpiByNumber: new Map([
                [
                    1,
                    lowDpi!,
                ],
                [
                    2,
                    600,
                ],
            ]),
            pageSizeByNumber: new Map([
                [
                    1,
                    {
                        width,
                        height,
                    },
                ],
                [
                    2,
                    {
                        width: 8.5,
                        height: 11,
                    },
                ],
            ]),
        }));

        expect(result.errors).toEqual([]);
        expect(result.successfulPageCount).toBe(2);
        expect(result.diagnostics).toEqual([expect.objectContaining({
            code: 'OCR_SOURCE_DPI_LIMITED',
            pageNumber: 1,
        })]);
        expect(events.filter(event => event.startsWith('pdftoppm:'))).toEqual([
            'pdftoppm:150',
            'pdftoppm:600',
        ]);
        expect(acquireRequests[0]?.resources.estimatedResidentBytes).toBe(7_200_000 * 4);
    });

    it.each([
        {
            label: 'high-DPI page without automatic source reduction',
            dpi: 600,
            width: 16,
            height: 20,
            sourceDpi: undefined,
        },
        {
            label: 'unsafe scan even at its source DPI',
            dpi: 600,
            width: 60,
            height: 60,
            sourceDpi: 150,
        },
    ])('refuses $label before rendering', async ({
        dpi, width, height, sourceDpi,
    }) => {
        const result = await runSinglePage(createContext({
            extractionDpi: dpi,
            pageSizeByNumber: new Map([[
                1,
                {
                    width,
                    height,
                },
            ]]),
            pageSourceDpiByNumber: sourceDpi === undefined ? new Map() : new Map([[
                1,
                sourceDpi,
            ]]),
        }));
        expect(result.successfulPageCount).toBe(0);
        expect(result.errors).toEqual([expect.stringContaining('rendered pixels; maximum is 45000000')]);
        expect(mocks.runOcrCommand).not.toHaveBeenCalled();
        expect(mocks.runOcrFileBased).not.toHaveBeenCalled();
    });

    it('refuses an oversize page from its known size before pdftoppm is spawned', async () => {
        const result = await runSinglePage(createContext({pageSizeByNumber: new Map([[
            1,
            {
                width: 200,
                height: 200,
            },
        ]])}));

        expect(result.successfulPageCount).toBe(0);
        expect(result.errors).toEqual([expect.stringContaining('rendered pixels; maximum is')]);
        expect(mocks.runOcrCommand).not.toHaveBeenCalled();
        expect(mocks.runOcrFileBased).not.toHaveBeenCalled();
    });

    it('probes the page size at low resolution before admission when the native probe is degraded', async () => {
        const result = await runSinglePage(createContext());

        expect(result.successfulPageCount).toBe(1);
        expect(events).toEqual([
            'pdftoppm:8',
            'resource-acquire',
            'pdftoppm:300',
            'tesseract',
        ]);
        // The lease holds the raster of a letter page at 300 DPI.
        expect(acquireRequests[0]?.resources.estimatedResidentBytes).toBe(2_550 * 3_300 * 4);
    });

    it('never renders once the job is cancelled while waiting for a resource slot', async () => {
        const controller = new AbortController();
        mocks.acquire.mockImplementation(async (request: IJobBrokerRequest) => {
            controller.abort();
            return {
                token: 'lease',
                resources: request.resources,
                release: () => true,
            };
        });

        await expect(runSinglePage(createContext({
            pageSizeByNumber: new Map([[
                1,
                {
                    width: 8.5,
                    height: 11,
                },
            ]]),
            signal: controller.signal,
        }))).rejects.toMatchObject({name: 'AbortError'});
        expect(mocks.runOcrCommand).not.toHaveBeenCalled();
    });

    it('commits nothing after a cancellation that lands during rendering', async () => {
        const controller = new AbortController();
        const checkpointPage = vi.fn(async () => undefined);
        mocks.runOcrCommand.mockImplementation(async () => {
            controller.abort();
            throw createAbortError();
        });

        await expect(runSinglePage(createContext({
            pageSizeByNumber: new Map([[
                1,
                {
                    width: 8.5,
                    height: 11,
                },
            ]]),
            signal: controller.signal,
            checkpointPage,
        }))).rejects.toMatchObject({name: 'AbortError'});
        expect(mocks.runOcrCommand).toHaveBeenCalledTimes(1);
        expect(mocks.runOcrFileBased).not.toHaveBeenCalled();
        expect(mocks.persistOcrPageCheckpoint).not.toHaveBeenCalled();
        expect(checkpointPage).not.toHaveBeenCalled();
    });
});
