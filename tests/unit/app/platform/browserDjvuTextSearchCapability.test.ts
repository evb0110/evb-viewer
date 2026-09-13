import type {
    IPdfSearchProgress,
    IPdfSearchResponse,
} from '@contracts/search';
import type {PdfCombineCapabilityError} from '@electron/image/pdfCombineErrors';
import type {TDocumentRef} from '@contracts/documentRef';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireRequestId} from '@contracts/shared';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    createWorker: vi.fn(),
    searchWorkerText: vi.fn(),
}));

vi.mock('@app/platform/browser-api/createDjvuWorkerFromPath', () => ({
    createDjvuWorkerFromPath: mocks.createWorker,
    searchDjvuWorkerText: mocks.searchWorkerText,
}));

const { browserDjvuTextSearchCapability } = await import(
    '@app/platform/browser-api/browserDjvuTextSearchCapability'
);

interface ISearchWorkerOptionsForTest {
    onProgress?: (progress: IPdfSearchProgress) => void;
    requestId: ReturnType<typeof requireRequestId>;
    signal: AbortSignal;
}

interface IWorkerForTest {
    source: TDocumentRef;
    terminate: ReturnType<typeof vi.fn>;
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {
        promise,
        reject,
        resolve,
    };
}

function createSearchOptions(requestId: ReturnType<typeof requireRequestId>) {
    return {
        requestId,
        pageCount: 1,
        matchCase: false,
        wholeWord: false,
        useRegex: false,
    };
}

describe('browserDjvuTextSearchCapability', () => {
    const calls: Array<{
        deferred: ReturnType<typeof createDeferred<IPdfSearchResponse>>;
        options: ISearchWorkerOptionsForTest;
        worker: IWorkerForTest;
    }> = [];

    beforeEach(() => {
        calls.length = 0;
        vi.clearAllMocks();
        mocks.createWorker.mockImplementation(async (source: TDocumentRef) => ({
            source,
            terminate: vi.fn(),
        }));
        mocks.searchWorkerText.mockImplementation((
            worker: IWorkerForTest,
            options: ISearchWorkerOptionsForTest,
        ) => {
            const deferred = createDeferred<IPdfSearchResponse>();
            calls.push({
                deferred,
                options,
                worker,
            });
            return deferred.promise;
        });
    });

    it('lets the same request ID run concurrently on different document sources and cancels all matches', async () => {
        const requestId = requireRequestId('shared-browser-search');
        const firstRun = browserDjvuTextSearchCapability.searchText(
            requireDocumentRef('browser://documents/first.djvu'),
            'needle',
            createSearchOptions(requestId),
        );
        const secondRun = browserDjvuTextSearchCapability.searchText(
            requireDocumentRef('browser://documents/second.djvu'),
            'needle',
            createSearchOptions(requestId),
        );
        await vi.waitFor(() => expect(calls).toHaveLength(2));

        expect(calls[0]!.options.signal.aborted).toBe(false);
        expect(calls[1]!.options.signal.aborted).toBe(false);
        await expect(browserDjvuTextSearchCapability.cancelTextSearch(requestId))
            .resolves.toEqual({canceled: true});
        expect(calls[0]!.options.signal.aborted).toBe(true);
        expect(calls[1]!.options.signal.aborted).toBe(true);

        const replacementRun = browserDjvuTextSearchCapability.searchText(
            requireDocumentRef('browser://documents/replacement.djvu'),
            'needle',
            createSearchOptions(requestId),
        );
        await vi.waitFor(() => expect(calls).toHaveLength(3));
        calls[0]!.deferred.resolve({
            results: [],
            truncated: false,
        });
        calls[1]!.deferred.resolve({
            results: [],
            truncated: false,
        });
        await Promise.all([
            firstRun,
            secondRun,
        ]);

        expect(calls[2]!.options.signal.aborted).toBe(false);
        await expect(browserDjvuTextSearchCapability.cancelTextSearch(requestId))
            .resolves.toEqual({canceled: true});
        expect(calls[2]!.options.signal.aborted).toBe(true);
        calls[2]!.deferred.resolve({
            results: [],
            truncated: false,
        });
        await replacementRun;
        expect(calls.map(call => call.worker.terminate.mock.calls.length)).toEqual([
            1,
            1,
            1,
        ]);
    });

    it('supersedes only the same source generation and suppresses its late progress', async () => {
        const requestId = requireRequestId('same-source-browser-search');
        const progress: IPdfSearchProgress[] = [];
        const unsubscribe = browserDjvuTextSearchCapability.onTextSearchProgress((event) => {
            progress.push(event);
        });
        try {
            const firstRun = browserDjvuTextSearchCapability.searchText(
                requireDocumentRef('browser://documents/book.djvu'),
                'first',
                createSearchOptions(requestId),
            );
            await vi.waitFor(() => expect(calls).toHaveLength(1));
            const currentRun = browserDjvuTextSearchCapability.searchText(
                requireDocumentRef('browser://documents/book.djvu'),
                'current',
                createSearchOptions(requestId),
            );
            await vi.waitFor(() => expect(calls).toHaveLength(2));

            expect(calls[0]!.options.signal.aborted).toBe(true);
            expect(calls[1]!.options.signal.aborted).toBe(false);
            calls[0]!.options.onProgress?.({
                requestId,
                processed: 99,
                total: 100,
                status: 'running',
            });
            calls[1]!.options.onProgress?.({
                requestId,
                processed: 1,
                total: 100,
                status: 'running',
            });

            calls[0]!.deferred.resolve({
                results: [],
                truncated: false,
            });
            calls[1]!.deferred.resolve({
                results: [],
                truncated: false,
            });
            await Promise.all([
                firstRun,
                currentRun,
            ]);
            expect(progress.map(event => event.processed)).toEqual([1]);
        } finally {
            unsubscribe();
        }
    });

    it('refuses an absolute path without a native DjVu bridge before creating a worker', async () => {
        const electronApi = createElectronPlatformApiFixture();
        Reflect.deleteProperty(electronApi.djvu, 'getInfo');
        vi.stubGlobal('window', {electronAPI: electronApi});
        mocks.createWorker.mockRejectedValue(new Error('browser DjVu worker must not be created'));

        await expect(browserDjvuTextSearchCapability.searchText(
            requireDocumentRef('/tmp/native.djvu'),
            'needle',
            createSearchOptions(requireRequestId('native-bridge-missing')),
        )).rejects.toMatchObject({
            code: 'native-unavailable',
            name: 'PdfCombineCapabilityError',
            operation: 'djvu-text-search',
        } satisfies Partial<PdfCombineCapabilityError>);

        expect(mocks.createWorker).not.toHaveBeenCalled();
    });
});
