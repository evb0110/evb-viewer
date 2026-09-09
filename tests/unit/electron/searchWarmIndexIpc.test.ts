import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';

import type { TRegisteredHandler } from '@tests/unit/electron/helpers/ipcRegistryHarness';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';


interface IWarmIndexMockWorkerRecord {
    onHandlers: Map<string, Array<(arg: unknown) => void>>;
    postMessageCalls: Array<Record<string, unknown>>;
}

const mocks = vi.hoisted(() => ({
    handlers: new Map<string, TRegisteredHandler>(),
    workerRecords: [] as IWarmIndexMockWorkerRecord[],
    resolveAllowedReadPath: vi.fn(),
    findWorkingCopyPathByOriginalPath: vi.fn(),
    getWorkingCopyRevision: vi.fn(),
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
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

    const handlers = record.onHandlers.get(event) ?? [];
    for (const handler of handlers) {
        handler(payload);
    }
}

vi.mock('worker_threads', () => ({Worker: class {
    private record: IWarmIndexMockWorkerRecord;

    constructor() {
        this.record = {
            onHandlers: new Map(),
            postMessageCalls: [],
        };
        mocks.workerRecords.push(this.record);
    }

    on(event: string, handler: (arg: unknown) => void) {
        const handlers = this.record.onHandlers.get(event) ?? [];
        handlers.push(handler);
        this.record.onHandlers.set(event, handlers);
        return this;
    }

    postMessage(message: Record<string, unknown>) {
        this.record.postMessageCalls.push(message);
        if (message.type !== 'search') {
            return;
        }
        const payload = message.payload as { requestId?: string } | undefined;
        const requestId = payload?.requestId;
        if (!requestId) {
            return;
        }
        void Promise.resolve().then(() => {
            emitWorkerEvent(
                mocks.workerRecords.indexOf(this.record),
                'message',
                {
                    type: 'complete',
                    requestId,
                    response: {
                        results: [],
                        truncated: false,
                    },
                },
            );
        });
    }

    terminate() {
        return Promise.resolve(0);
    }
}}));

vi.mock('electron', () => ({
    app: {
        isPackaged: false,
        on: vi.fn(),
    },
    ipcMain: {handle: (channel: string, handler: TRegisteredHandler) => {
        mocks.handlers.set(channel, handler);
    }},
    webContents: {fromId: vi.fn(() => null)},
}));

vi.mock('@electron/platform-ipc/trustedIpcSender', () => ({isTrustedIpcInvokeSender: () => true}));
vi.mock('@electron/utils/pathValidator', () => ({resolveAllowedReadPath: mocks.resolveAllowedReadPath}));
vi.mock('@electron/file-access/workingCopyStore', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    findWorkingCopyPathByOriginalPath: mocks.findWorkingCopyPathByOriginalPath,
    normalizePathForLookup: (path: string) => path.trim(),
}));
vi.mock('@electron/file-access/documentRevisionStore', () => ({getWorkingCopyRevision: mocks.getWorkingCopyRevision}));
vi.mock('@electron/resources/hostResourceProfile', () => ({getHostResourceProfileSnapshot: () => ({
    logicalCpus: 4,
    totalRamBytes: 16 * 1024 ** 3,
    safeMode: false,
    detectedTier: 'high',
    performanceMode: 'auto',
    tier: 'high',
})}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

const DOCUMENT_REVISION = 'revision-token';

function createInvokeEvent(senderId: number) {
    return { sender: {
        id: senderId,
        isDestroyed: () => false,
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
        send: vi.fn(),
    } };
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

describe('search warm-index IPC', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.handlers.clear();
        mocks.workerRecords.length = 0;
        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/allowed.pdf');
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(null);
        mocks.getWorkingCopyRevision.mockResolvedValue({token: DOCUMENT_REVISION});
    });

    it('forwards large page counts through bounded warm-index worker messages', async () => {
        await registerSearchHandlers();
        const warmIndexHandler = mocks.handlers.get('pdf:search:warmIndex');
        const pageCount = 1_000_001;

        expect(warmIndexHandler).toBeTypeOf('function');
        await expect(warmIndexHandler?.(
            createInvokeEvent(111),
            {
                pdfPath: '/tmp/original.pdf',
                pageCount,
                requestId: 'warm-req-1',
            },
        )).resolves.toBe(true);

        const firstWorker = mocks.workerRecords[0];
        expect(firstWorker).toBeDefined();

        expect(firstWorker?.postMessageCalls[0]).toEqual({
            type: 'search',
            payload: {
                requestId: 'warm-req-1',
                pdfPath: '/tmp/allowed.pdf',
                documentRevision: DOCUMENT_REVISION,
                query: '',
                pageCount,
                warmup: true,
            },
        });
    });
});
