import {EventEmitter} from 'node:events';
import {
    mkdtemp,
    rm,
    truncate,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOcrEnginePool} from '@electron/features/ocr/main/ocrEnginePool';
import {JobBroker} from '@electron/resources/jobBroker';
import type { TRegisteredHandler } from '@tests/unit/electron/helpers/ipcRegistryHarness';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import { OCR_PLATFORM_FEATURE } from '@contracts/ocrPlatformFeature';
import { AVAILABLE_OCR_LANGUAGE_CODES } from '@contracts/ocrLanguages';
import {
    cancelMainOperationsForClosingWorkingCopy,
    resetMainOperationLifecycleForTests,
    snapshotCancellableWorkingCopyDependents,
    snapshotMainOperations,
} from '@electron/operation-lifecycle/mainOperationLifecycle';
import { registerPlatformFeatureHandlers } from '@electron/platform-ipc/validatedIpcRegistrar';

const mocks = vi.hoisted(() => ({
    handlers: new Map<string, TRegisteredHandler>(),
    handleOcrCreateSearchablePdfAsync: vi.fn(),
    handleOcrCancel: vi.fn(),
    handleOcrAcknowledgeResultFile: vi.fn(),
    getWorkingCopyBackingEntry: vi.fn(),
    readDocumentTextSnapshot: vi.fn(),
    readDocumentTextWindow: vi.fn(),
    resolveAllowedReadPath: vi.fn<(path: string) => Promise<string | null>>(),
    runWithWorkingCopyReadBacking: vi.fn(),
    ensureWorkingCopyMaterialized: vi.fn(),
    requireManagedWorkingCopyPath: vi.fn<(path: string) => Promise<string>>(),
    resolveAllowedWritePath: vi.fn<(path: string) => Promise<string | null>>(),
}));

