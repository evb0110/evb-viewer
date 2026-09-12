import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { SearchWorkerService } from '@electron/features/search/main/searchWorkerService';
import type { ISearchResourcePolicy } from '@electron/features/search/main/searchResourcePolicy';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {SEARCH_REGEX_MAX_EXECUTION_MS} from '@contracts/search';
import {requireRequestId} from '@contracts/shared';

const workerMocks = vi.hoisted(() => ({instances: [] as Array<{
    options: {workerData?: unknown};
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    emit: (event: string, payload: unknown) => void;
}>}));

const electronMocks = vi.hoisted(() => ({send: vi.fn()}));

vi.mock('electron', () => ({webContents: {fromId: vi.fn(() => ({
    isDestroyed: () => false,
    send: electronMocks.send,
}))}}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
})}));

vi.mock('worker_threads', async () => {
    const { EventEmitter } = await import('node:events');

    class MockWorker extends EventEmitter {
        postMessage = vi.fn();
        terminate = vi.fn(async () => undefined);

        constructor(_path: string, options: {workerData?: unknown} = {}) {
            super();
            workerMocks.instances.push({
                options,
                postMessage: this.postMessage,
                terminate: this.terminate,
                emit: (event, payload) => void this.emit(event, payload),
            });
        }
    }

    return { Worker: MockWorker };
});

const EMPTY_SEARCH_RESULT = {
    results: [],
    truncated: false,
};

async function createSearchService(overrides: Partial<ISearchResourcePolicy> = {}) {
    const { SearchWorkerService } = await import('@electron/features/search/main/searchWorkerService');
    return new SearchWorkerService(
        () => '/tmp/search-worker.js',
        createSearchResourcePolicy(overrides),
    );
}

function createSearchResourcePolicy(
    overrides: Partial<ISearchResourcePolicy> = {},
): ISearchResourcePolicy {
    return {
        maxActiveSenderWorkers: 2,
        workerIdleTtlMs: 30_000,
        nativeServiceIdleTimeoutMs: 5 * 60_000,
        workerResourcePolicy: {
            indexCacheMaxEntries: 2,
            indexCacheTtlMs: 2 * 60_000,
            maxPageTextBytes: 2 * 1024 * 1024,
            maxTotalTextBytes: 96 * 1024 * 1024,
        },
        ...overrides,
    };
}

function createSender(id: number): Electron.WebContents {
    const sender: Partial<Electron.WebContents> = {
        id,
        isDestroyed: () => false,
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
        send: electronMocks.send,
    };
    return sender as Electron.WebContents;
}

function emitWorkerComplete(workerIndex: number, requestId: string) {
    workerMocks.instances[workerIndex]?.emit('message', {
        type: 'complete',
        requestId,
        response: {
            results: [],
            truncated: false,
        },
    });
}

function emitWorkerCancelled(workerIndex: number, requestId: string) {
    workerMocks.instances[workerIndex]?.emit('message', {
        type: 'cancelled',
        requestId,
    });
}

function dispatchSearch(
    service: SearchWorkerService,
    sender: Electron.WebContents,
    requestId: string,
    options: {
        pdfPath?: string;
        senderId?: number;
        warmup?: boolean;
        useRegex?: boolean;
    } = {},
) {
    return service.dispatchSearchRequest(
        {
            sender,
            senderId: options.senderId ?? sender.id,
        },
        {
            resolvedPdfPath: options.pdfPath ?? '/tmp/work.pdf',
            documentRevision: requireDocumentRevisionToken('revision-token'),
            query: options.warmup ? '' : 'term',
            requestId: requireRequestId(requestId),
            requestIdPrefix: 'search',
            ...(options.warmup === undefined ? {} : {warmup: options.warmup}),
            ...(options.useRegex === undefined ? {} : {useRegex: options.useRegex}),
        },
    );
}

