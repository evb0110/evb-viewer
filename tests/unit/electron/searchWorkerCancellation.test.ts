import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    const postedMessages: Array<Record<string, unknown>> = [];
    const messageHandlers = new Map<string, (message: unknown) => void>();

    return {
        postedMessages,
        messageHandlers,
        parentPort: {
            postMessage: vi.fn((message: Record<string, unknown>) => {
                postedMessages.push(message);
            }),
            on: vi.fn((event: string, handler: (message: unknown) => void) => {
                messageHandlers.set(event, handler);
            }),
        },
        stat: vi.fn(),
        loadSearchIndex: vi.fn(),
        buildSearchIndex: vi.fn(),
    };
});

vi.mock('worker_threads', () => ({
    parentPort: mocks.parentPort,
    workerData: undefined,
}));

vi.mock('fs/promises', () => ({stat: mocks.stat}));

vi.mock('@electron/features/search/indexBuilder', () => ({
    SEARCH_INDEX_SCHEMA_VERSION: 7,
    loadSearchIndex: mocks.loadSearchIndex,
    buildSearchIndex: mocks.buildSearchIndex,
}));

vi.mock('@electron/config/constants', () => ({
    EXCERPT_CONTEXT_CHARS: 32,
    SEARCH_RESULT_LIMIT: 100,
}));

vi.mock('@electron/resources/hostResourceProfile', () => ({getHostResourceProfileSnapshot: () => ({
    logicalCpus: 4,
    totalRamBytes: 16 * 1024 ** 3,
    safeMode: false,
    detectedTier: 'high',
    performanceMode: 'auto',
    tier: 'high',
})}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({debug: vi.fn()})}));

const DOCUMENT_REVISION = 'revision-token';

function createAbortError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

describe('search worker cancellation propagation', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.postedMessages.length = 0;
        mocks.messageHandlers.clear();

        mocks.stat.mockResolvedValue({ mtimeMs: 1 });
        mocks.loadSearchIndex.mockResolvedValue(null);
        mocks.buildSearchIndex.mockImplementation(
            (
                _pdfPath: string,
                _pageData: unknown[],
                options: { signal?: AbortSignal },
            ) => new Promise((_, reject) => {
                const { signal } = options;
                if (!signal) {
                    reject(new Error('Expected an abort signal'));
                    return;
                }
                if (signal.aborted) {
                    reject(createAbortError());
                    return;
                }
                signal.addEventListener('abort', () => {
                    reject(createAbortError());
                }, { once: true });
            }),
        );
    });

    it('aborts index building when cancel message is received', async () => {
        await import('@electron/features/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        expect(handleMessage).toBeTypeOf('function');

        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'req-1',
                pdfPath: '/tmp/test.pdf',
                documentRevision: DOCUMENT_REVISION,
                query: 'needle',
                pageCount: 1,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(1);
        });

        const options = mocks.buildSearchIndex.mock.calls[0]?.[2] as { signal?: AbortSignal } | undefined;
        expect(options?.signal).toBeDefined();
        expect(options?.signal?.aborted).toBe(false);

        handleMessage?.({
            type: 'cancel',
            requestId: 'req-1',
        });

        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual({
                type: 'cancelled',
                requestId: 'req-1',
            });
        });
        expect(options?.signal?.aborted).toBe(true);
    });
});