vi.mock('electron', () => ({
    app: { isPackaged: false },
    BrowserWindow: { fromWebContents: vi.fn(() => null) },
    ipcMain: { handle: vi.fn() },
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

vi.mock('@electron/utils/pathValidator', () => ({
    resolveAllowedReadPath: mocks.resolveAllowedReadPath,
    resolveAllowedWritePath: mocks.resolveAllowedWritePath,
}));
vi.mock('@electron/file-access/documentStore', async () => {
    class WorkingCopyMaterializationError extends Error {
        readonly code: string;
        readonly retryable: boolean;

        constructor(code: string, message: string, options: {retryable?: boolean} = {}) {
            super(message);
            this.name = 'WorkingCopyMaterializationError';
            this.code = code;
            this.retryable = options.retryable ?? false;
        }
    }
    return {
        ...await vi.importActual<Record<string, unknown>>('@electron/file-access/documentStore'),
        requireManagedWorkingCopyPath: (path: string) => mocks.requireManagedWorkingCopyPath(path),
        getWorkingCopyBackingEntry: mocks.getWorkingCopyBackingEntry,
        runWithWorkingCopyReadBacking: (...args: unknown[]) => mocks.runWithWorkingCopyReadBacking(...args),
        ensureWorkingCopyMaterialized: (...args: unknown[]) => mocks.ensureWorkingCopyMaterialized(...args),
        WorkingCopyMaterializationError,
    };
});

vi.mock('@electron/features/ocr/main/jobManager', () => ({
    handleOcrCreateSearchablePdfAsync: mocks.handleOcrCreateSearchablePdfAsync,
    handleOcrCancel: mocks.handleOcrCancel,
    handleOcrAcknowledgeResultFile: mocks.handleOcrAcknowledgeResultFile,
    subscribeManagedOcrProgress: vi.fn(),
}));
vi.mock('@electron/features/ocr/main/documentText', () => ({
    readDocumentTextSnapshot: (...args: unknown[]) => mocks.readDocumentTextSnapshot(...args),
    readDocumentTextWindow: (...args: unknown[]) => mocks.readDocumentTextWindow(...args),
}));

const { ocrMainBindings } = await import('@electron/features/ocr/mainBindings');

function registerOcrFeatureHandlers() {
    const registrar: Parameters<typeof registerPlatformFeatureHandlers>[0] = {handle: (channel, handler) => {
        mocks.handlers.set(channel, (...args: unknown[]) => Reflect.apply(handler, undefined, args));
    }};
    registerPlatformFeatureHandlers(
        registrar,
        OCR_PLATFORM_FEATURE,
        ocrMainBindings,
    );
}

function createMockSender(id: number) {
    return {
        id,
        isDestroyed: vi.fn(() => false),
        once: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
    };
}

function getHandler(channel: string) {
    const handler = mocks.handlers.get(channel);
    if (!handler) {
        throw new Error(`IPC handler is not registered for channel "${channel}"`);
    }
    return handler;
}

describe('OCR platform feature main bindings', () => {
    beforeEach(() => {
        mocks.handlers.clear();
        vi.clearAllMocks();
        resetMainOperationLifecycleForTests();
        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/working-copy.pdf');
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/working-copy.pdf');
        mocks.getWorkingCopyBackingEntry.mockReturnValue(null);
        mocks.runWithWorkingCopyReadBacking.mockImplementation(async (
            _logicalPath: string,
            operation: (physicalPath: string) => Promise<unknown>,
        ) => operation('/Users/alice/Documents/source.pdf'));
        mocks.ensureWorkingCopyMaterialized.mockImplementation(async (path: string) => ({
            logicalRef: path,
            physicalWorkingCopyPath: path,
            sourceFingerprint: '',
        }));
        mocks.requireManagedWorkingCopyPath.mockImplementation(async (path: string) => path);

        mocks.handleOcrCreateSearchablePdfAsync.mockResolvedValue({
            started: true,
            jobId: 'default-job-id',
        });
        mocks.handleOcrCancel.mockReturnValue({ canceled: true });
        mocks.handleOcrAcknowledgeResultFile.mockResolvedValue({ cleaned: true });
        mocks.readDocumentTextSnapshot.mockResolvedValue({pages: []});
        mocks.readDocumentTextWindow.mockResolvedValue({pages: []});
        registerOcrFeatureHandlers();
    });

    it('keeps lazy OCR catalog reads on the logical path while using its physical backing', async () => {
        const logicalPath = '/tmp/evb-working-copy/lazy.pdf';
        const physicalPath = '/Users/alice/Documents/source.pdf';
        const revision = 'ocr-revision';
        mocks.requireManagedWorkingCopyPath.mockResolvedValue(logicalPath);
        mocks.getWorkingCopyBackingEntry.mockReturnValue({backingState: 'lazy-original'});
        mocks.runWithWorkingCopyReadBacking.mockImplementation(async (
            logicalRef: string,
            operation: (physicalReadPath: string) => Promise<unknown>,
            options: {ownerWebContentsId?: number},
        ) => {
            expect(logicalRef).toBe(logicalPath);
            expect(options).toEqual({ownerWebContentsId: 31});
            return operation(physicalPath);
        });

        const snapshotHandler = getHandler('ocr:resolveDocumentTextCatalog');
        await snapshotHandler(
            {sender: createMockSender(31)},
            logicalPath,
            revision,
            1,
        );

        expect(mocks.resolveAllowedReadPath).not.toHaveBeenCalled();
        expect(mocks.resolveAllowedWritePath).toHaveBeenCalledWith(logicalPath);
        expect(mocks.readDocumentTextSnapshot).toHaveBeenCalledWith(
            logicalPath,
            physicalPath,
            revision,
            1,
            expect.any(AbortSignal),
        );
    });

    it('cancels a renderer-owned scalar catalog read through the OCR request id', async () => {
        const logicalPath = '/tmp/working-copy.pdf';
        const requestId = 'docx-export-catalog-1';
        let releaseRead: (() => void) | undefined;
        const readGate = new Promise<void>(resolve => {
            releaseRead = resolve;
        });
        mocks.handleOcrCancel.mockReturnValue({
            canceled: false,
            reason: 'not-found',
        });
        mocks.readDocumentTextSnapshot.mockImplementationOnce(async (...args: unknown[]) => {
            const signal = args[4] as AbortSignal;
            await readGate;
            signal.throwIfAborted();
            return {pages: []};
        });

        const readPromise = getHandler('ocr:resolveDocumentTextCatalog')(
            {sender: createMockSender(43)},
            logicalPath,
            'ocr-revision',
            1,
            requestId,
        );
        await vi.waitFor(() => expect(mocks.readDocumentTextSnapshot).toHaveBeenCalledTimes(1));

        expect(getHandler('ocr:cancel')(
            {sender: createMockSender(43)},
            requestId,
        )).toMatchObject({canceled: true});
        const signal = mocks.readDocumentTextSnapshot.mock.calls[0]?.[4] as AbortSignal;
        expect(signal.aborted).toBe(true);

        releaseRead?.();
        await expect(readPromise).rejects.toMatchObject({name: 'AbortError'});
    });

    it('cancels a renderer-owned window catalog read through the OCR request id', async () => {
        const logicalPath = '/tmp/working-copy.pdf';
        const requestId = 'docx-export-window-catalog-1';
        let releaseRead: (() => void) | undefined;
        const readGate = new Promise<void>(resolve => {
            releaseRead = resolve;
        });
        mocks.handleOcrCancel.mockReturnValue({
            canceled: false,
            reason: 'not-found',
        });
        mocks.readDocumentTextWindow.mockImplementationOnce(async (...args: unknown[]) => {
            const signal = args[4] as AbortSignal;
            await readGate;
            signal.throwIfAborted();
            return {pages: []};
        });

        const readPromise = getHandler('ocr:resolveDocumentTextCatalogWindow')(
            {sender: createMockSender(44)},
            logicalPath,
            'ocr-revision',
            1,
            64,
            100_001,
            requestId,
        );
        await vi.waitFor(() => expect(mocks.readDocumentTextWindow).toHaveBeenCalledTimes(1));

        expect(getHandler('ocr:cancel')(
            {sender: createMockSender(44)},
            requestId,
        )).toMatchObject({canceled: true});
        const signal = mocks.readDocumentTextWindow.mock.calls[0]?.[4] as AbortSignal;
        expect(signal.aborted).toBe(true);

        releaseRead?.();
        await expect(readPromise).rejects.toMatchObject({name: 'AbortError'});
    });

    it('cancels a searchable PDF while its working copy is still preparing, before any OCR job starts', async () => {
        mocks.ensureWorkingCopyMaterialized.mockImplementationOnce((_path: string, options: {signal: AbortSignal}) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('Working-copy materialization was cancelled')), {once: true});
        }));
        mocks.handleOcrCancel.mockReturnValue({
            canceled: false,
            reason: 'not-found',
        });

        const startPromise = getHandler('ocr:createSearchablePdf')(
            {sender: createMockSender(51)},
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'ocr-cancel-while-preparing',
        );
        await vi.waitFor(() => expect(mocks.ensureWorkingCopyMaterialized).toHaveBeenCalledTimes(1));

        expect(getHandler('ocr:cancel')(
            {sender: createMockSender(51)},
            'ocr-cancel-while-preparing',
        )).toMatchObject({canceled: true});
        await expect(startPromise).resolves.toMatchObject({started: false});
        expect(mocks.handleOcrCreateSearchablePdfAsync).not.toHaveBeenCalled();
    });

    it('rejects unmanaged OCR catalog paths', async () => {
        mocks.requireManagedWorkingCopyPath.mockRejectedValue(new Error('not managed'));

        const handler = getHandler('ocr:resolveDocumentTextCatalog');
        await expect(handler(
            {sender: createMockSender(32)},
            '/Users/alice/Documents/unmanaged.pdf',
            'ocr-revision',
            1,
        )).rejects.toThrow('sourcePdfPath is not a managed working copy: not managed');
        expect(mocks.runWithWorkingCopyReadBacking).not.toHaveBeenCalled();
        expect(mocks.readDocumentTextSnapshot).not.toHaveBeenCalled();
    });

    it('marks timeout start failures as typed retriable errors', async () => {
        mocks.handleOcrCreateSearchablePdfAsync.mockResolvedValue({
            started: false,
            jobId: 'job-timeout',
            error: 'qpdf timed out after 5000ms',
        });

        const handler = getHandler('ocr:createSearchablePdf');
        const result = await handler(
            {sender: createMockSender(12)},
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-timeout',
        ) as {
            started: boolean;
            errorEnvelope?: {
                code: string;
                retryable: boolean;
            };
        };

        expect(result.started).toBe(false);
        expect(result.errorEnvelope).toMatchObject({
            code: 'OCR_INTERNAL_ERROR',
            retryable: true,
        });
    });

    it('uses the typed start-failure code instead of reparsing the message', async () => {
        mocks.handleOcrCreateSearchablePdfAsync.mockResolvedValue({
            started: false,
            jobId: 'job-duplicate',
            error: 'OCR job with id "job-duplicate" already exists',
            errorCode: 'OCR_QUEUE_BACKPRESSURE',
        });

        const handler = getHandler('ocr:createSearchablePdf');
        const result = await handler(
            {sender: createMockSender(14)},
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-duplicate',
        ) as {
            started: boolean;
            errorCode?: string;
            errorEnvelope?: {
                code: string;
                retryable: boolean;
            };
        };

        expect(result.started).toBe(false);
        expect(result.errorCode).toBeUndefined();
        expect(result.errorEnvelope).toMatchObject({
            code: 'OCR_QUEUE_BACKPRESSURE',
            retryable: true,
        });
    });

    it('normalizes searchable PDF OCR options before queuing the worker job', async () => {
        const handler = getHandler('ocr:createSearchablePdf');
        const result = await handler(
            {sender: createMockSender(16)},
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-options',
            {
                renderDpi: 299.6,
                qualityProfile: 'poor-scan',
                preprocessingMode: 'clean',
                pageSegmentationMode: 11,
            },
        ) as { started: boolean };

        expect(result.started).toBe(true);
        expect(mocks.handleOcrCreateSearchablePdfAsync).toHaveBeenCalledWith(
            expect.anything(),
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-options',
            {
                renderDpi: 300,
                qualityProfile: 'poor-scan',
                preprocessingMode: 'clean',
                pageSegmentationMode: 11,
            },
            expect.any(AbortSignal),
        );
    });

    it('preserves legacy numeric render DPI for searchable PDF jobs', async () => {
        const handler = getHandler('ocr:createSearchablePdf');
        await handler(
            {sender: createMockSender(17)},
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-legacy-dpi',
            240,
        );

        expect(mocks.handleOcrCreateSearchablePdfAsync).toHaveBeenCalledWith(
            expect.anything(),
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-legacy-dpi',
            { renderDpi: 240 },
            expect.any(AbortSignal),
        );
    });

    it('rejects invalid searchable PDF OCR options before queuing the worker job', async () => {
        const handler = getHandler('ocr:createSearchablePdf');
        const result = await handler(
            {sender: createMockSender(18)},
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-invalid-options',
            { pageSegmentationMode: 99 },
        ) as {
            started: boolean;
            error?: string;
            errorEnvelope?: {
                code: string;
                retryable: boolean;
            };
        };

        expect(result.started).toBe(false);
        expect(result.error).toContain('pageSegmentationMode');
        expect(result.errorEnvelope).toMatchObject({
            code: 'OCR_INVALID_PAYLOAD',
            retryable: false,
        });
        expect(mocks.handleOcrCreateSearchablePdfAsync).not.toHaveBeenCalled();
    });

    it('rejects multilingual OCR requests, including per-page language overrides', async () => {
        const handler = getHandler('ocr:createSearchablePdf');
        const multiLanguageResult = await handler(
            {sender: createMockSender(21)},
            '/tmp/working-copy.pdf',
            {
                kind: 'all',
                pageCount: 2,
                languages: [
                    'eng',
                    'rus',
                ],
            },
            'job-multiple-languages',
        ) as {
            started: boolean;
            error: string;
            errorEnvelope?: {
                code: string;
                retryable: boolean;
            };
        };

        expect(multiLanguageResult).toMatchObject({
            started: false,
            errorEnvelope: {
                code: 'OCR_INVALID_PAYLOAD',
                retryable: false,
            },
        });

        const mixedPageResult = await handler(
            {sender: createMockSender(22)},
            '/tmp/working-copy.pdf',
            [
                {
                    pageNumber: 1,
                    languages: ['eng'],
                },
                {
                    pageNumber: 2,
                    languages: ['rus'],
                },
            ],
            'job-mixed-page-languages',
        ) as {
            started: boolean;
            errorEnvelope?: {
                code: string;
                retryable: boolean;
            };
        };

        expect(mixedPageResult).toMatchObject({
            started: false,
            errorEnvelope: {
                code: 'OCR_INVALID_PAYLOAD',
                retryable: false,
            },
        });
        await expect(handler(
            {sender: createMockSender(23)},
            '/tmp/working-copy.pdf',
            {
                kind: 'all',
                pageCount: 1,
                languages: [...AVAILABLE_OCR_LANGUAGE_CODES],
            },
            'job-all-supported-languages',
        )).resolves.toMatchObject({
            started: false,
            errorEnvelope: {
                code: 'OCR_INVALID_PAYLOAD',
                retryable: false,
            },
        });
        expect(mocks.handleOcrCreateSearchablePdfAsync).not.toHaveBeenCalled();
    });

    it('rejects disallowed sourcePdfPath before queuing OCR worker job', async () => {
        mocks.ensureWorkingCopyMaterialized.mockRejectedValue(new Error('sourcePdfPath is not a managed working copy'));

        const handler = getHandler('ocr:createSearchablePdf');
        const result = await handler(
            {sender: createMockSender(14)},
            '/tmp/outside.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-invalid-working-copy-path',
        ) as {
            started: boolean;
            errorEnvelope?: {
                code: string;
                retryable: boolean;
            };
            error?: string;
        };

        expect(result.started).toBe(false);
        expect(result.error).toContain('sourcePdfPath');
        expect(result.errorEnvelope).toMatchObject({
            code: 'OCR_INVALID_PAYLOAD',
            retryable: false,
        });
        expect(mocks.handleOcrCreateSearchablePdfAsync).not.toHaveBeenCalled();
    });

    it('does not expose stack details in generic searchable PDF failures', async () => {
        mocks.handleOcrCreateSearchablePdfAsync.mockRejectedValue(new Error('worker exploded with a private stack'));

        const handler = getHandler('ocr:createSearchablePdf');
        const result = await handler(
            {sender: createMockSender(19)},
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-generic-failure',
        ) as {
            started: boolean;
            errorEnvelope?: {
                code: string;
                message: string;
                details?: {
                    timestamp: number;
                    details?: string;
                };
            };
        };

        expect(result.started).toBe(false);
        expect(result.errorEnvelope).toMatchObject({
            code: 'OCR_INTERNAL_ERROR',
            message: 'worker exploded with a private stack',
        });
        expect(result.errorEnvelope?.details?.details).toBeUndefined();
    });

    it('returns typed invalid-request details for malformed OCR cancel payloads', async () => {
        const handler = getHandler('ocr:cancel');

        const result = await handler(
            {sender: createMockSender(20)},
            '',
        ) as {
            canceled: boolean;
            reason?: string;
            error?: string;
            errorEnvelope?: {
                code: string;
                retryable: boolean;
            };
        };

        expect(result).toMatchObject({
            canceled: false,
            reason: 'invalid-request',
            errorEnvelope: {
                code: 'OCR_INVALID_PAYLOAD',
                retryable: false,
            },
        });
        expect(result.error).toContain('requestId');
        expect(mocks.handleOcrCancel).not.toHaveBeenCalled();
    });

    it.each([
        {
            channel: 'ocr:resolveDocumentTextCatalog',
            resolver: 'readDocumentTextSnapshot',
            args: [1],
        },
        {
            channel: 'ocr:resolveDocumentTextCatalogWindow',
            resolver: 'readDocumentTextWindow',
            args: [
                1,
                1,
                1,
            ],
        },
    ] as const)('aborts $channel when its working copy closes mid-read (SRCH-006)', async ({
        channel,
        resolver,
        args,
    }) => {
        const logicalPath = '/tmp/working-copy.pdf';
        let observedSignal: AbortSignal | undefined;
        mocks[resolver].mockImplementation(async (...resolverArgs: unknown[]) => {
            observedSignal = resolverArgs[4] as AbortSignal | undefined;
            expect(snapshotCancellableWorkingCopyDependents(logicalPath)).toHaveLength(1);
            expect(cancelMainOperationsForClosingWorkingCopy(
                logicalPath,
                'working copy closed',
                {isRegistrationCurrent: () => true},
            )).toHaveLength(1);
            observedSignal?.throwIfAborted();
            return {pages: []};
        });

        await expect(getHandler(channel)(
            {sender: createMockSender(41)},
            logicalPath,
            'ocr-revision',
            ...args,
        )).rejects.toThrow('working copy closed');
        expect(observedSignal?.aborted).toBe(true);
        expect(snapshotMainOperations()).toEqual([]);
    });
});

