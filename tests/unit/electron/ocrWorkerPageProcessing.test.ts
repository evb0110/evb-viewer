import {randomUUID} from 'node:crypto';
import {
    mkdtemp,
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
import type {TOcrJobStorageBudget} from '@electron/features/ocr/worker/ocrJobStorageBudget';
import {createAbortError} from '@electron/utils/abort';
import {requireJobId} from '@contracts/shared';

interface IResourceAcquireMessage {
    type: string;
    jobId: string;
    requestId: string;
    requestedDpi: number;
    pageWidthIn?: number;
    pageHeightIn?: number;
}

const mocks = vi.hoisted(() => ({
    messageListeners: [] as Array<(message: unknown) => void>,
    postMessage: vi.fn(),
    workerData: {
        tesseractBinary: '/tmp/tesseract',
        tessdataPath: '/tmp/tessdata',
        pdftoppmBinary: '/tmp/pdftoppm',
        qpdfBinary: '/tmp/qpdf',
        tempDir: '/tmp',
    },
    runOcrCommand: vi.fn(),
    readPngDimensions: vi.fn(),
    runOcrFileBased: vi.fn(),
    persistOcrPageCheckpoint: vi.fn(),
}));

vi.mock('worker_threads', () => ({
    parentPort: {
        close: vi.fn(),
        on: (event: string, listener: (message: unknown) => void) => {
            if (event === 'message') {
                mocks.messageListeners.push(listener);
            }
        },
        off: vi.fn(),
        postMessage: (message: unknown) => mocks.postMessage(message),
    },
    workerData: mocks.workerData,
}));
vi.mock('@electron/features/ocr/worker/runOcrCommand', () => ({runOcrCommand: (...args: unknown[]) => mocks.runOcrCommand(...args)}));
vi.mock('@evb/scan-cleanup/core/rasterLayerDimensions', () => ({readPngDimensions: (path: string) => mocks.readPngDimensions(path)}));
vi.mock('@electron/features/ocr/worker/tesseractRunner', () => ({
    getPngDimensionsFromFile: async () => ({
        width: 2550,
        height: 3300,
    }),
    runOcrFileBased: (...args: unknown[]) => mocks.runOcrFileBased(...args),
}));
vi.mock('@electron/features/ocr/worker/persistOcrPageCheckpoint', () => ({persistOcrPageCheckpoint: (...args: unknown[]) => mocks.persistOcrPageCheckpoint(...args)}));

const {processOcrPages} = await import('@electron/ocr/worker/main');

type TPageContext = Parameters<typeof processOcrPages>[3];

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
    reserve: async () => () => undefined,
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
const acquireRequests: IResourceAcquireMessage[] = [];

function dispatchToWorker(message: unknown) {
    for (const listener of mocks.messageListeners) {
        listener(message);
    }
}

function grantResourceSlots() {
    mocks.postMessage.mockImplementation((message: IResourceAcquireMessage) => {
        if (message.type !== 'resource-acquire') {
            return;
        }
        events.push('resource-acquire');
        acquireRequests.push(message);
        queueMicrotask(() => dispatchToWorker({
            type: 'resource-acquired',
            jobId: message.jobId,
            requestId: message.requestId,
            token: `token-${message.requestId}`,
            effectiveDpi: message.requestedDpi,
        }));
    });
}

function createContext(overrides: Partial<TPageContext> = {}): TPageContext {
    return {
        jobId: requireJobId(randomUUID()),
        sessionId: 'session',
        popplerSourcePdfPath: join(checkpointDir, 'source.pdf'),
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
    return processOcrPages(context.jobId, [{
        pageNumber: 1,
        languages: ['eng'],
    }], 1, context);
}

describe('OCR worker page processing guards (SRCH-006)', () => {
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

    it('rejects an oversize page from its known size before pdftoppm is spawned', async () => {
        const result = await runSinglePage(createContext({pageSizeByNumber: new Map([[
            1,
            {
                width: 200,
                height: 200,
            },
        ]])}));

        expect(result.successfulPageCount).toBe(0);
        expect(result.errors).toEqual([expect.stringContaining('exceeds limits')]);
        expect(mocks.runOcrCommand).not.toHaveBeenCalled();
        expect(mocks.runOcrFileBased).not.toHaveBeenCalled();
    });

    it('returns unproven Tesseract termination as a fatal page result', async () => {
        const detail = 'Tesseract process tree for page-1.png was not proven dead';
        const retainedFiles: string[] = [];
        mocks.runOcrFileBased.mockResolvedValueOnce({
            success: false,
            pageData: null,
            pdfPath: null,
            error: 'Tesseract aborted',
            terminationUnproven: detail,
        });

        const result = await runSinglePage(createContext({retainTempFile: path => retainedFiles.push(path)}));

        expect(result.errors).toEqual(['Page 1: Tesseract aborted']);
        expect(result.terminationUnproven).toEqual({
            pageNumber: 1,
            detail,
        });
        expect(result.successfulPageCount).toBe(0);
        expect(retainedFiles).toEqual(expect.arrayContaining([
            expect.stringContaining('session-page-1.png'),
            expect.stringContaining('session-page-1-ocr.tsv'),
            expect.stringContaining('session-page-1-ocr.pdf'),
        ]));
        expect(mocks.postMessage.mock.calls.some(([message]) => (
            typeof message === 'object'
            && message !== null
            && (message as {type?: unknown}).type === 'resource-release'
        ))).toBe(false);
    });

    it('does not start another page after an unproven termination', async () => {
        mocks.runOcrFileBased.mockResolvedValueOnce({
            success: false,
            pageData: null,
            pdfPath: null,
            error: 'Tesseract aborted',
            terminationUnproven: 'Tesseract process tree was not proven dead',
        });

        const context = createContext();
        const result = await processOcrPages(context.jobId, [
            {
                pageNumber: 1,
                languages: ['eng'],
            },
            {
                pageNumber: 2,
                languages: ['eng'],
            },
        ], 1, context);

        expect(mocks.runOcrFileBased).toHaveBeenCalledTimes(1);
        expect(result.terminationUnproven?.pageNumber).toBe(1);
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
        expect(acquireRequests[0]).toMatchObject({
            pageWidthIn: 8.5,
            pageHeightIn: 11,
        });
    });

    it('never renders once the job is cancelled while waiting for a resource slot', async () => {
        const controller = new AbortController();
        mocks.postMessage.mockImplementation((message: IResourceAcquireMessage) => {
            if (message.type === 'resource-acquire') {
                controller.abort();
            }
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
