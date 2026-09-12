import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';

import type {TSearchErrorCode} from '@contracts/search';
import type { TRegisteredHandler } from '@tests/unit/electron/helpers/ipcRegistryHarness';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';


interface ISearchResourceLimitMockWorkerRecord {
    onHandlers: Map<string, Array<(arg: unknown) => void>>;
    onceHandlers: Map<string, Array<(arg: unknown) => void>>;
    postMessageCalls: Array<Record<string, unknown>>;
    terminate: ReturnType<typeof vi.fn<() => Promise<number>>>;
    workerData: unknown;
}

const mocks = vi.hoisted(() => ({
    handlers: new Map<string, TRegisteredHandler>(),
    workerRecords: [] as ISearchResourceLimitMockWorkerRecord[],
    workerCtor: vi.fn(),
    resolveAllowedReadPath: vi.fn(),
    findWorkingCopyPathByOriginalPath: vi.fn(),
    getWorkingCopyRevision: vi.fn(),
    appOn: vi.fn(),
    webContentsById: new Map<number, {
        isDestroyed: () => boolean;
        send: ReturnType<typeof vi.fn>
    }>(),
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
    autoCompleteSearch: true,
    existsSync: vi.fn(),
    resourceTier: 'medium' as 'low' | 'medium' | 'high',
    registerMainOperation: vi.fn(),
    mainOperationRecords: [] as Array<{
        registration: Record<string, unknown>;
        controller: AbortController;
        complete: ReturnType<typeof vi.fn>;
    }>,
}));

function emitWorkerEvent(
    workerIndex: number,
    event: string,
    payload: unknown,
) {
    const record = mocks.workerRecords[workerIndex];
    if (!record) {
        throw new Error(`Worker record ${workerIndex} not found`);
    }

    for (const handler of record.onHandlers.get(event) ?? []) {
        handler(payload);
    }
    const onceHandlers = record.onceHandlers.get(event) ?? [];
    record.onceHandlers.delete(event);
    for (const handler of onceHandlers) {
        handler(payload);
    }
}

function emitWorkerComplete(
    workerIndex: number,
    requestId: string,
) {
    emitWorkerEvent(workerIndex, 'message', {
        type: 'complete',
        requestId,
        response: {
            results: [],
            truncated: false,
        },
    });
}

function buildSearchMatch(overrides: Record<string, unknown> = {}) {
    return {
        pageNumber: 1,
        pageMatchIndex: 0,
        matchIndex: 0,
        startOffset: 2,
        endOffset: 6,
        excerpt: {
            prefix: false,
            suffix: false,
            before: '',
            match: 'test',
            after: '',
        },
        ...overrides,
    };
}

function emitWorkerCompleteWithResults(
    workerIndex: number,
    requestId: string,
    results: Array<Record<string, unknown>>,
) {
    emitWorkerEvent(workerIndex, 'message', {
        type: 'complete',
        requestId,
        response: {
            results,
            truncated: false,
        },
    });
}

function emitWorkerProgressWithResults(
    workerIndex: number,
    requestId: string,
    results: Array<Record<string, unknown>>,
) {
    emitWorkerEvent(workerIndex, 'message', {
        type: 'progress',
        requestId,
        processed: 1,
        total: 2,
        results,
        truncated: false,
    });
}

async function expectTypedSearchFailure(
    searchPromise: Promise<unknown>,
    expected: {
        code: TSearchErrorCode;
        message: string;
        retryable: boolean;
    },
) {
    await expect(searchPromise).rejects.toMatchObject({
        name: 'SearchIpcError',
        code: expected.code,
        errorEnvelope: {
            code: expected.code,
            message: expected.message,
            retryable: expected.retryable,
            timestamp: expect.any(Number),
        },
    });
}

function expectSearchWorkerProtocolFailure(
    searchPromise: Promise<unknown>,
    requestId: string,
) {
    return expectTypedSearchFailure(searchPromise, {
        code: 'SEARCH_WORKER_PROTOCOL',
        message: `Search worker sent malformed message for request "${requestId}"`,
        retryable: false,
    });
}

vi.mock('worker_threads', () => ({Worker: class {
    private record: ISearchResourceLimitMockWorkerRecord;

    constructor(workerPath: string, options: {workerData?: unknown} = {}) {
        this.record = {
            onHandlers: new Map(),
            onceHandlers: new Map(),
            postMessageCalls: [],
            terminate: vi.fn(async () => 0),
            workerData: options.workerData,
        };
        mocks.workerCtor(workerPath, options);
        mocks.workerRecords.push(this.record);
    }

    on(event: string, handler: (arg: unknown) => void) {
        const handlers = this.record.onHandlers.get(event) ?? [];
        handlers.push(handler);
        this.record.onHandlers.set(event, handlers);
        return this;
    }

    once(event: string, handler: (arg: unknown) => void) {
        const handlers = this.record.onceHandlers.get(event) ?? [];
        handlers.push(handler);
        this.record.onceHandlers.set(event, handlers);
        return this;
    }

    removeListener(event: string, handler: (arg: unknown) => void) {
        this.record.onHandlers.set(event, (this.record.onHandlers.get(event) ?? []).filter(item => item !== handler));
        this.record.onceHandlers.set(event, (this.record.onceHandlers.get(event) ?? []).filter(item => item !== handler));
        return this;
    }

    postMessage(message: Record<string, unknown>) {
        this.record.postMessageCalls.push(message);

        if (mocks.autoCompleteSearch && message.type === 'search') {
            const payload = message.payload as { requestId?: string } | undefined;
            const requestId = payload?.requestId;
            if (typeof requestId === 'string' && requestId.length > 0) {
                void Promise.resolve().then(() => {
                    emitWorkerComplete(mocks.workerRecords.indexOf(this.record), requestId);
                });
            }
        }
    }

    terminate() {
        return this.record.terminate();
    }
}}));

