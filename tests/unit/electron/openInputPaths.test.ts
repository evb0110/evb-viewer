import type * as TJobBrokerModule from '@electron/resources/jobBroker';
import {MAX_DOCUMENT_ALLOCATION_BYTES} from '@contracts/electronApiDocuments';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    broker: {current: null as TJobBrokerModule.JobBroker | null},
    readExactPageGeometry: vi.fn(),
    openFileAsDocument: vi.fn(),
    getWorkingCopyBackingEntry: vi.fn(),
    addRecentInputs: vi.fn(async (..._args: unknown[]) => undefined),
    findKeptOriginal: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('fs', () => ({
    existsSync: () => true,
}));
vi.mock('fs/promises', () => ({
    stat: vi.fn(async () => ({size: MAX_DOCUMENT_ALLOCATION_BYTES + 1})),
}));
vi.mock('@electron/resources/jobBroker', async (importOriginal) => {
    const actual = await importOriginal<typeof TJobBrokerModule>();
    return {
        ...actual,
        mainJobBroker: {
            acquire: (request: TJobBrokerModule.IJobBrokerRequest) => mocks.broker.current!.acquire(request),
            run: <T>(request: TJobBrokerModule.IJobBrokerRequest, work: (context: TJobBrokerModule.IJobBrokerRunContext) => Promise<T>) =>
                mocks.broker.current!.run(request, work),
        },
    };
});
vi.mock('@electron/features/documents/main/documentWorkingCopyHandlers', () => ({
    createDocumentFromFile: vi.fn(),
    openFileAsDocument: (...args: unknown[]) => mocks.openFileAsDocument(...args),
}));
vi.mock('@electron/file-access/documentStore', () => ({
    cleanupWorkingCopy: vi.fn(async () => undefined),
    documentRevisionToken: () => 'rev-1',
    getWorkingCopyBackingEntry: (...args: unknown[]) => mocks.getWorkingCopyBackingEntry(...args),
    runWithWorkingCopyReadBacking: (_ref: string, read: (path: string) => Promise<unknown>) => read('/tmp/large-book.pdf'),
}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({
    allowOpenPaths: vi.fn(),
    requireOpenPath: (path: string) => path,
}));
vi.mock('@electron/features/documents/main/addRecentInputs.service', () => ({
    addRecentInputs: (...args: unknown[]) => mocks.addRecentInputs(...args),
}));
vi.mock('@electron/utils/normalizeExistingPath', () => ({
    normalizeExistingPath: (path: string) => path,
}));
vi.mock('@electron/utils/pathValidator', () => ({
    isReservedTempPath: () => false,
}));
vi.mock('@electron/operation-lifecycle/mainOperationLifecycle', () => ({
    registerMainOperation: () => ({
        id: 'op-open-1',
        signal: new AbortController().signal,
        complete: vi.fn(),
    }),
}));
vi.mock('@electron/features/scan-cleanup/public/generatedOutputs', () => ({
    isScanCleanupGeneratedOutputPath: () => false,
    touchScanCleanupGeneratedOutput: vi.fn(async () => undefined),
}));
vi.mock('@electron/file-access/keptOriginalNotices', () => ({
    findKeptOriginal: (...args: unknown[]) => mocks.findKeptOriginal(...args),
}));
vi.mock('@electron/features/documents/main/nativePdfMetadata', () => ({
    readExactPageGeometry: (...args: unknown[]) => mocks.readExactPageGeometry(...args),
    registerNativePdfSenderCleanup: () => () => undefined,
}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({
    cancelNativeCommandGroup: vi.fn(),
}));
vi.mock('@electron/utils/createLogger', () => ({
    createLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }),
}));

const {openInputPaths} = await import('@electron/features/documents/main/openInputPaths.service');

