import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    BrowserWorkerClient,
    BrowserWorkerRequestOwner,
    BrowserWorkerResetError,
} from '@app/platform/browser-api/browserWorkerClient';
import {
    canRunThreadedScanCleanupEngine,
    resolveScanCleanupEngineThreads,
    runWithScanCleanupEngineFailover,
} from '@app/platform/browser-api/scanCleanupEngineVariant';
import {
    encodeScanCleanupEngineWorkerName,
    readScanCleanupEngineWorkerThreads,
    SCAN_CLEANUP_THREADED_ENGINE_UNAVAILABLE,
} from '@app/platform/browser-api/scanCleanupEngineWorkerName';

interface IPendingTestRequest {
    reject: (error: Error) => void;
    timeoutTimer?: ReturnType<typeof setTimeout> | null;
}

class FakeWorker extends EventTarget implements Worker {
    public static terminateCount = 0;
    public constructor(public readonly name = '') {
        super();
    }

    public onerror: ((this: AbstractWorker, event: ErrorEvent) => unknown) | null = null;
    public onmessage: ((this: Worker, event: MessageEvent) => unknown) | null = null;
    public onmessageerror: ((this: Worker, event: MessageEvent) => unknown) | null = null;

    public readonly messageHandlers: Array<(event: MessageEvent<unknown>) => void> = [];

    public override addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
    ) {
        if (type === 'message' && typeof listener === 'function') {
            this.messageHandlers.push(listener as (event: MessageEvent<unknown>) => void);
        }
        super.addEventListener(type, listener, options);
    }

    public terminate() {
        FakeWorker.terminateCount += 1;
    }

    public postMessage(_message: unknown, _options?: StructuredSerializeOptions | Transferable[]) {}
}

function createWorkerClient() {
    return new BrowserWorkerClient<IPendingTestRequest>({
        idleTtlMs: 15_000,
        requestTimeoutMs: 1_000,
        createWorker: () => new FakeWorker(),
        createError: event => new Error(event.message),
        handleMessage: () => {},
    });
}