const boundary = vi.hoisted(() => ({
    workers: [] as Array<{
        emit: (event: string, ...args: unknown[]) => boolean;
        dead: boolean;
        terminatedAfterDeath: boolean;
    }>,
    // Hold a pass's reply, or a worker's exit after terminate, until resolved.
    replyGate: undefined as Promise<void> | undefined,
    terminateGate: undefined as Promise<void> | undefined,
    constructorError: undefined as (() => Error | undefined) | undefined,
}));

vi.mock('node:worker_threads', () => ({Worker: class extends EventEmitter {
    dead = false;
    terminatedAfterDeath = false;
    constructor() {
        super();
        const error = boundary.constructorError?.();
        if (error) throw error;
        boundary.workers.push(this);
    }
    unref() {}
    postMessage({id}: {id: number}) {
        // As in Node, a message to an exited worker is dropped without an error.
        if (this.dead) return;
        void Promise.resolve(boundary.replyGate).then(() => this.emit('message', {id, ok: true, result: {passes: []}}));
    }
    async terminate() {
        await boundary.terminateGate;
        if (this.dead) this.terminatedAfterDeath = true;
        this.dead = true;
        this.emit('exit', 0);
        return 0;
    }
}}));

const MIB = 1024 ** 2;
const POOL_CAPACITY = {
    cpuTokens: 4,
    estimatedResidentBytes: 1024 * MIB,
    nativeProcesses: 4,
    ioWeight: 4,
};
// A one-byte page without a PNM header counts as one pixel.
const PAGE_HEAP_BYTES = 192 * MIB + 12;
const ENGINE_PASSES = [{args: ['page.ppm', 'out'], outputs: ['/work/out.txt']}];