vi.mock('electron', () => ({
    app: {
        isPackaged: false,
        on: (...args: unknown[]) => mocks.appOn(...args),
    },
    ipcMain: {handle: (channel: string, handler: TRegisteredHandler) => {
        mocks.handlers.set(channel, handler);
    }},
    webContents: {fromId: (senderId: number) => mocks.webContentsById.get(senderId) ?? null},
}));

vi.mock('@electron/platform-ipc/trustedIpcSender', () => ({isTrustedIpcInvokeSender: () => true}));
vi.mock('@electron/utils/pathValidator', () => ({resolveAllowedReadPath: mocks.resolveAllowedReadPath}));
vi.mock('@electron/file-access/workingCopyStore', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    findWorkingCopyPathByOriginalPath: mocks.findWorkingCopyPathByOriginalPath,
    normalizePathForLookup: (path: string) => path.trim(),
}));
vi.mock('@electron/file-access/documentRevisionStore', () => ({getWorkingCopyRevision: (...args: unknown[]) => mocks.getWorkingCopyRevision(...args)}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));
vi.mock('fs', () => ({existsSync: (...args: unknown[]) => mocks.existsSync(...args)}));
vi.mock('@electron/resources/hostResourceProfile', () => ({getHostResourceProfileSnapshot: () => ({
    logicalCpus: 4,
    totalRamBytes: 16 * 1024 ** 3,
    safeMode: false,
    detectedTier: mocks.resourceTier,
    performanceMode: 'auto',
    tier: mocks.resourceTier,
})}));
vi.mock('@electron/operation-lifecycle/mainOperationLifecycle', () => ({registerMainOperation: (...args: unknown[]) => mocks.registerMainOperation(...args)}));

function createInvokeEvent(senderId: number) {
    const send = vi.fn();
    const sender = {
        id: senderId,
        isDestroyed: () => false,
        once: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
        send,
    };
    mocks.webContentsById.set(senderId, {
        isDestroyed: () => false,
        send,
    });
    return {sender};
}

function getSearchHandler() {
    const handler = mocks.handlers.get('pdf:search');
    if (!handler) {
        throw new Error('pdf:search handler is not registered');
    }
    return handler;
}

function getCancelHandler() {
    const handler = mocks.handlers.get('pdf:search:cancel');
    if (!handler) {
        throw new Error('pdf:search:cancel handler is not registered');
    }
    return handler;
}

function getWarmIndexHandler() {
    const handler = mocks.handlers.get('pdf:search:warmIndex');
    if (!handler) {
        throw new Error('pdf:search:warmIndex handler is not registered');
    }
    return handler;
}

async function registerSearchHandlers() {
    const { ipcMain } = await import('electron');
    const { SEARCH_PLATFORM_FEATURE } = await import('@contracts/searchPlatformFeature');
    const {
        createValidatedIpcMainRegistrar,
        registerPlatformFeatureHandlers,
    } = await import('@electron/platform-ipc/validatedIpcRegistrar');
    const { prepareSearchMainBindings } = await import('@electron/features/search/main/ipc');
    const registrar = createValidatedIpcMainRegistrar(ipcMain as never, {
        allowedChannels: SEARCH_PLATFORM_FEATURE.invokeChannelSet,
        codecs: SEARCH_PLATFORM_FEATURE.ipcCodecs as never,
    });
    registerPlatformFeatureHandlers(
        registrar as never,
        SEARCH_PLATFORM_FEATURE,
        prepareSearchMainBindings(),
    );
}

function triggerMainFrameNavigation(event: ReturnType<typeof createInvokeEvent>) {
    const handler = event.sender.on.mock.calls
        .find(call => call[0] === 'did-start-navigation')?.[1] as ((
            event: unknown,
            url: string,
            isInPlace: boolean,
            isMainFrame: boolean,
        ) => void) | undefined;
    handler?.({}, 'app://reload', false, true);
}