describe('BrowserWorkerClient', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        FakeWorker.terminateCount = 0;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('rejects only the timed-out request while sibling requests stay pending', async () => {
        const client = createWorkerClient();
        client.getWorker();
        const firstReject = vi.fn();
        const secondReject = vi.fn();

        client.registerPendingRequest(1, { reject: firstReject }, () => new Error('first timed out'));
        await vi.advanceTimersByTimeAsync(500);
        client.registerPendingRequest(2, { reject: secondReject }, () => new Error('second timed out'));

        await vi.advanceTimersByTimeAsync(500);

        expect(firstReject).toHaveBeenCalledOnce();
        expect(firstReject.mock.calls[0]?.[0].message).toBe('first timed out');
        expect(secondReject).not.toHaveBeenCalled();
        expect(client.hasPendingRequest(2)).toBe(true);
        expect(FakeWorker.terminateCount).toBe(0);

        client.cancelPendingRequest(2, new Error('cleanup'));
    });

    it('terminates an idle worker immediately after the last pending request times out', async () => {
        const client = createWorkerClient();
        client.getWorker();
        const reject = vi.fn();

        client.registerPendingRequest(1, { reject }, () => new Error('request timed out'));

        await vi.advanceTimersByTimeAsync(1_000);

        expect(reject).toHaveBeenCalledOnce();
        expect(client.hasWorker()).toBe(false);
        expect(FakeWorker.terminateCount).toBe(1);
    });

    it('supports a longer timeout for an individual large request', async () => {
        const client = createWorkerClient();
        client.getWorker();
        const reject = vi.fn();

        client.registerPendingRequest(
            1,
            { reject },
            () => new Error('large request timed out'),
            2_000,
        );

        await vi.advanceTimersByTimeAsync(1_000);
        expect(reject).not.toHaveBeenCalled();
        expect(client.hasPendingRequest(1)).toBe(true);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(reject).toHaveBeenCalledOnce();
    });

    it('settles every pending request once and clears request timers when the worker resets', () => {
        const client = createWorkerClient();
        client.getWorker();
        const firstReject = vi.fn();
        const secondReject = vi.fn();
        const firstRequest: IPendingTestRequest = {reject: firstReject};
        const secondRequest: IPendingTestRequest = {reject: secondReject};

        client.registerPendingRequest(1, firstRequest, () => new Error('first timed out'));
        client.registerPendingRequest(2, secondRequest, () => new Error('second timed out'));

        client.resetWorker();
        client.resetWorker(new Error('a later reset must not settle old requests'));

        expect(firstReject).toHaveBeenCalledOnce();
        expect(secondReject).toHaveBeenCalledOnce();
        expect(firstReject).toHaveBeenCalledWith(expect.any(BrowserWorkerResetError));
        expect(secondReject).toHaveBeenCalledWith(firstReject.mock.calls[0]?.[0]);
        expect(firstRequest.timeoutTimer).toBeNull();
        expect(secondRequest.timeoutTimer).toBeNull();
        expect(client.pendingRequests.size).toBe(0);
        expect(FakeWorker.terminateCount).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('ignores a message callback from an obsolete worker generation', () => {
        const handleMessage = vi.fn();
        const client = new BrowserWorkerClient<IPendingTestRequest>({
            idleTtlMs: 15_000,
            createWorker: () => new FakeWorker(),
            createError: event => new Error(event.message),
            handleMessage,
        });
        const firstWorker = client.getWorker();
        if (!(firstWorker instanceof FakeWorker)) {
            throw new Error('Expected a fake worker');
        }
        const obsoleteMessageHandler = firstWorker.messageHandlers[0];
        client.resetWorker();
        const currentWorker = client.getWorker();
        if (!(currentWorker instanceof FakeWorker)) {
            throw new Error('Expected a fake worker');
        }
        const currentReject = vi.fn();
        client.registerPendingRequest(1, {reject: currentReject}, () => new Error('timed out'));

        obsoleteMessageHandler?.(new MessageEvent('message', {data: {id: 1}}));
        expect(handleMessage).not.toHaveBeenCalled();

        currentWorker.dispatchEvent(new MessageEvent('message', {data: {id: 1}}));
        expect(handleMessage).toHaveBeenCalledOnce();

        client.cancelPendingRequest(1, new Error('cleanup'));
    });

    it('uses persisted page transitions without installing a beforeunload cleanup listener', () => {
        const windowTarget = new EventTarget();
        const addEventListener = vi.spyOn(windowTarget, 'addEventListener');
        const removeEventListener = vi.spyOn(windowTarget, 'removeEventListener');
        vi.stubGlobal('window', windowTarget);

        const client = createWorkerClient();
        client.getWorker();
        const reject = vi.fn();
        client.registerPendingRequest(1, {reject}, () => new Error('timed out'));

        expect(addEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function));
        expect(addEventListener).toHaveBeenCalledWith('pageshow', expect.any(Function));
        expect(addEventListener).not.toHaveBeenCalledWith('beforeunload', expect.any(Function));

        windowTarget.dispatchEvent(Object.assign(new Event('pagehide'), {persisted: true}));
        expect(reject).not.toHaveBeenCalled();
        expect(client.hasWorker()).toBe(true);

        windowTarget.dispatchEvent(Object.assign(new Event('pageshow'), {persisted: true}));
        expect(reject).toHaveBeenCalledOnce();
        expect(reject).toHaveBeenCalledWith(expect.any(BrowserWorkerResetError));
        expect(client.hasWorker()).toBe(false);
        expect(removeEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function));
        expect(removeEventListener).toHaveBeenCalledWith('pageshow', expect.any(Function));

        client.getWorker();
        const secondReject = vi.fn();
        client.registerPendingRequest(2, {reject: secondReject}, () => new Error('timed out'));
        windowTarget.dispatchEvent(Object.assign(new Event('pagehide'), {persisted: false}));
        expect(secondReject).toHaveBeenCalledOnce();
        expect(client.hasWorker()).toBe(false);
    });
});

