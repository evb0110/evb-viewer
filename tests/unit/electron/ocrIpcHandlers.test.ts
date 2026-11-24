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
import {
    createOcrEngineHost,
    OcrEngineHostExitError,
} from '@electron/features/ocr/main/ocrEngineHostClient';
import {OCR_ENGINE_SERVICE_NAME} from '@electron/processDeathRecovery';
import {
    decodeOcrEngineHostEvent,
    type TOcrEngineHostEvent,
    type TOcrEngineHostRequest,
} from '@electron/features/ocr/main/ocrEngineHostProtocol';
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

const utility = vi.hoisted(() => ({fork: undefined as unknown as (path: string, args: string[], options: {serviceName?: string}) => unknown}));

vi.mock('electron', () => ({
    app: { isPackaged: false },
    BrowserWindow: { fromWebContents: vi.fn(() => null) },
    ipcMain: { handle: vi.fn() },
    utilityProcess: {fork: (path: string, args: string[], options: {serviceName?: string}) => utility.fork(path, args, options)},
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
    workers: [] as FakeLane[],
    // Hold a pass's reply, or a worker's exit after terminate, until resolved.
    replyGate: undefined as Promise<void> | undefined,
    terminateGate: undefined as Promise<void> | undefined,
    constructorError: undefined as (() => Error | undefined) | undefined,
}));

/** An engine lane as the pool sees it, answering every page with no passes. */
class FakeLane extends EventEmitter {
    dead = false;
    terminatedAfterDeath = false;
    constructor() {
        super();
        boundary.workers.push(this);
    }
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
}