describe('search IPC worker resource limits', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.handlers.clear();
        mocks.workerRecords.length = 0;
        mocks.webContentsById.clear();
        mocks.autoCompleteSearch = true;
        mocks.resourceTier = 'medium';
        mocks.mainOperationRecords.length = 0;
        mocks.registerMainOperation.mockReset();
        mocks.registerMainOperation.mockImplementation((registration: Record<string, unknown>) => {
            const controller = new AbortController();
            const complete = vi.fn();
            const record = {
                registration,
                controller,
                complete,
            };
            mocks.mainOperationRecords.push(record);
            return {
                id: `main-operation-${mocks.mainOperationRecords.length}`,
                signal: controller.signal,
                markCommitStarted: vi.fn(),
                complete,
            };
        });

        delete process.env.EVB_SEARCH_WORKER_MAX_ACTIVE;
        delete process.env.EVB_SEARCH_WORKER_IDLE_TTL_MS;
        delete process.env.EVB_SEARCH_WORKER_TERMINATE_TIMEOUT_MS;
        delete process.env.EVB_SEARCH_REQUEST_TIMEOUT_MS;
        delete process.env.EVB_SEARCH_CANCEL_ACK_TIMEOUT_MS;
        delete process.env.EVB_PDF_SEARCH_SERVICE_IDLE_TIMEOUT_MS;
        delete process.env.EVB_SEARCH_INDEX_CACHE_MAX_ENTRIES;
        delete process.env.EVB_SEARCH_INDEX_CACHE_TTL_MS;
        delete process.env.EVB_SEARCH_MAX_PAGE_TEXT_BYTES;
        delete process.env.EVB_SEARCH_MAX_TOTAL_TEXT_BYTES;

        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/allowed.pdf');
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(null);
        mocks.getWorkingCopyRevision.mockImplementation(async (documentRef: string) => ({
            version: 1,
            documentRef,
            authority: 'electron-working-copy',
            contentRevision: 1,
            mintedAt: 1,
            token: 'revision-token',
        }));
        mocks.existsSync.mockReturnValue(false);
    });

    it('cancels a request during path preprocessing without superseding a newer query', async () => {
        mocks.autoCompleteSearch = false;
        const firstPath = '/tmp/pdf-work-search-a/document.pdf';
        let releaseFirstPath!: (path: string) => void;
        const firstPathReady = new Promise<string>((resolve) => {
            releaseFirstPath = resolve;
        });
        mocks.resolveAllowedReadPath.mockImplementation((path: string) => (
            path === firstPath ? firstPathReady : Promise.resolve('/tmp/allowed.pdf')
        ));

        await registerSearchHandlers();
        const searchHandler = getSearchHandler();
        const cancelHandler = getCancelHandler();
        const firstEvent = createInvokeEvent(401);
        const firstSearch = searchHandler(
            firstEvent,
            {
                pdfPath: firstPath,
                query: 'first',
                requestId: 'search-a',
            },
        ) as Promise<unknown>;

        await vi.waitFor(() => {
            expect(mocks.resolveAllowedReadPath).toHaveBeenCalledWith(firstPath);
        });

        await expect(cancelHandler(firstEvent, 'search-a')).resolves.toEqual({canceled: true});

        const secondSearch = searchHandler(
            firstEvent,
            {
                pdfPath: '/tmp/second.pdf',
                query: 'second',
                requestId: 'search-b',
            },
        ) as Promise<unknown>;
        await vi.waitFor(() => {
            expect(mocks.workerRecords).toHaveLength(1);
        });

        releaseFirstPath(firstPath);

        await expect(firstSearch).resolves.toEqual({
            results: [],
            truncated: false,
            canceled: true,
        });
        expect(mocks.workerRecords[0]?.postMessageCalls).toContainEqual({
            type: 'search',
            payload: expect.objectContaining({requestId: 'search-b'}),
        });
        expect(mocks.workerRecords[0]?.postMessageCalls).not.toContainEqual({
            type: 'search',
            payload: expect.objectContaining({requestId: 'search-a'}),
        });

        emitWorkerComplete(0, 'search-b');
        await expect(secondSearch).resolves.toEqual({
            results: [],
            truncated: false,
        });
    });

    it('cancels all preprocessing requests for a sender when the request id is omitted', async () => {
        mocks.autoCompleteSearch = false;
        const workingCopyPath = '/tmp/pdf-work-search-implicit-cancel/document.pdf';
        const otherWorkingCopyPath = '/tmp/pdf-work-search-other-sender/document.pdf';
        let releasePath!: (path: string) => void;
        let releaseOtherPath!: (path: string) => void;
        const pathReady = new Promise<string>((resolve) => {
            releasePath = resolve;
        });
        const otherPathReady = new Promise<string>((resolve) => {
            releaseOtherPath = resolve;
        });
        mocks.resolveAllowedReadPath.mockImplementation((path: string) => (
            path === workingCopyPath
                ? pathReady
                : path === otherWorkingCopyPath
                    ? otherPathReady
                    : Promise.resolve('/tmp/allowed.pdf')
        ));

        await registerSearchHandlers();
        const searchHandler = getSearchHandler();
        const cancelHandler = getCancelHandler();
        const event = createInvokeEvent(403);
        const otherEvent = createInvokeEvent(404);
        const searchPromise = searchHandler(
            event,
            {
                pdfPath: workingCopyPath,
                query: 'needle',
            },
        ) as Promise<unknown>;
        const otherSearchPromise = searchHandler(
            otherEvent,
            {
                pdfPath: otherWorkingCopyPath,
                query: 'other',
            },
        ) as Promise<unknown>;

        await vi.waitFor(() => {
            expect(mocks.resolveAllowedReadPath).toHaveBeenCalledWith(workingCopyPath);
            expect(mocks.resolveAllowedReadPath).toHaveBeenCalledWith(otherWorkingCopyPath);
        });

        await expect(cancelHandler(event)).resolves.toEqual({canceled: true});
        releasePath(workingCopyPath);

        await expect(searchPromise).resolves.toEqual({
            results: [],
            truncated: false,
            canceled: true,
        });
        expect(mocks.workerRecords).toHaveLength(0);

        mocks.autoCompleteSearch = true;
        releaseOtherPath(otherWorkingCopyPath);
        await expect(otherSearchPromise).resolves.toEqual({
            results: [],
            truncated: false,
        });
        expect(mocks.workerRecords).toHaveLength(1);
    });

    it('holds a working copy during search preprocessing so close cancels before deletion', async () => {
        mocks.autoCompleteSearch = false;
        const workingCopyPath = '/tmp/pdf-work-search-close/document.pdf';
        let releasePath!: (path: string) => void;
        const pathReady = new Promise<string>((resolve) => {
            releasePath = resolve;
        });
        mocks.resolveAllowedReadPath.mockImplementation((path: string) => (
            path === workingCopyPath ? pathReady : Promise.resolve('/tmp/allowed.pdf')
        ));

        await registerSearchHandlers();
        const searchHandler = getSearchHandler();
        const searchPromise = searchHandler(
            createInvokeEvent(402),
            {
                pdfPath: workingCopyPath,
                query: 'needle',
                requestId: 'search-close-race',
            },
        ) as Promise<unknown>;

        await vi.waitFor(() => {
            expect(mocks.mainOperationRecords).toContainEqual(expect.objectContaining({registration: expect.objectContaining({workingCopyPath})}));
        });
        const preprocessingOperation = mocks.mainOperationRecords.find(record => (
            record.registration.workingCopyPath === workingCopyPath
        ));
        expect(preprocessingOperation).toBeDefined();

        preprocessingOperation?.controller.abort(new Error('Working copy is closing'));
        (preprocessingOperation?.registration.cancel as ((reason: string) => void) | undefined)?.('Working copy is closing');
        expect(preprocessingOperation?.complete).not.toHaveBeenCalled();
        releasePath(workingCopyPath);

        await expect(searchPromise).resolves.toEqual({
            results: [],
            truncated: false,
            canceled: true,
        });
        expect(mocks.workerRecords).toHaveLength(0);
        expect(preprocessingOperation?.complete).toHaveBeenCalledOnce();
    });

    it('rejects oversized search request ids before allocating a worker', async () => {
        await registerSearchHandlers();
        const searchHandler = getSearchHandler();
        const oversizedRequestId = 'x'.repeat(129);

        await expect(searchHandler(
            createInvokeEvent(10),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'first',
                requestId: oversizedRequestId,
            },
        )).rejects.toThrow('requestId exceeds maximum length (128)');

        expect(mocks.workerCtor).not.toHaveBeenCalled();
        expect(mocks.resolveAllowedReadPath).not.toHaveBeenCalled();
    });

    it('rejects oversized warm-index request ids before allocating a worker', async () => {
        await registerSearchHandlers();
        const warmIndexHandler = getWarmIndexHandler();
        const oversizedRequestId = 'x'.repeat(129);

        await expect(warmIndexHandler(
            createInvokeEvent(10),
            {
                pdfPath: '/tmp/one.pdf',
                pageCount: 3,
                requestId: oversizedRequestId,
            },
        )).rejects.toThrow('requestId exceeds maximum length (128)');

        expect(mocks.workerCtor).not.toHaveBeenCalled();
        expect(mocks.resolveAllowedReadPath).not.toHaveBeenCalled();
    });

    it('rejects oversized cancel request ids before looking up sender state', async () => {
        await registerSearchHandlers();
        const cancelHandler = getCancelHandler();
        const oversizedRequestId = 'x'.repeat(129);

        await expect(cancelHandler(createInvokeEvent(10), oversizedRequestId))
            .rejects.toThrow('requestId exceeds maximum length (128)');
        expect(mocks.workerCtor).not.toHaveBeenCalled();
    });

    it('fails fast when cap is reached and no idle worker can be reused', async () => {
        process.env.EVB_SEARCH_WORKER_MAX_ACTIVE = '1';
        mocks.autoCompleteSearch = false;

        await registerSearchHandlers();
        const searchHandler = getSearchHandler();

        const firstRequest = searchHandler(
            createInvokeEvent(10),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'first',
                requestId: 'req-1',
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean
        }>;

        await vi.waitFor(() => {
            expect(mocks.workerRecords).toHaveLength(1);
        });

        const secondRequest = searchHandler(
            createInvokeEvent(20),
            {
                pdfPath: '/tmp/two.pdf',
                query: 'second',
                requestId: 'req-2',
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean
        }>;

        await expectTypedSearchFailure(secondRequest, {
            code: 'SEARCH_WORKER_LIMIT',
            message: 'Search worker limit reached (1 active senders). Please retry shortly.',
            retryable: true,
        });
        expect(mocks.workerRecords).toHaveLength(1);

        emitWorkerComplete(0, 'req-1');
        await expect(firstRequest).resolves.toEqual({
            results: [],
            truncated: false,
        });
    });

    it('uses low-tier one-worker admission and passes the low residency policy', async () => {
        mocks.resourceTier = 'low';
        mocks.autoCompleteSearch = false;

        await registerSearchHandlers();
        const searchHandler = getSearchHandler();
        const firstRequest = searchHandler(
            createInvokeEvent(10),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'first',
                requestId: 'req-low-1',
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean;
        }>;

        await vi.waitFor(() => {
            expect(mocks.workerRecords).toHaveLength(1);
        });
        expect(mocks.workerRecords[0]?.workerData).toEqual({
            nativeServiceIdleTimeoutMs: 60_000,
            resourcePolicy: {
                indexCacheMaxEntries: 1,
                indexCacheTtlMs: 120_000,
                maxPageTextBytes: 2 * 1024 * 1024,
                maxTotalTextBytes: 48 * 1024 * 1024,
            },
        });

        await expectTypedSearchFailure(searchHandler(
            createInvokeEvent(20),
            {
                pdfPath: '/tmp/two.pdf',
                query: 'second',
                requestId: 'req-low-2',
            },
        ) as Promise<unknown>, {
            code: 'SEARCH_WORKER_LIMIT',
            message: 'Search worker limit reached (1 active senders). Please retry shortly.',
            retryable: true,
        });

        emitWorkerComplete(0, 'req-low-1');
        await expect(firstRequest).resolves.toEqual({
            results: [],
            truncated: false,
        });
    });

    it('reuses an idle worker under cap pressure instead of spawning a new one', async () => {
        process.env.EVB_SEARCH_WORKER_MAX_ACTIVE = '1';

        await registerSearchHandlers();
        const searchHandler = getSearchHandler();

        await expect(searchHandler(
            createInvokeEvent(31),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'alpha',
                requestId: 'req-a',
            },
        )).resolves.toEqual({
            results: [],
            truncated: false,
        });

        await expect(searchHandler(
            createInvokeEvent(32),
            {
                pdfPath: '/tmp/two.pdf',
                query: 'beta',
                requestId: 'req-b',
            },
        )).resolves.toEqual({
            results: [],
            truncated: false,
        });

        expect(mocks.workerRecords).toHaveLength(1);
        const searchRequestIds = mocks.workerRecords[0]?.postMessageCalls
            .filter(message => message.type === 'search')
            .map(message => (message.payload as { requestId?: string }).requestId);
        expect(searchRequestIds).toEqual([
            'req-a',
            'req-b',
        ]);
        expect(mocks.workerRecords[0]?.postMessageCalls.map(message => message.type)).toEqual([
            'search',
            'reset-state',
            'search',
        ]);
    });

    it('keeps normal per-sender search flow unchanged', async () => {
        process.env.EVB_SEARCH_WORKER_MAX_ACTIVE = '4';

        await registerSearchHandlers();
        const searchHandler = getSearchHandler();

        const firstResponse = await searchHandler(
            createInvokeEvent(77),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'needle',
                requestId: 'req-1',
            },
        );
        const secondResponse = await searchHandler(
            createInvokeEvent(77),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'needle',
                requestId: 'req-2',
            },
        );

        expect(firstResponse).toEqual({
            results: [],
            truncated: false,
        });
        expect(secondResponse).toEqual({
            results: [],
            truncated: false,
        });
        expect(mocks.workerRecords).toHaveLength(1);
    });

    it.each([
        {
            label: 'zero',
            pageNumber: 0,
        },
        {
            label: 'negative',
            pageNumber: -1,
        },
        {
            label: 'fractional',
            pageNumber: 1.5,
        },
    ])('rejects complete messages with $label worker pageNumber', async ({
        label,
        pageNumber,
    }) => {
        mocks.autoCompleteSearch = false;

        await registerSearchHandlers();
        const searchHandler = getSearchHandler();
        const requestId = `invalid-page-${label}`;
        const searchPromise = searchHandler(
            createInvokeEvent(170),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'needle',
                requestId,
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean
        }>;

        await vi.waitFor(() => {
            expect(mocks.workerRecords).toHaveLength(1);
        });

        emitWorkerCompleteWithResults(0, requestId, [buildSearchMatch({pageNumber})]);
        await expectSearchWorkerProtocolFailure(searchPromise, requestId);
        expect(mocks.logger.warn).toHaveBeenCalledWith('Search worker sent malformed message for sender 170');
        expect(mocks.workerRecords[0]?.postMessageCalls).toContainEqual(
            expect.objectContaining({type: 'shutdown'}),
        );
    });

    it('rejects complete messages with worker pageNumber above known pageCount', async () => {
        mocks.autoCompleteSearch = false;

        await registerSearchHandlers();
        const searchHandler = getSearchHandler();
        const requestId = 'complete-page-number-above-count';
        const searchPromise = searchHandler(
            createInvokeEvent(172),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'needle',
                requestId,
                pageCount: 2,
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean
        }>;

        await vi.waitFor(() => {
            expect(mocks.workerRecords).toHaveLength(1);
        });

        emitWorkerCompleteWithResults(0, requestId, [buildSearchMatch({pageNumber: 999})]);
        await expectSearchWorkerProtocolFailure(searchPromise, requestId);
        expect(mocks.logger.warn).toHaveBeenCalledWith('Search worker sent malformed message for sender 172');
        expect(mocks.workerRecords[0]?.postMessageCalls).toContainEqual(
            expect.objectContaining({type: 'shutdown'}),
        );
    });

    it('rejects progress messages with invalid result indices and offsets', async () => {
        mocks.autoCompleteSearch = false;

        await registerSearchHandlers();
        const searchHandler = getSearchHandler();
        const event = createInvokeEvent(171);
        const requestId = 'invalid-progress-result';
        const searchPromise = searchHandler(
            event,
            {
                pdfPath: '/tmp/one.pdf',
                query: 'needle',
                requestId,
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean
        }>;

        await vi.waitFor(() => {
            expect(mocks.workerRecords).toHaveLength(1);
        });

        emitWorkerEvent(0, 'message', {
            type: 'progress',
            requestId,
            processed: 1,
            total: 2,
            results: [buildSearchMatch({
                startOffset: 8,
                endOffset: 6,
            })],
            truncated: false,
        });
        await expectSearchWorkerProtocolFailure(searchPromise, requestId);
        expect(mocks.logger.warn).toHaveBeenCalledWith('Search worker sent malformed message for sender 171');
        expect(mocks.workerRecords[0]?.postMessageCalls).toContainEqual(
            expect.objectContaining({type: 'shutdown'}),
        );
    });

    it('rejects progress messages with worker pageNumber above known pageCount', async () => {
        mocks.autoCompleteSearch = false;

        await registerSearchHandlers();
        const searchHandler = getSearchHandler();
        const requestId = 'progress-page-number-above-count';
        const searchPromise = searchHandler(
            createInvokeEvent(173),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'needle',
                requestId,
                pageCount: 2,
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean
        }>;

        await vi.waitFor(() => {
            expect(mocks.workerRecords).toHaveLength(1);
        });

        emitWorkerEvent(0, 'message', {
            type: 'progress',
            requestId,
            processed: 1,
            total: 2,
            results: [buildSearchMatch({pageNumber: 999})],
            truncated: false,
        });
        await expectSearchWorkerProtocolFailure(searchPromise, requestId);
        expect(mocks.logger.warn).toHaveBeenCalledWith('Search worker sent malformed message for sender 173');
        expect(mocks.workerRecords[0]?.postMessageCalls).toContainEqual(
            expect.objectContaining({type: 'shutdown'}),
        );
    });

    it('caps oversized worker search results before resolving to the renderer', async () => {
        mocks.autoCompleteSearch = false;

        await registerSearchHandlers();
        const searchHandler = getSearchHandler();
        const requestId = 'oversized-complete-results';
        const searchPromise = searchHandler(
            createInvokeEvent(177),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'needle',
                requestId,
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean
        }>;

        await vi.waitFor(() => {
            expect(mocks.workerRecords).toHaveLength(1);
        });

        const results = Array.from({length: 505}, (_value, index) => buildSearchMatch({
            matchIndex: index,
            excerpt: {
                prefix: false,
                suffix: false,
                before: 'b'.repeat(5_000),
                match: 'needle',
                after: 'a'.repeat(5_000),
            },
        }));
        emitWorkerCompleteWithResults(0, requestId, results);

        await expect(searchPromise).resolves.toMatchObject({
            results: expect.any(Array),
            truncated: true,
        });
        const response = await searchPromise;
        expect(response.results).toHaveLength(500);
        expect(response.results[0]).toMatchObject({excerpt: {
            prefix: true,
            suffix: true,
            before: 'b'.repeat(4_096),
            match: 'needle',
            after: 'a'.repeat(4_096),
        }});
    });

    it('detaches renderer delivery without canceling pending search work on main-frame navigation', async () => {
        mocks.autoCompleteSearch = false;

        await registerSearchHandlers();
        const searchHandler = getSearchHandler();
        const event = createInvokeEvent(174);
        const searchPromise = searchHandler(
            event,
            {
                pdfPath: '/tmp/one.pdf',
                query: 'needle',
                requestId: 'nav-detach',
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean
        }>;

        await vi.waitFor(() => {
            expect(mocks.workerRecords).toHaveLength(1);
        });

        triggerMainFrameNavigation(event);

        expect(mocks.workerRecords[0]?.postMessageCalls).not.toContainEqual({
            type: 'cancel',
            requestId: 'nav-detach',
        });
        expect(mocks.workerRecords[0]?.terminate).not.toHaveBeenCalled();
        emitWorkerComplete(0, 'nav-detach');
        await expect(searchPromise).resolves.toEqual({
            results: [],
            truncated: false,
        });
        expect(event.sender.removeListener).toHaveBeenCalledWith('did-start-navigation', expect.any(Function));
    });

    it.each([
        {
            mode: 'complete',
            requestId: 'late-progress-after-complete',
            senderId: 174,
        },
        {
            mode: 'cancel',
            requestId: 'late-progress-after-cancel',
            senderId: 175,
        },
        {
            mode: 'timeout',
            requestId: 'late-progress-after-timeout',
            senderId: 176,
        },
    ] as const)('ignores late progress after $mode cleanup', async ({
        mode,
        requestId,
        senderId,
    }) => {
        mocks.autoCompleteSearch = false;
        if (mode === 'timeout') {
            vi.useFakeTimers();
            process.env.EVB_SEARCH_REQUEST_TIMEOUT_MS = '5000';
        }

        try {
            await registerSearchHandlers();
            const searchHandler = getSearchHandler();
            const cancelHandler = getCancelHandler();
            const event = createInvokeEvent(senderId);
            const searchPromise = searchHandler(
                event,
                {
                    pdfPath: '/tmp/one.pdf',
                    query: 'needle',
                    requestId,
                    pageCount: 2,
                },
            ) as Promise<{
                results: unknown[];
                truncated: boolean
            }>;

            await vi.waitFor(() => {
                expect(mocks.workerRecords).toHaveLength(1);
            });

            const sender = mocks.webContentsById.get(senderId);
            if (!sender) {
                throw new Error('Expected sender webContents mock');
            }

            const validResult = buildSearchMatch({pageNumber: 2});
            emitWorkerProgressWithResults(0, requestId, [validResult]);
            await vi.waitFor(() => {
                expect(sender.send).toHaveBeenCalledWith('pdf:search:progress', {
                    requestId,
                    processed: 1,
                    total: 2,
                    results: [validResult],
                    truncated: false,
                });
            });
            sender.send.mockClear();
            mocks.logger.warn.mockClear();

            if (mode === 'complete') {
                emitWorkerComplete(0, requestId);
                await expect(searchPromise).resolves.toEqual({
                    results: [],
                    truncated: false,
                });
                expect(sender.send).toHaveBeenCalledWith('pdf:search:progress', {
                    requestId,
                    processed: 2,
                    total: 2,
                    status: 'success',
                });
                sender.send.mockClear();
            } else if (mode === 'cancel') {
                await expect(cancelHandler(event, requestId)).resolves.toEqual({ canceled: true });
                expect(sender.send).not.toHaveBeenCalled();
                emitWorkerEvent(0, 'message', {
                    type: 'cancelled',
                    requestId,
                });
                await expect(searchPromise).resolves.toEqual({
                    results: [],
                    truncated: false,
                    canceled: true,
                });
                expect(sender.send).toHaveBeenCalledWith('pdf:search:progress', {
                    requestId,
                    processed: 0,
                    total: 2,
                    canceled: true,
                    status: 'canceled',
                });
                sender.send.mockClear();
            } else {
                const timeoutRejection = expectTypedSearchFailure(searchPromise, {
                    code: 'SEARCH_TIMEOUT',
                    message: 'Search request timed out after 5000ms',
                    retryable: true,
                });
                await vi.advanceTimersByTimeAsync(5_000);
                await timeoutRejection;
                expect(sender.send).toHaveBeenCalledWith('pdf:search:progress', {
                    requestId,
                    processed: 0,
                    total: 2,
                    status: 'failed',
                    error: 'Search request timed out after 5000ms',
                });
                // A timeout cancels the offending request and leaves the worker
                // serving the sender's other searches. Only a worker that never
                // acknowledges the cancel is retired, by the acknowledgement
                // fallback, which has not elapsed at this point.
                expect(mocks.workerRecords[0]?.postMessageCalls).toContainEqual(
                    expect.objectContaining({type: 'cancel'}),
                );
                expect(mocks.workerRecords[0]?.postMessageCalls).not.toContainEqual(
                    expect.objectContaining({type: 'shutdown'}),
                );
                sender.send.mockClear();
            }

            emitWorkerProgressWithResults(0, requestId, [buildSearchMatch({pageNumber: 999})]);
            await Promise.resolve();

            expect(sender.send).not.toHaveBeenCalled();
            expect(mocks.logger.warn).not.toHaveBeenCalled();
        } finally {
            if (mode === 'timeout') {
                vi.useRealTimers();
            }
        }
    });

    it('rejects oversized literal queries before resolving paths or spawning workers', async () => {
        await registerSearchHandlers();
        const searchHandler = getSearchHandler();

        await expect(searchHandler(
            createInvokeEvent(78),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'x'.repeat(2_049),
                requestId: 'oversized-literal',
            },
        )).rejects.toThrow('maximum length is 2048 characters');

        expect(mocks.resolveAllowedReadPath).not.toHaveBeenCalled();
        expect(mocks.workerRecords).toHaveLength(0);
    });

    it('forwards already-parsed whitespace queries without changing their code points', async () => {
        await registerSearchHandlers();
        const searchHandler = getSearchHandler();
        const parsedQuery = ' \t\n  ';

        await expect(searchHandler(
            createInvokeEvent(81),
            {
                pdfPath: '/tmp/one.pdf',
                query: parsedQuery,
                requestId: 'whitespace-query',
            },
        )).resolves.toEqual({
            results: [],
            truncated: false,
        });

        expect(mocks.workerRecords[0]?.postMessageCalls[0]?.payload)
            .toEqual(expect.objectContaining({
                query: parsedQuery,
                requestId: 'whitespace-query',
            }));
    });

    it('precompiles regex queries before dispatching to a worker', async () => {
        await registerSearchHandlers();
        const searchHandler = getSearchHandler();

        await expect(searchHandler(
            createInvokeEvent(79),
            {
                pdfPath: '/tmp/one.pdf',
                query: '(',
                requestId: 'invalid-regex',
                useRegex: true,
            },
        )).rejects.toThrow('Invalid search regex');

        expect(mocks.resolveAllowedReadPath).not.toHaveBeenCalled();
        expect(mocks.workerRecords).toHaveLength(0);
    });

    it('rejects unsafe regex queries before resolving paths or spawning workers', async () => {
        await registerSearchHandlers();
        const searchHandler = getSearchHandler();

        await expect(searchHandler(
            createInvokeEvent(80),
            {
                pdfPath: '/tmp/one.pdf',
                query: '(a+)+$',
                requestId: 'unsafe-regex',
                useRegex: true,
            },
        )).rejects.toThrow('pattern is too complex for document search');

        expect(mocks.resolveAllowedReadPath).not.toHaveBeenCalled();
        expect(mocks.workerRecords).toHaveLength(0);
    });

    it('caps the default active worker budget at two concurrent senders', async () => {
        mocks.autoCompleteSearch = false;

        await registerSearchHandlers();
        const searchHandler = getSearchHandler();

        const firstRequest = searchHandler(
            createInvokeEvent(101),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'first',
                requestId: 'req-a',
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean;
        }>;

        const secondRequest = searchHandler(
            createInvokeEvent(102),
            {
                pdfPath: '/tmp/two.pdf',
                query: 'second',
                requestId: 'req-b',
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean;
        }>;

        await vi.waitFor(() => {
            expect(mocks.workerRecords).toHaveLength(2);
        });

        await expectTypedSearchFailure(searchHandler(
            createInvokeEvent(103),
            {
                pdfPath: '/tmp/three.pdf',
                query: 'third',
                requestId: 'req-c',
            },
        ) as Promise<unknown>, {
            code: 'SEARCH_WORKER_LIMIT',
            message: 'Search worker limit reached (2 active senders). Please retry shortly.',
            retryable: true,
        });

        emitWorkerComplete(0, 'req-a');
        emitWorkerComplete(1, 'req-b');
        await expect(firstRequest).resolves.toEqual({
            results: [],
            truncated: false,
        });
        await expect(secondRequest).resolves.toEqual({
            results: [],
            truncated: false,
        });
    });

    it('re-arms idle cleanup after explicit cancel so the worker can be reclaimed', async () => {
        vi.useFakeTimers();
        process.env.EVB_SEARCH_WORKER_IDLE_TTL_MS = '10000';
        mocks.autoCompleteSearch = false;

        try {
            await registerSearchHandlers();
            const searchHandler = getSearchHandler();
            const cancelHandler = getCancelHandler();
            const event = createInvokeEvent(41);

            const searchPromise = searchHandler(
                event,
                {
                    pdfPath: '/tmp/cancel-me.pdf',
                    query: 'gamma',
                    requestId: 'req-cancel',
                },
            ) as Promise<{
                results: unknown[];
                truncated: boolean;
            }>;

            await vi.waitFor(() => {
                expect(mocks.workerRecords).toHaveLength(1);
            });

            await expect(cancelHandler(event, 'req-cancel')).resolves.toEqual({ canceled: true });
            emitWorkerEvent(0, 'message', {
                type: 'cancelled',
                requestId: 'req-cancel',
            });
            await expect(searchPromise).resolves.toEqual({
                results: [],
                truncated: false,
                canceled: true,
            });

            await vi.advanceTimersByTimeAsync(10_000);

            expect(mocks.workerRecords[0]?.postMessageCalls).toContainEqual(
                expect.objectContaining({type: 'shutdown'}),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('dispatches huge PDFs to the search worker instead of declaring search unavailable by file size', async () => {
        process.env.EVB_SEARCH_WORKER_MAX_ACTIVE = '4';

        await registerSearchHandlers();
        const searchHandler = getSearchHandler();

        await expect(searchHandler(
            createInvokeEvent(99),
            {
                pdfPath: '/tmp/large.pdf',
                query: 'needle',
                requestId: 'large-req',
            },
        )).resolves.toEqual({
            results: [],
            truncated: false,
        });
        expect(mocks.workerRecords).toHaveLength(1);
    });

    it('prefers the active working copy for original-path searches', async () => {
        process.env.EVB_SEARCH_WORKER_MAX_ACTIVE = '4';
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue('/tmp/work/large.pdf');
        mocks.resolveAllowedReadPath.mockImplementation(async (path: string) => path);

        await registerSearchHandlers();
        const searchHandler = getSearchHandler();

        await expect(searchHandler(
            createInvokeEvent(101),
            {
                pdfPath: '/Users/example/large.pdf',
                query: 'needle',
                requestId: 'original-path-req',
            },
        )).resolves.toEqual({
            results: [],
            truncated: false,
        });

        expect(mocks.workerRecords[0]?.postMessageCalls[0]?.payload)
            .toEqual(expect.objectContaining({pdfPath: '/tmp/work/large.pdf'}));
    });
});
