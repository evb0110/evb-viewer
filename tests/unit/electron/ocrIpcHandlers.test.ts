import type { TRegisteredHandler } from '@tests/unit/electron/helpers/ipcRegistryHarness';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { OCR_PLATFORM_FEATURE } from '@contracts/ocrPlatformFeature';
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
    resolveDocumentOcrAvailability: vi.fn(),
    resolveDocumentOcrPage: vi.fn(),
    resolveDocumentTextCatalogSnapshot: vi.fn(),
    resolveDocumentTextCatalogWindow: vi.fn(),
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
vi.mock('@electron/file-access/workingCopyCreation', () => ({requireManagedWorkingCopyPath: (path: string) => mocks.requireManagedWorkingCopyPath(path)}));
vi.mock('@electron/file-access/workingCopyStore', async () => ({
    ...await vi.importActual<Record<string, unknown>>('@electron/file-access/workingCopyStore'),
    getWorkingCopyBackingEntry: mocks.getWorkingCopyBackingEntry,
}));
vi.mock('@electron/file-access/runWithWorkingCopyReadBacking', () => ({runWithWorkingCopyReadBacking: (...args: unknown[]) => mocks.runWithWorkingCopyReadBacking(...args)}));
vi.mock('@electron/file-access/workingCopyMaterialization', () => {
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
vi.mock('@electron/features/ocr/main/documentTextCatalog', () => ({
    resolveDocumentOcrAvailability: (...args: unknown[]) => mocks.resolveDocumentOcrAvailability(...args),
    resolveDocumentOcrPage: (...args: unknown[]) => mocks.resolveDocumentOcrPage(...args),
    resolveDocumentTextCatalogSnapshot: (...args: unknown[]) => mocks.resolveDocumentTextCatalogSnapshot(...args),
    resolveDocumentTextCatalogWindow: (...args: unknown[]) => mocks.resolveDocumentTextCatalogWindow(...args),
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
        mocks.resolveDocumentOcrAvailability.mockResolvedValue({
            pageCount: 0,
            pageNumbers: [],
        });
        mocks.resolveDocumentOcrPage.mockResolvedValue({
            pageCount: 0,
            page: null,
        });
        mocks.resolveDocumentTextCatalogSnapshot.mockResolvedValue({pages: []});
        mocks.resolveDocumentTextCatalogWindow.mockResolvedValue({pages: []});
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
        expect(mocks.resolveDocumentTextCatalogSnapshot).toHaveBeenCalledWith(
            logicalPath,
            revision,
            1,
            {
                sourcePdfPath: physicalPath,
                signal: expect.any(AbortSignal),
            },
        );

        const availabilityHandler = getHandler('ocr:resolveDocumentOcrAvailability');
        await availabilityHandler(
            {sender: createMockSender(31)},
            logicalPath,
            revision,
        );
        expect(mocks.resolveDocumentOcrAvailability).toHaveBeenCalledWith(
            logicalPath,
            revision,
            {signal: expect.any(AbortSignal)},
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
        mocks.resolveDocumentTextCatalogSnapshot.mockImplementationOnce(async (...args: unknown[]) => {
            const options = args[3] as {signal?: AbortSignal};
            await readGate;
            options.signal?.throwIfAborted();
            return {pages: []};
        });

        const readPromise = getHandler('ocr:resolveDocumentTextCatalog')(
            {sender: createMockSender(43)},
            logicalPath,
            'ocr-revision',
            1,
            requestId,
        );
        await vi.waitFor(() => expect(mocks.resolveDocumentTextCatalogSnapshot).toHaveBeenCalledTimes(1));

        expect(getHandler('ocr:cancel')(
            {sender: createMockSender(43)},
            requestId,
        )).toMatchObject({canceled: true});
        const options = mocks.resolveDocumentTextCatalogSnapshot.mock.calls[0]?.[3] as {signal?: AbortSignal};
        expect(options.signal?.aborted).toBe(true);

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
        mocks.resolveDocumentTextCatalogWindow.mockImplementationOnce(async (...args: unknown[]) => {
            const options = args[5] as {signal?: AbortSignal};
            await readGate;
            options.signal?.throwIfAborted();
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
        await vi.waitFor(() => expect(mocks.resolveDocumentTextCatalogWindow).toHaveBeenCalledTimes(1));

        expect(getHandler('ocr:cancel')(
            {sender: createMockSender(44)},
            requestId,
        )).toMatchObject({canceled: true});
        const options = mocks.resolveDocumentTextCatalogWindow.mock.calls[0]?.[5] as {signal?: AbortSignal};
        expect(options.signal?.aborted).toBe(true);

        releaseRead?.();
        await expect(readPromise).rejects.toMatchObject({name: 'AbortError'});
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
        expect(mocks.resolveDocumentTextCatalogSnapshot).not.toHaveBeenCalled();
    });

    it('returns typed worker-unavailable envelope for missing OCR worker path', async () => {
        mocks.handleOcrCreateSearchablePdfAsync.mockResolvedValue({
            started: false,
            jobId: 'job-worker-missing',
            error: 'OCR worker unavailable at path: /tmp/missing-ocr-worker.js',
        });

        const handler = getHandler('ocr:createSearchablePdf');
        const result = await handler(
            {sender: createMockSender(11)},
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-worker-missing',
        ) as {
            started: boolean;
            jobId: string;
            error?: string;
            errorEnvelope?: {
                code: string;
                retryable: boolean;
            };
        };

        expect(result).toMatchObject({
            started: false,
            jobId: 'job-worker-missing',
            error: 'OCR worker unavailable at path: /tmp/missing-ocr-worker.js',
            errorEnvelope: {
                code: 'OCR_WORKER_UNAVAILABLE',
                retryable: true,
            },
        });
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

    it('maps queue saturation to controlled backpressure rejection', async () => {
        mocks.handleOcrCreateSearchablePdfAsync.mockResolvedValue({
            started: false,
            jobId: 'job-queue-full',
            error: 'OCR queue is full (8 jobs)',
        });

        const handler = getHandler('ocr:createSearchablePdf');
        const result = await handler(
            {sender: createMockSender(13)},
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-queue-full',
        ) as {
            started: boolean;
            errorEnvelope?: {
                code: string;
                retryable: boolean;
            };
        };

        expect(result.started).toBe(false);
        expect(result.errorEnvelope).toMatchObject({
            code: 'OCR_QUEUE_BACKPRESSURE',
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
                details?: string;
            };
        };

        expect(result.started).toBe(false);
        expect(result.errorEnvelope).toMatchObject({
            code: 'OCR_INTERNAL_ERROR',
            message: 'worker exploded with a private stack',
        });
        expect(result.errorEnvelope).not.toHaveProperty('details');
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
            resolver: 'resolveDocumentTextCatalogSnapshot',
            args: [1],
            optionsIndex: 3,
        },
        {
            channel: 'ocr:resolveDocumentTextCatalogWindow',
            resolver: 'resolveDocumentTextCatalogWindow',
            args: [
                1,
                1,
                1,
            ],
            optionsIndex: 5,
        },
        {
            channel: 'ocr:resolveDocumentOcrAvailability',
            resolver: 'resolveDocumentOcrAvailability',
            args: [],
            optionsIndex: 2,
        },
        {
            channel: 'ocr:resolveDocumentOcrPage',
            resolver: 'resolveDocumentOcrPage',
            args: [1],
            optionsIndex: 3,
        },
    ] as const)('aborts $channel when its working copy closes mid-read (SRCH-006)', async ({
        channel,
        resolver,
        args,
        optionsIndex,
    }) => {
        const logicalPath = '/tmp/working-copy.pdf';
        let observedSignal: AbortSignal | undefined;
        mocks[resolver].mockImplementation(async (...resolverArgs: unknown[]) => {
            const options = resolverArgs[optionsIndex] as {signal?: AbortSignal} | undefined;
            observedSignal = options?.signal;
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