describe('BrowserWorkerRequestOwner admission by worker key', () => {
    beforeEach(() => {
        FakeWorker.terminateCount = 0;
    });

    function createOwner(slots: number) {
        const started: string[] = [];
        const owner = new BrowserWorkerRequestOwner(() => new BrowserWorkerClient<IPendingTestRequest>({
            idleTtlMs: 60_000,
            defaultWorkerKey: () => 'default',
            createWorker: (key) => {
                started.push(key ?? '');
                return new FakeWorker(key);
            },
            createError: event => new Error(event.message),
            handleMessage: () => {},
        }), slots);
        let nextId = 1;
        /** Runs a request until `finish` is called, reporting the worker it ran on. */
        const hold = (key?: string) => {
            let finish!: () => void;
            const finished = new Promise<void>(resolve => void (finish = resolve));
            let ranOn!: (name: string) => void;
            const worker = new Promise<string>(resolve => void (ranOn = resolve));
            const done = owner.run(nextId++, async (client) => {
                ranOn((client.getWorker(key) as FakeWorker).name);
                await finished;
            }, key);
            return {
                worker,
                finish: async () => {
                    finish();
                    await done;
                },
            };
        };
        return {
            owner,
            started,
            hold,
        };
    }

    it('reuses a worker of the wanted key, then starts one on an empty slot, then replaces an idle one', async () => {
        const {started, hold} = createOwner(3);
        const first = hold('threads-6');
        expect(await first.worker).toBe('threads-6');
        await first.finish();

        const batch = hold('threads-2');
        // The idle threads-6 worker is kept; an empty slot takes the new key.
        expect(await batch.worker).toBe('threads-2');
        const preview = hold('threads-6');
        expect(await preview.worker).toBe('threads-6');
        expect(started).toEqual(['threads-6', 'threads-2']);
        await preview.finish();

        const lone = hold('threads-1');
        expect(await lone.worker).toBe('threads-1');
        const other = hold('threads-3');
        // Every slot has a worker; the idle one of another key is replaced.
        expect(await other.worker).toBe('threads-3');
        expect(started).toEqual(['threads-6', 'threads-2', 'threads-1', 'threads-3']);
        expect(FakeWorker.terminateCount).toBe(1);
        await Promise.all([batch.finish(), lone.finish(), other.finish()]);
    });

    it('runs a request without a key on any running worker before starting one', async () => {
        const {started, hold} = createOwner(2);
        const keyed = hold('threads-6');
        await keyed.worker;
        await keyed.finish();
        const any = hold();
        expect(await any.worker).toBe('threads-6');
        const second = hold();
        expect(await second.worker).toBe('default');
        expect(started).toEqual(['threads-6', 'default']);
        await Promise.all([any.finish(), second.finish()]);
    });

    it('ends only the idle workers when asked', async () => {
        const {owner, hold} = createOwner(2);
        const idle = hold('threads-6');
        await idle.worker;
        await idle.finish();
        const busy = hold('threads-2');
        await busy.worker;
        owner.resetIdleWorkers();
        expect(FakeWorker.terminateCount).toBe(1);
        await busy.finish();
    });
});