function startFakeLane() {
    const error = boundary.constructorError?.();
    if (error) throw error;
    return new FakeLane();
}

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
            tessdataDir: '/unused/models',
            startLane: startFakeLane,
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
            tessdataDir: await createTessdata(40 * MIB),
            startLane: startFakeLane,
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
            tessdataDir: await createTessdata(40 * MIB, {fra: 30 * MIB}),
            startLane: startFakeLane,
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
            tessdataDir: await createTessdata(60 * MIB),
            startLane: startFakeLane,
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
            tessdataDir: await createTessdata(60 * MIB),
            startLane: startFakeLane,
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
            tessdataDir: await createTessdata(40 * MIB),
            startLane: startFakeLane,
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
            tessdataDir: await createTessdata(40 * MIB),
            startLane: startFakeLane,
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
            tessdataDir: await createTessdata(40 * MIB),
            startLane: startFakeLane,
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
            tessdataDir: await createTessdata(60 * MIB),
            startLane: startFakeLane,
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
            tessdataDir: await createTessdata(40 * MIB),
            startLane: startFakeLane,
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
            tessdataDir: await createTessdata(40 * MIB),
            startLane: startFakeLane,
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
            tessdataDir: await createTessdata(40 * MIB),
            startLane: startFakeLane,
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

    it('propagates a synchronous lane start error without retrying', async () => {
        const broker = new JobBroker(POOL_CAPACITY);
        let attempts = 0;
        boundary.constructorError = () => {
            attempts += 1;
            return attempts === 1 ? new Error('worker spawn boom 1') : undefined;
        };
        const pool = createOcrEnginePool({
            size: () => 1,
            tessdataDir: await createTessdata(40 * MIB),
            startLane: startFakeLane,
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
            tessdataDir: await createTessdata(40 * MIB),
            startLane: startFakeLane,
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

/** The OCR utility process as main sees it, running its lanes as the real host does. */
class FakeUtilityChild extends EventEmitter {
    static nextPid = 4_000;
    // Whether a forked child starts on its own, or waits for `spawn()`.
    static autoSpawn = true;
    readonly pid = FakeUtilityChild.nextPid++;
    readonly requests: TOcrEngineHostRequest[] = [];
    readonly lanes = new Set<number>();
    exitOnShutdown = true;
    exited = false;
    killed = false;
    constructor(readonly path: string, readonly serviceName: string | undefined) {
        super();
        if (FakeUtilityChild.autoSpawn) void Promise.resolve().then(() => this.spawn());
    }
    spawn() {
        if (!this.exited) this.emit('spawn');
    }
    postMessage(request: TOcrEngineHostRequest) {
        if (this.exited) return;
        this.requests.push(request);
        switch (request.type) {
            case 'start':
                this.lanes.add(request.lane);
                return;
            case 'run': {
                const {lane, message} = request;
                void Promise.resolve(boundary.replyGate).then(() => {
                    if (this.lanes.has(lane)) this.send({type: 'reply', lane, reply: {id: message.id, ok: true, result: {passes: []}}});
                });
                return;
            }
            case 'end':
                if (this.lanes.delete(request.lane)) {
                    void Promise.resolve().then(() => this.send({type: 'exit', lane: request.lane, code: 1}));
                }
                return;
            case 'shutdown':
                if (this.exitOnShutdown) void Promise.resolve().then(() => this.exit(0));
                return;
        }
    }
    send(event: TOcrEngineHostEvent) {
        if (!this.exited) this.emit('message', event);
    }
    exit(code: number) {
        if (this.exited) return;
        this.exited = true;
        this.lanes.clear();
        this.emit('exit', code);
    }
    kill() {
        this.killed = true;
        this.exit(15);
        return true;
    }
}

describe('OCR engine utility process', () => {
    const children: FakeUtilityChild[] = [];
    const workerData = {engineDir: '/app/wasm', tessdataDir: '/models'};

    beforeEach(() => {
        utility.fork = (path, _args, options) => {
            const child = new FakeUtilityChild(path, options.serviceName);
            children.push(child);
            return child;
        };
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        children.length = 0;
        boundary.replyGate = undefined;
        FakeUtilityChild.autoSpawn = true;
    });

    function createHost() {
        return createOcrEngineHost({
            hostPath: '/app/ocr-engine-host.js',
            workerPath: '/app/ocr-engine-worker.js',
            workerData,
        });
    }

    async function createModels() {
        const dir = await mkdtemp(join(tmpdir(), 'ocr-host-models-'));
        onTestFinished(() => rm(dir, {recursive: true, force: true}));
        await writeFile(join(dir, 'eng.traineddata'), '');
        await truncate(join(dir, 'eng.traineddata'), 40 * MIB);
        return dir;
    }

    function runPage(pool: ReturnType<typeof createOcrEnginePool>, signal = new AbortController().signal) {
        return pool.run({image: new Uint8Array([0]), models: ['eng'], passes: ENGINE_PASSES}, signal);
    }

    it('runs every lane in one utility process and exits it once the last lane has ended', async () => {
        const host = createHost();
        const first = host.startLane();
        const second = host.startLane();
        expect(children).toHaveLength(1);
        expect(children[0]).toMatchObject({path: '/app/ocr-engine-host.js', serviceName: OCR_ENGINE_SERVICE_NAME});
        // Lanes asked for before the process started reach it once it has.
        await vi.waitFor(() => expect(children[0]!.lanes.size).toBe(2));
        expect(children[0]!.requests[0]).toEqual({type: 'start', lane: 0, workerPath: '/app/ocr-engine-worker.js', workerData});

        await first.terminate();
        expect(children[0]!.requests.some(request => request.type === 'shutdown')).toBe(false);
        await second.terminate();
        // No lanes left: the process is asked to exit and does, returning all its memory.
        await vi.waitFor(() => expect(children[0]!.exited).toBe(true));
        expect(children[0]!.requests.at(-1)).toEqual({type: 'shutdown'});
        expect(children[0]!.killed).toBe(false);

        // The next lane starts a fresh process.
        const third = host.startLane();
        expect(children).toHaveLength(2);
        await third.terminate();
        await vi.waitFor(() => expect(children[1]!.exited).toBe(true));
    });

    it('exits the utility process when its idle lanes reach their idle time, and restarts it for the next page', async () => {
        vi.useFakeTimers();
        const host = createHost();
        const broker = new JobBroker(POOL_CAPACITY);
        const pool = createOcrEnginePool({size: () => 2, tessdataDir: await createModels(), startLane: () => host.startLane(), broker});
        try {
            await expect(Promise.all([runPage(pool), runPage(pool)])).resolves.toHaveLength(2);
            expect(children).toHaveLength(1);
            expect(broker.getSnapshot().used.estimatedResidentBytes).toBeGreaterThan(0);

            await vi.advanceTimersByTimeAsync(60_000);
            expect(children[0]!.exited).toBe(true);
            expect(children[0]!.killed).toBe(false);
            expect(broker.getSnapshot()).toMatchObject({active: 0, used: {cpuTokens: 0, estimatedResidentBytes: 0}});

            await expect(runPage(pool)).resolves.toEqual({passes: []});
            expect(children).toHaveLength(2);
            expect(children[1]!.exited).toBe(false);
        } finally {
            pool.terminate();
            host.shutdown();
        }
    });

    it('fails the pages in flight when the utility process dies, frees their memory, and restarts it for the next page', async () => {
        const host = createHost();
        const broker = new JobBroker(POOL_CAPACITY);
        const pool = createOcrEnginePool({size: () => 2, tessdataDir: await createModels(), startLane: () => host.startLane(), broker});
        try {
            const reply = Promise.withResolvers<void>();
            boundary.replyGate = reply.promise;
            const pages = [runPage(pool), runPage(pool)];
            await vi.waitFor(() => expect(children[0]?.requests.filter(request => request.type === 'run')).toHaveLength(2));

            children[0]!.exit(134);

            for (const page of pages) {
                const error = await page.then(() => null, (caught: unknown) => caught);
                expect(error).toBeInstanceOf(Error);
                expect((error as Error).message).toMatch(/OCR engine process exited unexpectedly \(exit code 134/u);
                expect((error as Error).cause).toBeInstanceOf(OcrEngineHostExitError);
                expect((error as Error).cause).toMatchObject({exitCode: 134, pid: children[0]!.pid, code: 'OCR_ENGINE_HOST_EXITED'});
            }
            expect(broker.getSnapshot()).toMatchObject({active: 0, queued: 0, used: {cpuTokens: 0, estimatedResidentBytes: 0}});

            reply.resolve();
            boundary.replyGate = undefined;
            await expect(runPage(pool)).resolves.toEqual({passes: []});
            expect(children).toHaveLength(2);
        } finally {
            pool.terminate();
            host.shutdown();
        }
    });

    it('cancels a busy page by ending its lane inside the utility process, which keeps running other lanes', async () => {
        const host = createHost();
        const broker = new JobBroker(POOL_CAPACITY);
        const pool = createOcrEnginePool({size: () => 2, tessdataDir: await createModels(), startLane: () => host.startLane(), broker});
        try {
            const reply = Promise.withResolvers<void>();
            boundary.replyGate = reply.promise;
            const canceled = new AbortController();
            const page = runPage(pool, canceled.signal);
            const other = runPage(pool);
            await vi.waitFor(() => expect(children[0]?.requests.filter(request => request.type === 'run')).toHaveLength(2));

            canceled.abort(new Error('user canceled'));
            await expect(page).rejects.toThrow('user canceled');
            await vi.waitFor(() => expect(children[0]!.requests).toContainEqual({type: 'end', lane: 0}));
            expect(children[0]!.exited).toBe(false);

            reply.resolve();
            await expect(other).resolves.toEqual({passes: []});
            expect(children).toHaveLength(1);
        } finally {
            pool.terminate();
            host.shutdown();
        }
    });

    it('asks the utility process to exit at shutdown and kills it if it has not after its grace time', async () => {
        vi.useFakeTimers();
        const host = createHost();
        const lane = host.startLane();
        const exits: number[] = [];
        lane.on('exit', code => exits.push(code));
        await vi.advanceTimersByTimeAsync(0);
        children[0]!.exitOnShutdown = false;

        host.shutdown();
        await vi.advanceTimersByTimeAsync(0);
        expect(children[0]!.requests.at(-1)).toEqual({type: 'shutdown'});
        expect(children[0]!.killed).toBe(false);

        await vi.advanceTimersByTimeAsync(5_000);
        expect(children[0]!.killed).toBe(true);
        // An exit main asked for fails nothing; the lane just ends.
        expect(exits).toEqual([15]);
    });

    async function createPagePool(host: ReturnType<typeof createHost>, broker = new JobBroker(POOL_CAPACITY)) {
        return {
            broker,
            pool: createOcrEnginePool({size: () => 2, tessdataDir: await createModels(), startLane: () => host.startLane(), broker}),
        };
    }

    async function failureOf(page: Promise<unknown>) {
        return page.then(() => null, (caught: unknown) => caught as Error);
    }

    it('reports a fatal error of the utility process without throwing into main, and fails its pages on the exit that follows', async () => {
        const host = createHost();
        const {pool, broker} = await createPagePool(host);
        try {
            const reply = Promise.withResolvers<void>();
            boundary.replyGate = reply.promise;
            const page = runPage(pool);
            await vi.waitFor(() => expect(children[0]?.requests.some(request => request.type === 'run')).toBe(true));

            // An EventEmitter 'error' with no listener would throw here.
            expect(() => children[0]!.emit('error', 'FatalError', 'v8::ToLocalChecked Empty MaybeLocal', '')).not.toThrow();
            children[0]!.exit(133);

            const error = await failureOf(page);
            expect(error?.cause).toBeInstanceOf(OcrEngineHostExitError);
            expect(error?.cause).toMatchObject({exitCode: 133, failure: 'FatalError at v8::ToLocalChecked Empty MaybeLocal'});
            expect(error?.message).toContain('FatalError at v8::ToLocalChecked Empty MaybeLocal');
            expect(broker.getSnapshot().used).toMatchObject({cpuTokens: 0, estimatedResidentBytes: 0});
            reply.resolve();
        } finally {
            pool.terminate();
            host.shutdown();
        }
    });

    it('fails and ends only the lane whose message main cannot read', async () => {
        const host = createHost();
        const {pool} = await createPagePool(host);
        try {
            const reply = Promise.withResolvers<void>();
            boundary.replyGate = reply.promise;
            const broken = runPage(pool);
            const other = runPage(pool);
            await vi.waitFor(() => expect(children[0]?.requests.filter(request => request.type === 'run')).toHaveLength(2));

            children[0]!.emit('message', {type: 'reply', lane: 0, reply: {id: 0, ok: true, result: {passes: 'not passes'}}});

            await expect(broken).rejects.toThrow('The OCR engine returned an invalid result');
            expect(children[0]!.requests).toContainEqual({type: 'end', lane: 0});
            expect(children[0]!.killed).toBe(false);
            reply.resolve();
            await expect(other).resolves.toEqual({passes: []});
        } finally {
            pool.terminate();
            host.shutdown();
        }
    });

    it.each([
        ['no lane', {type: 'reply'}],
        ['a lane that is not a number', {type: 'exit', lane: 'zero', code: 0}],
        ['a lane it does not run', {type: 'reply', lane: 99, reply: null}],
    ])('fails every page and kills the utility process for a message with %s', async (_case, message) => {
        const host = createHost();
        const {pool, broker} = await createPagePool(host);
        try {
            const reply = Promise.withResolvers<void>();
            boundary.replyGate = reply.promise;
            const pages = [runPage(pool), runPage(pool)];
            await vi.waitFor(() => expect(children[0]?.requests.filter(request => request.type === 'run')).toHaveLength(2));

            children[0]!.emit('message', message);

            for (const page of pages) {
                await expect(page).rejects.toThrow('The OCR engine process sent a message main cannot read');
            }
            expect(children[0]!.killed).toBe(true);
            await vi.waitFor(() => expect(broker.getSnapshot().used).toMatchObject({cpuTokens: 0, estimatedResidentBytes: 0}));

            reply.resolve();
            boundary.replyGate = undefined;
            await expect(runPage(pool)).resolves.toEqual({passes: []});
            expect(children).toHaveLength(2);
        } finally {
            pool.terminate();
            host.shutdown();
        }
    });

    it('starts a fresh utility process for a lane asked for while the previous one is still exiting', async () => {
        vi.useFakeTimers();
        const host = createHost();
        const first = host.startLane();
        await vi.advanceTimersByTimeAsync(0);
        const retiring = children[0]!;
        retiring.exitOnShutdown = false;
        await first.terminate();
        expect(retiring.requests.at(-1)).toEqual({type: 'shutdown'});

        const next = host.startLane();
        const nextExits: number[] = [];
        next.on('exit', code => nextExits.push(code));
        await vi.advanceTimersByTimeAsync(0);
        expect(children).toHaveLength(2);
        expect(children[1]!.lanes.has(1)).toBe(true);
        expect(retiring.requests.filter(request => request.type === 'start')).toHaveLength(1);

        retiring.exit(0);
        // Its exit clears its own kill timer and touches nothing of the fresh process.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(retiring.killed).toBe(false);
        expect(children[1]!).toMatchObject({exited: false, killed: false});
        expect(nextExits).toEqual([]);

        await next.terminate();
        await vi.advanceTimersByTimeAsync(0);
        expect(children[1]!.exited).toBe(true);
    });

    it('starts no process when forking throws, and forks again for the next lane', () => {
        const host = createHost();
        const fork = utility.fork;
        utility.fork = () => {
            throw new Error('utility fork boom');
        };
        expect(() => host.startLane()).toThrow('utility fork boom');
        utility.fork = fork;

        const lane = host.startLane();
        expect(children).toHaveLength(1);
        void lane.terminate();
    });

    it('fails a lane whose utility process exits before it started, and forks again for the next lane', async () => {
        FakeUtilityChild.autoSpawn = false;
        const host = createHost();
        const lane = host.startLane();
        const errors: Error[] = [];
        lane.on('error', error => errors.push(error));
        const exited = lane.terminate();

        children[0]!.exit(1);

        await expect(exited).resolves.toBe(1);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(OcrEngineHostExitError);
        expect(errors[0]).toMatchObject({exitCode: 1});
        expect(children[0]!.requests).toEqual([]);

        host.startLane();
        expect(children).toHaveLength(2);
        children[1]!.spawn();
        expect(children[1]!.requests).toHaveLength(1);
        host.shutdown();
    });

    it('sends only the exit request to a process told to close before it started, and gives it its grace time once it has', async () => {
        vi.useFakeTimers();
        FakeUtilityChild.autoSpawn = false;
        const host = createHost();
        host.startLane();
        const child = children[0]!;
        child.exitOnShutdown = false;

        host.shutdown();
        // Its grace time runs out before it starts: there is nothing to kill yet.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(child.killed).toBe(false);

        child.spawn();
        expect(child.requests).toEqual([{type: 'shutdown'}]);
        await vi.advanceTimersByTimeAsync(4_999);
        expect(child.killed).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(child.killed).toBe(true);
    });
});

// An engine worker thread that answers every page with the image it was given.
const ECHO_ENGINE_WORKER_SOURCE = `
import {parentPort} from 'node:worker_threads';
parentPort.on('message', ({id, request}) => {
    parentPort.postMessage({id, ok: true, result: {passes: [{stderr: '', outputs: [request.image]}]}});
});
`;

describe('OCR engine utility process entry', () => {
    it('runs lanes as real worker threads, ends a lane on request, and exits on shutdown', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ocr-host-entry-'));
        onTestFinished(() => rm(dir, {recursive: true, force: true}));
        const workerPath = join(dir, 'echo-engine.mjs');
        const workerData = {engineDir: dir, tessdataDir: dir};
        await writeFile(workerPath, ECHO_ENGINE_WORKER_SOURCE);

        const port = new EventEmitter();
        const events: unknown[] = [];
        const parentPort = {
            on: (event: string, listener: (message: {data: unknown}) => void) => port.on(event, listener),
            postMessage: (event: unknown) => events.push(event),
        };
        const exited = Promise.withResolvers<number | undefined>();
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            exited.resolve(code);
        }) as typeof process.exit);
        Object.defineProperty(process, 'parentPort', {value: parentPort, configurable: true});
        onTestFinished(() => {
            exit.mockRestore();
            Reflect.deleteProperty(process, 'parentPort');
        });
        await import('@electron/features/ocr/main/ocrEngineHost');

        const post = (data: TOcrEngineHostRequest) => port.emit('message', {data});
        post({type: 'start', lane: 7, workerPath, workerData});
        post({type: 'start', lane: 8, workerPath, workerData});
        post({type: 'run', lane: 7, message: {id: 3, request: {image: new Uint8Array([1, 2, 3]), models: ['eng'], passes: ENGINE_PASSES}}});
        await vi.waitFor(() => expect(events).toContainEqual({
            type: 'reply',
            lane: 7,
            reply: {id: 3, ok: true, result: {passes: [{stderr: '', outputs: [new Uint8Array([1, 2, 3])]}]}},
        }));
        // Main reads what the utility process sent with the engine's result contract.
        expect(events.map(decodeOcrEngineHostEvent)).not.toContain(null);

        // A malformed request is ignored rather than ending the process.
        port.emit('message', {data: {type: 'run', lane: 7}});
        post({type: 'end', lane: 7});
        await vi.waitFor(() => expect(events).toContainEqual({type: 'exit', lane: 7, code: 1}));
        expect(events.filter(event => (event as {type: string}).type === 'exit')).toHaveLength(1);

        // Ending a lane the process does not have answers at once, so main never waits on it.
        post({type: 'end', lane: 99});
        expect(events).toContainEqual({type: 'exit', lane: 99, code: 1});

        // A page that cannot be sent to its worker fails that lane alone.
        post({type: 'run', lane: 8, message: {id: 4, request: {
            image: new Uint8Array([4]),
            models: ['eng'],
            passes: [{args: [], outputs: [], notCloneable: () => undefined}] as unknown as typeof ENGINE_PASSES,
        }}});
        expect(events.at(-1)).toMatchObject({type: 'error', lane: 8});
        post({type: 'run', lane: 8, message: {id: 5, request: {image: new Uint8Array([5]), models: ['eng'], passes: ENGINE_PASSES}}});
        await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({type: 'reply', lane: 8, reply: expect.objectContaining({id: 5})})));

        post({type: 'shutdown'});
        // Once shutting down it takes no more work: an end for a lane it does
        // not have, answered at once above, now gets no answer.
        post({type: 'start', lane: 9, workerPath, workerData});
        post({type: 'end', lane: 77});
        expect(events.some(event => (event as {lane?: number}).lane === 77)).toBe(false);
        post({type: 'shutdown'});
        await expect(exited.promise).resolves.toBe(0);
        expect(events).toContainEqual({type: 'exit', lane: 8, code: 1});
        expect(events.some(event => (event as {lane?: number}).lane === 9)).toBe(false);
        expect(exit).toHaveBeenCalledTimes(1);
    });
});