describe('OCR engine pool idle shutdown', () => {
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        boundary.workers.length = 0;
        boundary.replyGate = undefined;
        boundary.terminateGate = undefined;
        boundary.constructorError = undefined;
    });

    it.each(['terminate', 'worker exit'] as const)('releases the idle timer after %s', async (end) => {
        vi.useFakeTimers();
        const pool = createOcrEnginePool({
            size: () => 1,
            workerPath: '/unused/ocr-engine.mjs',
            workerData: {engineDir: '/unused/engine', tessdataDir: '/unused/models'},
            broker: new JobBroker(POOL_CAPACITY),
        });
        await expect(pool.run({
            image: new Uint8Array([0]), models: ['eng'],
            passes: [{args: ['page.ppm', 'out'], outputs: ['/work/out.txt']}],
        }, new AbortController().signal)).resolves.toEqual({passes: []});
        expect(vi.getTimerCount()).toBe(1);
        const worker = boundary.workers[0]!;
        if (end === 'terminate') pool.terminate();
        else {
            worker.dead = true;
            worker.emit('exit', 0);
        }
        try {
            // A timer holding a dead worker must be released immediately.
            expect.soft(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(worker.terminatedAfterDeath).toBe(false);
        } finally {
            pool.terminate();
        }
    });

    async function createTessdata(modelBytes: number, otherModels: Record<string, number> = {}) {
        const dir = await mkdtemp(join(tmpdir(), 'ocr-pool-models-'));
        onTestFinished(() => rm(dir, {
            recursive: true,
            force: true,
        }));
        for (const [code, bytes] of Object.entries({
            eng: modelBytes,
            ...otherModels,
        })) {
            const model = join(dir, `${code}.traineddata`);
            await writeFile(model, '');
            await truncate(model, bytes);
        }
        return dir;
    }

    it('charges a warm worker its largest pass, a core only while it runs, until it has exited', async () => {
        const broker = new JobBroker(POOL_CAPACITY);
        const pool = createOcrEnginePool({
            size: () => 1,
            workerPath: '/unused/ocr-engine.mjs',
            workerData: {engineDir: '/unused/engine', tessdataDir: await createTessdata(40 * MIB)},
            broker,
        });
        const largest = 2.5 * 40 * MIB + PAGE_HEAP_BYTES;

        await pool.run({image: new Uint8Array([0]), models: ['eng'], passes: ENGINE_PASSES}, new AbortController().signal);
        // Idle and warm: its memory stays charged, its core does not.
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            used: {cpuTokens: 0, estimatedResidentBytes: largest},
        });

        // A pass loading fewer models still runs in the memory the worker holds.
        const reply = Promise.withResolvers<void>();
        boundary.replyGate = reply.promise;
        const smaller = pool.run({image: new Uint8Array([0]), models: ['fra'], passes: ENGINE_PASSES}, new AbortController().signal);
        await vi.waitFor(() => expect(broker.getSnapshot().used).toMatchObject({
            cpuTokens: 1,
            estimatedResidentBytes: largest,
        }));
        reply.resolve();
        await smaller;
        expect(broker.getSnapshot().used).toMatchObject({cpuTokens: 0, estimatedResidentBytes: largest});

        const exited = Promise.withResolvers<void>();
        boundary.terminateGate = exited.promise;
        pool.terminate();
        await new Promise(resolve => setImmediate(resolve));
        // Asked to stop but not gone yet: the memory is still in use.
        expect(broker.getSnapshot().used.estimatedResidentBytes).toBe(largest);
        exited.resolve();
        await vi.waitFor(() => expect(broker.getSnapshot()).toMatchObject({
            active: 0,
            used: {cpuTokens: 0, estimatedResidentBytes: 0},
        }));
    });

    it('charges a worker that changes languages for every model its engine keeps', async () => {
        const broker = new JobBroker(POOL_CAPACITY);
        const pool = createOcrEnginePool({
            size: () => 1,
            workerPath: '/unused/ocr-engine.mjs',
            workerData: {engineDir: '/unused/engine', tessdataDir: await createTessdata(40 * MIB, {fra: 30 * MIB})},
            broker,
        });
        try {
            await pool.run({image: new Uint8Array([0]), models: ['eng'], passes: ENGINE_PASSES}, new AbortController().signal);
            await pool.run({image: new Uint8Array([0]), models: ['fra'], passes: ENGINE_PASSES}, new AbortController().signal);

            // French in use, and the English model's bytes the engine still keeps.
            expect(broker.getSnapshot().used.estimatedResidentBytes).toBe(2.5 * 30 * MIB + PAGE_HEAP_BYTES + 40 * MIB);
        } finally {
            pool.terminate();
        }
    });

    it('does not deadlock two warm workers that each wait for memory the other holds', async () => {
        const broker = new JobBroker({
            ...POOL_CAPACITY,
            estimatedResidentBytes: 512 * MIB,
        });
        const pool = createOcrEnginePool({
            size: () => 2,
            workerPath: '/unused/ocr-engine.mjs',
            workerData: {engineDir: '/unused/engine', tessdataDir: await createTessdata(60 * MIB)},
            broker,
        });
        try {
            // Two warm workers, each holding a page's heap.
            const reply = Promise.withResolvers<void>();
            boundary.replyGate = reply.promise;
            const warmUps = [
                pool.run({image: new Uint8Array([0]), models: ['fra'], passes: ENGINE_PASSES}, new AbortController().signal),
                pool.run({image: new Uint8Array([0]), models: ['fra'], passes: ENGINE_PASSES}, new AbortController().signal),
            ];
            await vi.waitFor(() => expect(boundary.workers).toHaveLength(2));
            reply.resolve();
            await Promise.all(warmUps);
            boundary.replyGate = undefined;
            expect(broker.getSnapshot().used.estimatedResidentBytes).toBe(2 * PAGE_HEAP_BYTES);

            // Each now needs 150 MiB more; together they do not fit.
            await expect(Promise.all([
                pool.run({image: new Uint8Array([0]), models: ['eng'], passes: ENGINE_PASSES}, new AbortController().signal),
                pool.run({image: new Uint8Array([0]), models: ['eng'], passes: ENGINE_PASSES}, new AbortController().signal),
            ])).resolves.toHaveLength(2);
            expect(broker.getSnapshot().queued).toBe(0);
        } finally {
            pool.terminate();
        }
    });

    it('does not end a warm worker whose pass the broker granted in the same turn as memory-short work', async () => {
        const broker = new JobBroker({
            ...POOL_CAPACITY,
            cpuTokens: 1,
            estimatedResidentBytes: 512 * MIB,
        });
        const pool = createOcrEnginePool({
            size: () => 1,
            workerPath: '/unused/ocr-engine.mjs',
            workerData: {engineDir: '/unused/engine', tessdataDir: await createTessdata(60 * MIB)},
            broker,
        });
        try {
            await pool.run({image: new Uint8Array([0]), models: ['fra'], passes: ENGINE_PASSES}, new AbortController().signal);
            const cpuBlocker = await broker.acquire({
                ownerId: 'cpu-blocker',
                kind: 'render',
                priority: 'user',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 0,
                    nativeProcesses: 0,
                    ioWeight: 0,
                },
            });
            const reply = Promise.withResolvers<void>();
            boundary.replyGate = reply.promise;
            const pass = pool.run({image: new Uint8Array([0]), models: ['eng'], passes: ENGINE_PASSES}, new AbortController().signal);
            await vi.waitFor(() => expect(broker.getSnapshot().queued).toBe(1));

            // Sol's probe: the release grants the pass, and work short of
            // memory arrives before the pass's code resumes.
            cpuBlocker.release();
            const waiting = broker.acquire({
                ownerId: 'scan-cleanup',
                kind: 'page',
                priority: 'user',
                resources: {
                    cpuTokens: 0,
                    estimatedResidentBytes: 300 * MIB,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
            });

            await new Promise(resolve => setImmediate(resolve));
            // The granted worker runs its pass; it is not ended under it.
            expect(boundary.workers).toHaveLength(1);
            expect(boundary.workers[0]!.dead).toBe(false);

            reply.resolve();
            await expect(pass).resolves.toEqual({passes: []});
            (await waiting).release();
        } finally {
            pool.terminate();
        }
    });

    it.each([
        ['while its pass waits for a core', false],
        ['in the turn the broker grants its pass', true],
    ] as const)('runs a pass on a fresh worker when the warm one exits %s', async (_when, exitAfterGrant) => {
        const broker = new JobBroker({
            ...POOL_CAPACITY,
            cpuTokens: 1,
        });
        const pool = createOcrEnginePool({
            size: () => 1,
            workerPath: '/unused/ocr-engine.mjs',
            workerData: {engineDir: '/unused/engine', tessdataDir: await createTessdata(40 * MIB)},
            broker,
        });
        try {
            await pool.run({image: new Uint8Array([0]), models: ['eng'], passes: ENGINE_PASSES}, new AbortController().signal);
            const cpuBlocker = await broker.acquire({
                ownerId: 'cpu-blocker',
                kind: 'render',
                priority: 'user',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 0,
                    nativeProcesses: 0,
                    ioWeight: 0,
                },
            });
            const pass = pool.run({image: new Uint8Array([0]), models: ['eng'], passes: ENGINE_PASSES}, new AbortController().signal);
            await vi.waitFor(() => expect(broker.getSnapshot().queued).toBe(1));

            // Sol's probe: the warm worker dies while its pass waits for a core.
            const warm = boundary.workers[0]!;
            const die = () => {
                warm.dead = true;
                warm.emit('exit', 1);
            };
            if (exitAfterGrant) {
                cpuBlocker.release();
                die();
            } else {
                die();
                // The pass leaves the dead worker at once and waits in the broker
                // before constructing a fresh worker thread.
                await vi.waitFor(() => expect(broker.getSnapshot().queued).toBe(1));
                expect(boundary.workers).toHaveLength(1);
                cpuBlocker.release();
            }

            await expect(pass).resolves.toEqual({passes: []});
            expect(boundary.workers).toHaveLength(2);
            expect(boundary.workers[1]!.dead).toBe(false);
            expect(broker.getSnapshot().used.cpuTokens).toBe(0);
        } finally {
            pool.terminate();
        }
    });

    it('starts no worker for a waiting pass once the pool is shut down', async () => {
        const pool = createOcrEnginePool({
            size: () => 1,
            workerPath: '/unused/ocr-engine.mjs',
            workerData: {engineDir: '/unused/engine', tessdataDir: await createTessdata(40 * MIB)},
            broker: new JobBroker(POOL_CAPACITY),
        });
        const reply = Promise.withResolvers<void>();
        boundary.replyGate = reply.promise;
        const running = pool.run({image: new Uint8Array([0]), models: ['eng'], passes: ENGINE_PASSES}, new AbortController().signal);
        void running.catch(() => undefined);
        await vi.waitFor(() => expect(boundary.workers).toHaveLength(1));
        const waiting = pool.run({image: new Uint8Array([0]), models: ['eng'], passes: ENGINE_PASSES}, new AbortController().signal);

        pool.terminate();

        await expect(waiting).rejects.toThrow(/shut down/u);
        await expect(running).rejects.toThrow(/exited/u);
        expect(boundary.workers).toHaveLength(1);
        reply.resolve();
    });

    it('takes a queued pass out of the broker at shutdown while its worker\'s memory stays charged until exit', async () => {
        const broker = new JobBroker({
            ...POOL_CAPACITY,
            cpuTokens: 1,
        });
        const pool = createOcrEnginePool({
            size: () => 1,
            workerPath: '/unused/ocr-engine.mjs',
            workerData: {engineDir: '/unused/engine', tessdataDir: await createTessdata(40 * MIB)},
            broker,
        });
        const largest = 2.5 * 40 * MIB + PAGE_HEAP_BYTES;
        await pool.run({image: new Uint8Array([0]), models: ['eng'], passes: ENGINE_PASSES}, new AbortController().signal);
        const cpuBlocker = await broker.acquire({
            ownerId: 'cpu-blocker',
            kind: 'render',
            priority: 'user',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 0,
                nativeProcesses: 0,
                ioWeight: 0,
            },
        });
        const pass = pool.run({image: new Uint8Array([0]), models: ['eng'], passes: ENGINE_PASSES}, new AbortController().signal);
        await vi.waitFor(() => expect(broker.getSnapshot().queued).toBe(1));

        // Sol's probe: the warm worker's thread does not stop yet.
        const exited = Promise.withResolvers<void>();
        boundary.terminateGate = exited.promise;
        pool.terminate();

        await expect(pass).rejects.toThrow(/shut down/u);
        expect(broker.getSnapshot()).toMatchObject({
            queued: 0,
            used: {estimatedResidentBytes: largest},
        });
        exited.resolve();
        await vi.waitFor(() => expect(broker.getSnapshot().used.estimatedResidentBytes).toBe(0));
        cpuBlocker.release();
    });

    it('ends a warm worker whose queued pass was canceled while other work waits for its memory', async () => {
        const broker = new JobBroker({
            ...POOL_CAPACITY,
            cpuTokens: 1,
            estimatedResidentBytes: 512 * MIB,
        });
        const pool = createOcrEnginePool({
            size: () => 1,
            workerPath: '/unused/ocr-engine.mjs',
            workerData: {engineDir: '/unused/engine', tessdataDir: await createTessdata(60 * MIB)},
            broker,
        });
        try {
            await pool.run({image: new Uint8Array([0]), models: ['fra'], passes: ENGINE_PASSES}, new AbortController().signal);
            const cpuBlocker = await broker.acquire({
                ownerId: 'cpu-blocker',
                kind: 'render',
                priority: 'user',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 0,
                    nativeProcesses: 0,
                    ioWeight: 0,
                },
            });
            const passAbort = new AbortController();
            const pass = pool.run({image: new Uint8Array([0]), models: ['eng'], passes: ENGINE_PASSES}, passAbort.signal);
            void pass.catch(() => undefined);
            await vi.waitFor(() => expect(broker.getSnapshot().queued).toBe(1));

            // Sol's probe, in one turn: the pass is canceled, the core frees,
            // and work arrives that needs the memory the warm worker holds.
            passAbort.abort();
            cpuBlocker.release();
            const started = performance.now();
            const waiting = broker.acquire({
                ownerId: 'scan-cleanup',
                kind: 'page',
                priority: 'user',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 400 * MIB,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
            });

            await expect(pass).rejects.toMatchObject({name: 'AbortError'});
            // Granted once the parked worker exits, not after its 60 s idle time.
            const lease = await waiting;
            expect(performance.now() - started).toBeLessThan(5_000);
            expect(boundary.workers[0]!.dead).toBe(true);
            lease.release();
        } finally {
            pool.terminate();
        }
    });

    it('ends a worker whose pass finishes while other work waits for its memory', async () => {
        const broker = new JobBroker({
            ...POOL_CAPACITY,
            estimatedResidentBytes: 512 * MIB,
        });
        const pool = createOcrEnginePool({
            size: () => 1,
            workerPath: '/unused/ocr-engine.mjs',
            workerData: {engineDir: '/unused/engine', tessdataDir: await createTessdata(40 * MIB)},
            broker,
        });
        try {
            const reply = Promise.withResolvers<void>();
            boundary.replyGate = reply.promise;
            const pass = pool.run({image: new Uint8Array([0]), models: ['eng'], passes: ENGINE_PASSES}, new AbortController().signal);
            await vi.waitFor(() => expect(broker.getSnapshot().used.cpuTokens).toBe(1));
            let granted = false;
            const waiting = broker.acquire({
                ownerId: 'scan-cleanup',
                kind: 'page',
                priority: 'user',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 300 * MIB,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
            }).then((lease) => {
                granted = true;
                return lease;
            });
            await new Promise(resolve => setImmediate(resolve));
            expect(granted).toBe(false);

            reply.resolve();
            await pass;
            // The worker went idle while that work waited; it ends instead of
            // keeping its memory for its 60 s idle time.
            const lease = await waiting;
            expect(boundary.workers[0]?.dead).toBe(true);
            lease.release();
        } finally {
            pool.terminate();
        }
    });

    it('ends an idle worker when other work is short of the memory it holds', async () => {
        const broker = new JobBroker({
            ...POOL_CAPACITY,
            estimatedResidentBytes: 400 * MIB,
        });
        const pool = createOcrEnginePool({
            size: () => 1,
            workerPath: '/unused/ocr-engine.mjs',
            workerData: {engineDir: '/unused/engine', tessdataDir: await createTessdata(40 * MIB)},
            broker,
        });
        try {
            await pool.run({image: new Uint8Array([0]), models: ['eng'], passes: ENGINE_PASSES}, new AbortController().signal);
            expect(broker.getSnapshot().used.estimatedResidentBytes).toBe(2.5 * 40 * MIB + PAGE_HEAP_BYTES);

            const started = performance.now();
            const lease = await broker.acquire({
                ownerId: 'scan-cleanup',
                kind: 'page',
                priority: 'user',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 200 * MIB,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
            });

            // Granted once the idle worker exited, not after its 60 s idle time.
            expect(performance.now() - started).toBeLessThan(5_000);
            expect(boundary.workers[0]?.dead).toBe(true);
            expect(broker.getSnapshot().used.estimatedResidentBytes).toBe(200 * MIB);
            lease.release();
        } finally {
            pool.terminate();
        }
    });

    it('waits for the first broker lease before constructing a fresh worker thread', async () => {
        const broker = new JobBroker({
            ...POOL_CAPACITY,
            cpuTokens: 1,
        });
        const cpuBlocker = await broker.acquire({
            ownerId: 'cpu-blocker',
            kind: 'render',
            priority: 'user',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 0,
                nativeProcesses: 0,
                ioWeight: 0,
            },
        });
        const pool = createOcrEnginePool({
            size: () => 1,
            workerPath: '/unused/ocr-engine.mjs',
            workerData: {engineDir: '/unused/engine', tessdataDir: await createTessdata(40 * MIB)},
            broker,
        });
        try {
            const pass = pool.run({image: new Uint8Array([0]), models: ['eng'], passes: ENGINE_PASSES}, new AbortController().signal);
            await vi.waitFor(() => expect(broker.getSnapshot().queued).toBe(1));
            expect(boundary.workers).toHaveLength(0);

            cpuBlocker.release();
            await pass;
            expect(boundary.workers).toHaveLength(1);
        } finally {
            pool.terminate();
        }
    });

    it('propagates a synchronous Worker constructor error without retrying', async () => {
        const broker = new JobBroker(POOL_CAPACITY);
        let attempts = 0;
        boundary.constructorError = () => {
            attempts += 1;
            return attempts === 1 ? new Error('worker spawn boom 1') : undefined;
        };
        const pool = createOcrEnginePool({
            size: () => 1,
            workerPath: '/unused/ocr-engine.mjs',
            workerData: {
                engineDir: '/unused/engine',
                tessdataDir: await createTessdata(40 * MIB),
            },
            broker,
        });
        try {
            await expect(pool.run({
                image: new Uint8Array([0]),
                models: ['eng'],
                passes: ENGINE_PASSES,
            }, new AbortController().signal)).rejects.toThrow('worker spawn boom 1');
            expect(attempts).toBe(1);
            expect(boundary.workers).toHaveLength(0);
            expect(broker.getSnapshot()).toMatchObject({
                active: 0,
                queued: 0,
                used: {
                    cpuTokens: 0,
                    estimatedResidentBytes: 0,
                },
            });
        } finally {
            pool.terminate();
        }
    });

    it('does not construct a fresh worker when canceled in the same turn a queued lease is granted', async () => {
        const broker = new JobBroker({
            ...POOL_CAPACITY,
            cpuTokens: 1,
        });
        const cpuBlocker = await broker.acquire({
            ownerId: 'cpu-blocker',
            kind: 'render',
            priority: 'user',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 0,
                nativeProcesses: 0,
                ioWeight: 0,
            },
        });
        const pool = createOcrEnginePool({
            size: () => 1,
            workerPath: '/unused/ocr-engine.mjs',
            workerData: {
                engineDir: '/unused/engine',
                tessdataDir: await createTessdata(40 * MIB),
            },
            broker,
        });
        try {
            const controller = new AbortController();
            const pass = pool.run({
                image: new Uint8Array([0]),
                models: ['eng'],
                passes: ENGINE_PASSES,
            }, controller.signal);
            await vi.waitFor(() => expect(broker.getSnapshot().queued).toBe(1));

            cpuBlocker.release();
            controller.abort(new Error('pass canceled'));
            await expect(pass).rejects.toThrow('pass canceled');
            expect(boundary.workers).toHaveLength(0);
            expect(broker.getSnapshot()).toMatchObject({
                active: 0,
                queued: 0,
                used: {
                    cpuTokens: 0,
                    estimatedResidentBytes: 0,
                },
            });
        } finally {
            pool.terminate();
        }
    });
});