describe('openInputPaths broker admission', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const {
            JobBroker,
            MAIN_JOB_BROKER_INTERACTIVE_RESERVE,
            MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES,
            resolveMainJobBrokerCapacity,
        } = await vi.importActual<typeof TJobBrokerModule>('@electron/resources/jobBroker');
        mocks.broker.current = new JobBroker(
            resolveMainJobBrokerCapacity({
                logicalCpus: 2,
                totalRamBytes: 4 * 1024 ** 3,
                safeMode: false,
                detectedTier: 'low',
                performanceMode: 'auto',
                tier: 'low',
            }),
            {
                maxInteractiveJobResources: MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES,
                interactiveReserve: MAIN_JOB_BROKER_INTERACTIVE_RESERVE,
            },
        );
    });

    it('admits pdf-opening-geometry for oversized PDFs on a 2-core 4 GiB low-tier broker', async () => {
        const entry = {
            ref: '/tmp/working-large-book.pdf',
            openingPageGeometry: undefined as unknown,
        };
        mocks.openFileAsDocument.mockResolvedValueOnce({
            entry,
            wasEncrypted: false,
        });
        mocks.getWorkingCopyBackingEntry.mockReturnValue(entry);
        mocks.readExactPageGeometry.mockResolvedValueOnce([
            {
                pageNumber: 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 612,
                heightPoints: 792,
                rotation: 0,
                userUnit: 1,
            },
        ]);

        const result = await openInputPaths(['/tmp/large-book.pdf'], {recordRecent: false}, 7);

        expect(result).toEqual({
            kind: 'pdf',
            workingPath: '/tmp/working-large-book.pdf',
            originalPath: '/tmp/large-book.pdf',
        });
        expect(mocks.readExactPageGeometry).toHaveBeenCalledTimes(1);
        expect(entry.openingPageGeometry).toMatchObject({
            kind: 'exact',
            pageCount: 1,
        });
        expect(mocks.broker.current!.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
    });

    it('falls back without hanging when optional pdf-opening-geometry admission times out under memory pressure', async () => {
        vi.useFakeTimers();
        try {
            const MIB = 1024 * 1024;
            const {
                JobBroker,
                MAIN_JOB_BROKER_INTERACTIVE_RESERVE,
                MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES,
                resolveMainJobBrokerCapacity,
            } = await vi.importActual<typeof TJobBrokerModule>('@electron/resources/jobBroker');
            mocks.broker.current = new JobBroker(
                resolveMainJobBrokerCapacity({
                    logicalCpus: 2,
                    totalRamBytes: 4 * 1024 ** 3,
                    safeMode: false,
                    detectedTier: 'low',
                    performanceMode: 'auto',
                    tier: 'low',
                }),
                {
                    maxInteractiveJobResources: MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES,
                    interactiveReserve: MAIN_JOB_BROKER_INTERACTIVE_RESERVE,
                    // 320 MiB available -> 192 MiB idle headroom (< 256 MiB geometry, >= 64 MiB working-copy).
                    readSystemMemoryInfo: () => ({
                        totalBytes: 4 * 1024 ** 3,
                        availableBytes: 320 * MIB,
                        freeBytes: 128 * MIB,
                    }),
                    memoryPressurePollIntervalMs: 500,
                },
            );

            const entry = {
                ref: '/tmp/working-large-book.pdf',
                openingPageGeometry: undefined as unknown,
            };
            mocks.openFileAsDocument.mockResolvedValueOnce({
                entry,
                wasEncrypted: false,
            });
            mocks.getWorkingCopyBackingEntry.mockReturnValue(entry);

            const openPromise = openInputPaths(['/tmp/large-book.pdf'], {recordRecent: false}, 7);
            await vi.advanceTimersByTimeAsync(15_000);
            const result = await openPromise;

            expect(result).toEqual({
                kind: 'pdf',
                workingPath: '/tmp/working-large-book.pdf',
                originalPath: '/tmp/large-book.pdf',
            });
            expect(mocks.readExactPageGeometry).not.toHaveBeenCalled();
            expect(entry.openingPageGeometry).toBeUndefined();
            expect(mocks.broker.current!.getSnapshot()).toMatchObject({
                active: 0,
                queued: 0,
            });
        } finally {
            vi.useRealTimers();
        }
    });
});