describe('SearchWorkerService', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        workerMocks.instances.splice(0, workerMocks.instances.length);
        delete process.env.EVB_SEARCH_CANCEL_ACK_TIMEOUT_MS;
        delete process.env.EVB_SEARCH_WORKER_TERMINATE_TIMEOUT_MS;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('settles path cancellation only after the worker acknowledges cancellation', async () => {
        const service = await createSearchService();
        const sender = createSender(42);

        const searchPromise = dispatchSearch(service, sender, 'search-1', {senderId: 42});
        const settled = vi.fn();
        void searchPromise.then(settled, settled);

        expect(workerMocks.instances[0]?.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'search'}));
        expect(service.cancelRequestsForPdfPath('/tmp/other.pdf', 'revision changed')).toBe(0);
        expect(service.cancelRequestsForPdfPath('/tmp/work.pdf', 'revision changed')).toBe(1);
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();

        emitWorkerCancelled(0, 'search-1');

        await expect(searchPromise).resolves.toEqual({
            results: [],
            truncated: false,
            canceled: true,
        });
        expect(workerMocks.instances[0]?.postMessage).toHaveBeenCalledWith({
            type: 'cancel',
            requestId: 'search-1',
        });

        const cleanupPromise = service.cleanupAll('test cleanup');
        workerMocks.instances[0]?.emit('message', {type: 'shutdown-complete'});
        workerMocks.instances[0]?.emit('exit', 0);
        await cleanupPromise;
    });

    it('passes the resolved worker resource and native idle policies in workerData', async () => {
        const resourcePolicy = createSearchResourcePolicy({
            maxActiveSenderWorkers: 1,
            nativeServiceIdleTimeoutMs: 60_000,
            workerResourcePolicy: {
                indexCacheMaxEntries: 1,
                indexCacheTtlMs: 120_000,
                maxPageTextBytes: 2 * 1024 * 1024,
                maxTotalTextBytes: 48 * 1024 * 1024,
            },
        });
        const { SearchWorkerService } = await import('@electron/features/search/main/searchWorkerService');
        const service = new SearchWorkerService(
            () => '/tmp/search-worker.js',
            resourcePolicy,
        );

        const searchPromise = dispatchSearch(service, createSender(42), 'search-1');

        expect(workerMocks.instances[0]?.options.workerData).toEqual({
            nativeServiceIdleTimeoutMs: 60_000,
            resourcePolicy: resourcePolicy.workerResourcePolicy,
        });
        emitWorkerComplete(0, 'search-1');
        await expect(searchPromise).resolves.toEqual(EMPTY_SEARCH_RESULT);
    });

    it('settles cancellation through a bounded fallback when the worker does not acknowledge it', async () => {
        vi.useFakeTimers();
        process.env.EVB_SEARCH_CANCEL_ACK_TIMEOUT_MS = '100';
        const service = await createSearchService();
        const sender = createSender(42);

        const searchPromise = dispatchSearch(service, sender, 'search-1', {senderId: 42});
        const settled = vi.fn();
        void searchPromise.then(settled, settled);

        expect(service.cancel({
            sender,
            senderId: 42,
        }, requireRequestId('search-1'))).toEqual({canceled: true});
        await vi.advanceTimersByTimeAsync(99);
        expect(settled).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);

        await expect(searchPromise).resolves.toEqual({
            results: [],
            truncated: false,
            canceled: true,
        });
    });

    it('rejects a timed-out request without retiring its sender worker', async () => {
        vi.useFakeTimers();
        process.env.EVB_SEARCH_CANCEL_ACK_TIMEOUT_MS = '500';
        process.env.EVB_SEARCH_WORKER_TERMINATE_TIMEOUT_MS = '1000';
        const service = await createSearchService({maxActiveSenderWorkers: 1});
        const sender = createSender(42);
        const {requestTimeoutMs} = service.getConfig();

        const timedOutSearch = dispatchSearch(service, sender, 'regex-timeout', {
            senderId: 42,
            useRegex: true,
        });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1);
        const survivingSearch = dispatchSearch(service, sender, 'surviving-search', {
            senderId: 42,
            warmup: true,
        });
        let survivingSearchSettled = false;
        void survivingSearch.then(
            () => { survivingSearchSettled = true; },
            () => { survivingSearchSettled = true; },
        );
        let timedOutSettled = false;
        void timedOutSearch.then(() => { timedOutSettled = true; }, () => { timedOutSettled = true; });

        await vi.advanceTimersByTimeAsync(requestTimeoutMs - 2);
        expect(timedOutSettled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await expect(timedOutSearch).rejects.toMatchObject({
            code: 'SEARCH_TIMEOUT',
            errorEnvelope: {
                code: 'SEARCH_TIMEOUT',
                retryable: true,
            },
        });
        expect(workerMocks.instances[0]?.postMessage).toHaveBeenCalledWith({
            type: 'cancel',
            requestId: 'regex-timeout',
        });
        expect(workerMocks.instances[0]?.postMessage).not.toHaveBeenCalledWith({
            type: 'shutdown',
            reason: 'Search request regex-timeout timed out',
        });
        expect(workerMocks.instances[0]?.terminate).not.toHaveBeenCalled();
        expect(survivingSearchSettled).toBe(false);
        expect(workerMocks.instances).toHaveLength(1);

        emitWorkerComplete(0, 'regex-timeout');
        emitWorkerComplete(0, 'surviving-search');
        await expect(survivingSearch).resolves.toEqual(EMPTY_SEARCH_RESULT);
        expect(survivingSearchSettled).toBe(true);

        const cleanupPromise = service.cleanupAll('test cleanup');
        expect(workerMocks.instances[0]?.postMessage).toHaveBeenCalledWith({
            type: 'shutdown',
            reason: 'test cleanup',
        });
        workerMocks.instances[0]?.emit('message', {type: 'shutdown-complete'});
        workerMocks.instances[0]?.emit('exit', 0);
        await expect(cleanupPromise).resolves.toBeUndefined();
        expect(workerMocks.instances[0]?.terminate).not.toHaveBeenCalled();
    });

    it('does not spend the regex matching budget before the worker starts', async () => {
        vi.useFakeTimers();
        const service = await createSearchService();
        const sender = createSender(42);
        const searchPromise = dispatchSearch(service, sender, 'regex-cold-start', {
            senderId: 42,
            useRegex: true,
        });
        let settled = false;
        void searchPromise.then(() => { settled = true; }, () => { settled = true; });
        await Promise.resolve();

        await vi.advanceTimersByTimeAsync(SEARCH_REGEX_MAX_EXECUTION_MS + 1);
        expect(settled).toBe(false);
        expect(workerMocks.instances[0]?.postMessage).toHaveBeenCalledWith({
            type: 'search',
            payload: expect.objectContaining({
                useRegex: true,
                regexBudgetMs: SEARCH_REGEX_MAX_EXECUTION_MS,
            }),
        });

        emitWorkerComplete(0, 'regex-cold-start');
        await expect(searchPromise).resolves.toEqual(EMPTY_SEARCH_RESULT);
    });

    it('does not finish recoverable cleanup before worker and native daemon shutdown settle', async () => {
        const service = await createSearchService();
        const sender = createSender(42);

        const searchPromise = dispatchSearch(service, sender, 'search-1', {senderId: 42});
        const cleanupPromise = service.cleanupAll('test recovery');
        const cleanupSettled = vi.fn();
        void cleanupPromise.then(cleanupSettled, cleanupSettled);

        expect(workerMocks.instances[0]?.postMessage).toHaveBeenCalledWith({
            type: 'shutdown',
            reason: 'test recovery',
        });
        expect(workerMocks.instances[0]?.terminate).not.toHaveBeenCalled();
        await expect(searchPromise).rejects.toThrow('test recovery');
        await Promise.resolve();
        expect(cleanupSettled).not.toHaveBeenCalled();

        workerMocks.instances[0]?.emit('message', {type: 'shutdown-complete'});
        workerMocks.instances[0]?.emit('exit', 0);

        await expect(cleanupPromise).resolves.toBeUndefined();
        expect(cleanupSettled).toHaveBeenCalledOnce();
        expect(workerMocks.instances[0]?.terminate).not.toHaveBeenCalled();
    });

    it('asks active workers to shut down and awaits cooperative exit', async () => {
        const service = await createSearchService();
        const sender = createSender(42);

        const searchPromise = dispatchSearch(service, sender, 'search-1', {senderId: 42});
        const shutdownPromise = service.shutdown('app shutdown');
        await expect(searchPromise).rejects.toThrow('app shutdown');
        expect(workerMocks.instances[0]?.postMessage).toHaveBeenCalledWith({
            type: 'shutdown',
            reason: 'app shutdown',
        });
        expect(workerMocks.instances[0]?.terminate).not.toHaveBeenCalled();

        workerMocks.instances[0]?.emit('message', {type: 'shutdown-complete'});
        workerMocks.instances[0]?.emit('exit', 0);

        await expect(shutdownPromise).resolves.toBeUndefined();
        expect(workerMocks.instances[0]?.terminate).not.toHaveBeenCalled();
    });

    it('asks idle workers to stop before falling back to forced termination', async () => {
        vi.useFakeTimers();
        process.env.EVB_SEARCH_WORKER_TERMINATE_TIMEOUT_MS = '1000';
        const service = await createSearchService();
        const sender = createSender(42);
        const searchPromise = dispatchSearch(service, sender, 'search-1', {senderId: 42});
        emitWorkerComplete(0, 'search-1');
        await expect(searchPromise).resolves.toEqual(EMPTY_SEARCH_RESULT);

        const shutdownPromise = service.shutdown('app shutdown');
        const shutdownResult = shutdownPromise.catch((error: unknown) => error);

        expect(workerMocks.instances[0]?.postMessage).toHaveBeenCalledWith({
            type: 'shutdown',
            reason: 'app shutdown',
        });
        workerMocks.instances[0]?.emit('message', {type: 'shutdown-complete'});
        await vi.advanceTimersByTimeAsync(499);
        expect(workerMocks.instances[0]?.terminate).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);

        await expect(shutdownResult).resolves.toMatchObject({message: expect.stringContaining('did not exit')});
        expect(workerMocks.instances[0]?.terminate).toHaveBeenCalledOnce();
    });

    it('rejects worker exit without native daemon shutdown acknowledgement', async () => {
        const service = await createSearchService();
        const searchPromise = dispatchSearch(service, createSender(42), 'search-1', {senderId: 42});
        emitWorkerComplete(0, 'search-1');
        await expect(searchPromise).resolves.toEqual(EMPTY_SEARCH_RESULT);

        const shutdownPromise = service.shutdown('app shutdown');
        workerMocks.instances[0]?.emit('exit', 0);

        await expect(shutdownPromise).rejects.toThrow('without confirming native daemon shutdown');
    });

    it('keeps cooperative and forced worker termination inside one total deadline', async () => {
        vi.useFakeTimers();
        process.env.EVB_SEARCH_WORKER_TERMINATE_TIMEOUT_MS = '1000';
        const service = await createSearchService();
        const searchPromise = dispatchSearch(service, createSender(42), 'search-1', {senderId: 42});
        emitWorkerComplete(0, 'search-1');
        await expect(searchPromise).resolves.toEqual(EMPTY_SEARCH_RESULT);
        workerMocks.instances[0]?.terminate.mockReturnValueOnce(new Promise(() => undefined));
        const shutdownPromise = service.shutdown('app shutdown');
        const settled = vi.fn();
        void shutdownPromise.then(settled, settled);

        await vi.advanceTimersByTimeAsync(499);
        expect(workerMocks.instances[0]?.terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(workerMocks.instances[0]?.terminate).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(499);
        expect(settled).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);

        await expect(shutdownPromise).rejects.toThrow('Search worker shutdown failed');
    });

    it('surfaces native daemon shutdown failures from a worker', async () => {
        const service = await createSearchService();
        const searchPromise = dispatchSearch(service, createSender(42), 'search-1', {senderId: 42});
        emitWorkerComplete(0, 'search-1');
        await expect(searchPromise).resolves.toEqual(EMPTY_SEARCH_RESULT);

        const shutdownPromise = service.shutdown('app shutdown');
        workerMocks.instances[0]?.emit('message', {
            type: 'shutdown-complete',
            error: 'Persistent native search process tree 4242 did not stop',
        });
        workerMocks.instances[0]?.emit('exit', 0);

        await expect(shutdownPromise).rejects.toThrow('Search worker shutdown failed');
    });

    it('preserves a native daemon shutdown failure across forced worker termination', async () => {
        vi.useFakeTimers();
        process.env.EVB_SEARCH_WORKER_TERMINATE_TIMEOUT_MS = '1000';
        const service = await createSearchService();
        const searchPromise = dispatchSearch(service, createSender(42), 'search-1', {senderId: 42});
        emitWorkerComplete(0, 'search-1');
        await expect(searchPromise).resolves.toEqual(EMPTY_SEARCH_RESULT);

        const shutdownPromise = service.shutdown('app shutdown');
        workerMocks.instances[0]?.emit('message', {
            type: 'shutdown-complete',
            error: 'Persistent native search process tree 4242 did not stop',
        });
        const shutdownExpectation = expect(shutdownPromise)
            .rejects.toThrow('Persistent native search process tree 4242 did not stop');
        await vi.advanceTimersByTimeAsync(500);

        await shutdownExpectation;
        expect(workerMocks.instances[0]?.terminate).toHaveBeenCalledOnce();
    });

    it('surfaces native daemon failures during recoverable cleanup', async () => {
        const service = await createSearchService();
        const searchPromise = dispatchSearch(service, createSender(42), 'search-1', {senderId: 42});
        emitWorkerComplete(0, 'search-1');
        await expect(searchPromise).resolves.toEqual(EMPTY_SEARCH_RESULT);

        const cleanupPromise = service.cleanupAll('test recovery');
        workerMocks.instances[0]?.emit('message', {
            type: 'shutdown-complete',
            error: 'Persistent native search process tree 4242 did not stop',
        });
        workerMocks.instances[0]?.emit('exit', 0);

        await expect(cleanupPromise).rejects.toThrow('Persistent native search process tree 4242 did not stop');
    });

    it('shares one cleanup flight and termination failure with concurrent terminal shutdown', async () => {
        vi.useFakeTimers();
        process.env.EVB_SEARCH_WORKER_TERMINATE_TIMEOUT_MS = '1000';
        const service = await createSearchService();
        const firstSearch = dispatchSearch(service, createSender(41), 'search-1', {senderId: 41});
        const secondSearch = dispatchSearch(service, createSender(42), 'search-2', {senderId: 42});
        emitWorkerComplete(0, 'search-1');
        emitWorkerComplete(1, 'search-2');
        await expect(firstSearch).resolves.toEqual(EMPTY_SEARCH_RESULT);
        await expect(secondSearch).resolves.toEqual(EMPTY_SEARCH_RESULT);

        const firstTerminationError = new Error('first worker termination failed');
        workerMocks.instances[0]?.terminate.mockRejectedValueOnce(firstTerminationError);
        let finishSecondTermination!: () => void;
        workerMocks.instances[1]?.terminate.mockReturnValueOnce(new Promise<void>(resolve => {
            finishSecondTermination = resolve;
        }));
        const cleanupPromise = service.cleanupAll('test recovery');
        const cleanupResult = cleanupPromise.catch((error: unknown) => error);
        workerMocks.instances[0]?.emit('message', {type: 'shutdown-complete'});
        workerMocks.instances[1]?.emit('message', {type: 'shutdown-complete'});
        const lateSearch = dispatchSearch(service, createSender(43), 'search-3', {senderId: 43});
        const lateSearchResult = lateSearch.catch((error: unknown) => error);
        await Promise.resolve();

        expect(workerMocks.instances).toHaveLength(2);
        await expect(lateSearchResult).resolves.toMatchObject({message: 'Search worker service is cleaning up'});

        await vi.advanceTimersByTimeAsync(500);

        expect(workerMocks.instances[0]?.terminate).toHaveBeenCalledOnce();
        expect(workerMocks.instances[1]?.terminate).toHaveBeenCalledOnce();
        const shutdownPromise = service.shutdown('app shutdown');
        const shutdownResult = shutdownPromise.catch((error: unknown) => error);
        expect(shutdownPromise).toBe(cleanupPromise);

        finishSecondTermination();
        workerMocks.instances[0]?.emit('exit', 0);
        workerMocks.instances[1]?.emit('exit', 0);
        const cleanupError = await cleanupResult;
        const shutdownError = await shutdownResult;
        expect(cleanupError).toBe(shutdownError);
        expect(cleanupError).toBeInstanceOf(AggregateError);
        expect(cleanupError).toMatchObject({errors: [firstTerminationError]});
    });

    it('does not let stale worker errors clean up a newer sender state', async () => {
        const service = await createSearchService();
        const sender = createSender(42);

        const firstSearch = dispatchSearch(service, sender, 'search-1', {senderId: 42});
        emitWorkerComplete(0, 'search-1');
        await expect(firstSearch).resolves.toEqual(EMPTY_SEARCH_RESULT);

        const cleanupPromise = service.cleanupAll('retire old worker');
        workerMocks.instances[0]?.emit('message', {type: 'shutdown-complete'});
        workerMocks.instances[0]?.emit('exit', 0);
        await cleanupPromise;
        const secondSearch = dispatchSearch(service, sender, 'search-2', {senderId: 42});
        expect(workerMocks.instances).toHaveLength(2);

        workerMocks.instances[0]?.emit('error', new Error('late old worker error'));
        emitWorkerComplete(1, 'search-2');

        await expect(secondSearch).resolves.toEqual(EMPTY_SEARCH_RESULT);
    });

    it('does not admit a replacement while retired worker ownership is unresolved', async () => {
        const service = await createSearchService({maxActiveSenderWorkers: 1});
        const sender = createSender(42);

        const failedSearch = dispatchSearch(service, sender, 'search-1', {senderId: 42});
        workerMocks.instances[0]?.emit('error', new Error('worker failed'));
        await expect(failedSearch).rejects.toThrow('worker failed');

        workerMocks.instances[0]?.emit('message', {
            type: 'shutdown-complete',
            error: 'native daemon ownership unresolved',
        });
        workerMocks.instances[0]?.emit('exit', 1);

        await expect(dispatchSearch(service, sender, 'search-2', {senderId: 42}))
            .rejects.toMatchObject({code: 'SEARCH_WORKER_LIMIT'});
        expect(workerMocks.instances).toHaveLength(1);

        const shutdownPromise = service.shutdown('test cleanup');
        await expect(shutdownPromise).rejects.toThrow('Search worker shutdown failed');
    });

    it('returns an existing warmup singleflight before allocating sender worker state', async () => {
        const service = await createSearchService();
        const firstSender = createSender(41);
        const secondSender = createSender(42);

        const firstWarmup = dispatchSearch(service, firstSender, 'warm-1', {
            senderId: 41,
            warmup: true,
        });
        const secondWarmup = dispatchSearch(service, secondSender, 'warm-2', {
            senderId: 42,
            warmup: true,
        });

        expect(secondWarmup).toBe(firstWarmup);
        expect(workerMocks.instances).toHaveLength(1);
        expect(secondSender.once).not.toHaveBeenCalled();

        emitWorkerComplete(0, 'warm-1');
        await expect(firstWarmup).resolves.toEqual(EMPTY_SEARCH_RESULT);
        await expect(secondWarmup).resolves.toEqual(EMPTY_SEARCH_RESULT);
    });

    it('does not create unhandled rejections when warmup cleanup follows a worker error', async () => {
        const unhandledRejection = vi.fn();
        process.once('unhandledRejection', unhandledRejection);
        try {
            const service = await createSearchService();
            const sender = createSender(42);

            const warmupPromise = dispatchSearch(service, sender, 'warm-1', {
                senderId: 42,
                warmup: true,
            });
            workerMocks.instances[0]?.emit('message', {
                type: 'error',
                requestId: 'warm-1',
                error: 'warmup failed',
            });

            await expect(warmupPromise).rejects.toThrow('warmup failed');
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(unhandledRejection).not.toHaveBeenCalled();
        } finally {
            process.removeListener('unhandledRejection', unhandledRejection);
        }
    });

    it('relays streamed result delta start indexes from worker progress', async () => {
        const { SEARCH_PLATFORM_FEATURE } = await import('@contracts/searchPlatformFeature');
        const service = await createSearchService();
        const sender = createSender(42);

        const searchPromise = dispatchSearch(service, sender, 'search-1', {senderId: 42});
        workerMocks.instances[0]?.emit('message', {
            type: 'progress',
            requestId: 'search-1',
            processed: 4,
            total: 10,
            resultsStartIndex: 1,
            results: [{
                pageNumber: 2,
                pageMatchIndex: 0,
                matchIndex: 1,
                startOffset: 5,
                endOffset: 11,
                excerpt: {
                    prefix: false,
                    suffix: false,
                    before: '',
                    match: 'needle',
                    after: '',
                },
            }],
            truncated: false,
        });

        await vi.waitFor(() => {
            expect(electronMocks.send).toHaveBeenCalledWith(
                SEARCH_PLATFORM_FEATURE.eventChannels.onProgress,
                expect.objectContaining({
                    requestId: 'search-1',
                    resultsStartIndex: 1,
                    results: [expect.objectContaining({matchIndex: 1})],
                }),
            );
        });

        emitWorkerComplete(0, 'search-1');
        await expect(searchPromise).resolves.toEqual(EMPTY_SEARCH_RESULT);
    });

    it('leaves renderer lifecycle ownership with the registry when re-keying an idle worker', async () => {
        const { SearchWorkerService } = await import('@electron/features/search/main/searchWorkerService');
        const service = new SearchWorkerService(
            () => '/tmp/search-worker.js',
            createSearchResourcePolicy({maxActiveSenderWorkers: 1}),
        );
        const firstSender = createSender(41);
        const secondSender = createSender(42);

        const firstSearch = dispatchSearch(service, firstSender, 'search-1', {senderId: 41});
        emitWorkerComplete(0, 'search-1');
        await expect(firstSearch).resolves.toEqual(EMPTY_SEARCH_RESULT);

        const secondSearch = dispatchSearch(service, secondSender, 'search-2', {
            senderId: 42,
            pdfPath: '/tmp/other.pdf',
        });

        expect(workerMocks.instances).toHaveLength(1);
        expect(workerMocks.instances[0]?.postMessage).toHaveBeenCalledWith({type: 'reset-state'});
        expect(firstSender.removeListener).not.toHaveBeenCalled();

        emitWorkerComplete(0, 'search-2');
        await expect(secondSearch).resolves.toEqual(EMPTY_SEARCH_RESULT);
    });

    it('admits only one active sender under the low-tier policy', async () => {
        const { SearchWorkerService } = await import('@electron/features/search/main/searchWorkerService');
        const service = new SearchWorkerService(
            () => '/tmp/search-worker.js',
            createSearchResourcePolicy({maxActiveSenderWorkers: 1}),
        );
        const firstSearch = dispatchSearch(service, createSender(41), 'search-1', {senderId: 41});

        await expect(dispatchSearch(
            service,
            createSender(42),
            'search-2',
            {senderId: 42},
        )).rejects.toThrow('Search worker limit reached (1 active senders)');
        expect(workerMocks.instances).toHaveLength(1);

        emitWorkerComplete(0, 'search-1');
        await expect(firstSearch).resolves.toEqual(EMPTY_SEARCH_RESULT);
    });
});