describe('scan cleanup engine threads', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('splits the cores but one among the requests a caller runs at once, from one to six threads', () => {
        // On 11 cores: a lone preview, a 4-page job, an 8-lane batch.
        expect(resolveScanCleanupEngineThreads(1, 11)).toBe(6);
        expect(resolveScanCleanupEngineThreads(4, 11)).toBe(2);
        expect(resolveScanCleanupEngineThreads(8, 11)).toBe(1);
        expect(resolveScanCleanupEngineThreads(3, 4)).toBe(1);
        expect(resolveScanCleanupEngineThreads(1, 2)).toBe(1);
        // A request that declares nothing never oversubscribes.
        expect(resolveScanCleanupEngineThreads(undefined, 11)).toBe(1);
    });

    it('runs the threaded engine only on an isolated page with shared memory, cores and memory to spare', () => {
        const capable = {
            crossOriginIsolated: true,
            hasSharedArrayBuffer: true,
            lowMemory: false,
            cores: 8,
            probeMemory: () => undefined,
        };
        expect(canRunThreadedScanCleanupEngine(capable)).toBe(true);
        expect(canRunThreadedScanCleanupEngine({...capable, crossOriginIsolated: false})).toBe(false);
        expect(canRunThreadedScanCleanupEngine({...capable, hasSharedArrayBuffer: false})).toBe(false);
        expect(canRunThreadedScanCleanupEngine({...capable, lowMemory: true})).toBe(false);
        expect(canRunThreadedScanCleanupEngine({...capable, cores: 1})).toBe(false);
        expect(canRunThreadedScanCleanupEngine({...capable, probeMemory: () => {
            throw new RangeError('Out of memory');
        }})).toBe(false);
    });

    it('names each worker after the engine it runs, and a page that switched off runs today\'s engine', async () => {
        vi.stubGlobal('crossOriginIsolated', true);
        vi.stubGlobal('navigator', {hardwareConcurrency: 11, userAgent: 'test'});
        vi.resetModules();
        const variant = await import('@app/platform/browser-api/scanCleanupEngineVariant');
        const {SerializableError} = await import('@contracts/serializableError');
        expect(variant.usesThreadedScanCleanupEngine()).toBe(true);
        expect(readScanCleanupEngineWorkerThreads(variant.scanCleanupEngineWorkerName(1))).toBe(6);
        expect(readScanCleanupEngineWorkerThreads(variant.scanCleanupEngineWorkerName(4))).toBe(2);

        // The worker could not start its threads and handed the page back.
        const unavailable = new SerializableError({
            code: SCAN_CLEANUP_THREADED_ENGINE_UNAVAILABLE,
            message: 'its threads did not start',
            details: {payload: 'page 1 returned'},
        });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const attempts: Array<{payload: string; worker: string}> = [];
        const resetIdleWorkers = vi.fn();
        const result = await variant.runWithScanCleanupEngineFailover('page 1', async (payload) => {
            attempts.push({payload, worker: variant.scanCleanupEngineWorkerName(1)});
            if (attempts.length === 1) throw unavailable;
            return 'cleaned';
        }, resetIdleWorkers);
        expect(result).toBe('cleaned');
        expect(attempts.map(attempt => [attempt.payload, readScanCleanupEngineWorkerThreads(attempt.worker)])).toEqual([
            ['page 1', 6],
            ['page 1 returned', null],
        ]);
        expect(resetIdleWorkers).toHaveBeenCalledOnce();
        expect(variant.usesThreadedScanCleanupEngine()).toBe(false);
    });

    it('does not retry a request that failed for any other reason', async () => {
        const attempt = vi.fn(async () => {
            throw new Error('The page is damaged');
        });
        await expect(runWithScanCleanupEngineFailover('page', attempt, () => undefined)).rejects.toThrow('The page is damaged');
        expect(attempt).toHaveBeenCalledOnce();
    });

    it('reads back the thread count a worker name carries, and none from a name it did not write', () => {
        expect(readScanCleanupEngineWorkerThreads(encodeScanCleanupEngineWorkerName(3))).toBe(3);
        expect(readScanCleanupEngineWorkerThreads(encodeScanCleanupEngineWorkerName(null))).toBeNull();
        expect(readScanCleanupEngineWorkerThreads(encodeScanCleanupEngineWorkerName(99))).toBeNull();
        expect(readScanCleanupEngineWorkerThreads(undefined)).toBeNull();
        expect(readScanCleanupEngineWorkerThreads('')).toBeNull();
    });
});
