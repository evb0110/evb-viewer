import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    BrowserWorkerBudget,
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

    function createOwner(slots: number, budget?: BrowserWorkerBudget) {
        const started: string[] = [];
        const owner = new BrowserWorkerRequestOwner(() => new BrowserWorkerClient<IPendingTestRequest>({
            idleTtlMs: 60_000,
            defaultWorkerKey: () => 'default',
            ...(budget ? {budget} : {}),
            createWorker: (key) => {
                started.push(key ?? '');
                return new FakeWorker(key);
            },
            createError: event => new Error(event.message),
            handleMessage: () => {},
        }), slots, budget);
        let nextId = 1;
        /** Runs a request until `finish` is called, reporting the worker it ran on. */
        const hold = (key?: string, budgetReserve = 0) => {
            let finish!: () => void;
            const finished = new Promise<void>(resolve => void (finish = resolve));
            let ranOn!: (name: string) => void;
            const worker = new Promise<string>(resolve => void (ranOn = resolve));
            const done = owner.run(nextId++, async (client, _isAdmitted, workerKey) => {
                ranOn((client.getWorker(workerKey) as FakeWorker).name);
                await finished;
            }, {
                ...(key === undefined ? {} : {workerKey: () => key}),
                budgetReserve,
            });
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

describe('BrowserWorkerBudget across pools', () => {
    beforeEach(() => {
        FakeWorker.terminateCount = 0;
    });

    function createPool(slots: number, budget: BrowserWorkerBudget) {
        const started: string[] = [];
        const owner = new BrowserWorkerRequestOwner(() => new BrowserWorkerClient<IPendingTestRequest>({
            idleTtlMs: 60_000,
            budget,
            createWorker: (key) => {
                started.push(key ?? '');
                return new FakeWorker(key);
            },
            createError: event => new Error(event.message),
            handleMessage: () => {},
        }), slots, budget);
        let nextId = 1;
        const hold = (key: string, budgetReserve = 0) => {
            let finish!: () => void;
            const finished = new Promise<void>(resolve => void (finish = resolve));
            let ranOn: string | null = null;
            const done = owner.run(nextId++, async (client, _isAdmitted, workerKey) => {
                ranOn = (client.getWorker(workerKey) as FakeWorker).name;
                await finished;
            }, {
                workerKey: () => key,
                budgetReserve,
            });
            return {
                ranOn: () => ranOn,
                finish: async () => {
                    finish();
                    await done;
                },
            };
        };
        return {
            started,
            hold,
        };
    }

    /** Lets admission run: owners admit again in a microtask after a place frees. */
    const settle = async () => {
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    };

    it('starts no counted worker past the budget; a waiting request starts once a place frees, in any pool', async () => {
        const budget = new BrowserWorkerBudget(() => 2, key => key?.startsWith('threads') === true);
        const cleanup = createPool(4, budget);
        const ocr = createPool(4, budget);
        const first = cleanup.hold('threads-2');
        const second = cleanup.hold('threads-2');
        const third = ocr.hold('threads-3');
        await settle();
        expect([first.ranOn(), second.ranOn(), third.ranOn()]).toEqual(['threads-2', 'threads-2', null]);
        // An uncounted worker is not held back.
        const single = ocr.hold('single');
        await settle();
        expect(single.ranOn()).toBe('single');

        // The finished request leaves an idle threaded worker: the other pool ends it and takes its place.
        await first.finish();
        await settle();
        expect(third.ranOn()).toBe('threads-3');
        expect(FakeWorker.terminateCount).toBe(1);
        expect(cleanup.started.length + ocr.started.length).toBe(4);
        await Promise.all([second.finish(), third.finish(), single.finish()]);
    });

    it('replaces an idle counted worker of its own pool when the budget is full', async () => {
        const budget = new BrowserWorkerBudget(() => 1, key => key?.startsWith('threads') === true);
        const pool = createPool(3, budget);
        const preview = pool.hold('threads-6');
        await settle();
        await preview.finish();
        const batch = pool.hold('threads-2');
        await settle();
        expect(batch.ranOn()).toBe('threads-2');
        expect(FakeWorker.terminateCount).toBe(1);
        await batch.finish();
    });

    it('keeps a place free for an interactive request while a batch fills the rest', async () => {
        const budget = new BrowserWorkerBudget(() => 3, key => key?.startsWith('threads') === true);
        const pool = createPool(5, budget);
        const pages = [pool.hold('threads-2', 1), pool.hold('threads-2', 1), pool.hold('threads-2', 1)];
        await settle();
        expect(pages.map(page => page.ranOn())).toEqual(['threads-2', 'threads-2', null]);
        const preview = pool.hold('threads-6');
        await settle();
        expect(preview.ranOn()).toBe('threads-6');
        await Promise.all([...pages.slice(0, 2), preview].map(request => request.finish()));
        await settle();
        expect(pages[2]!.ranOn()).toBe('threads-2');
        await pages[2]!.finish();
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
        // A batch runs at most as many pages at once as it has threaded places.
        expect(resolveScanCleanupEngineThreads(8, 11)).toBe(2);
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
        };
        expect(canRunThreadedScanCleanupEngine(capable)).toBe(true);
        expect(canRunThreadedScanCleanupEngine({...capable, crossOriginIsolated: false})).toBe(false);
        expect(canRunThreadedScanCleanupEngine({...capable, hasSharedArrayBuffer: false})).toBe(false);
        expect(canRunThreadedScanCleanupEngine({...capable, lowMemory: true})).toBe(false);
        expect(canRunThreadedScanCleanupEngine({...capable, cores: 1})).toBe(false);
    });

    it('runs no queued request on a threaded worker once a threaded start failed, in either pool', async () => {
        vi.stubGlobal('crossOriginIsolated', true);
        vi.stubGlobal('navigator', {hardwareConcurrency: 11, userAgent: 'test'});
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.resetModules();
        const variant = await import('@app/platform/browser-api/scanCleanupEngineVariant');
        const otherPool = vi.fn();
        variant.registerScanCleanupEnginePool(otherPool);
        const events: Array<{kind: 'started' | 'sent' | 'failed' | 'ran'; worker: string; payload?: string}> = [];
        // Every threaded worker fails to start its engine and hands the request back.
        class EngineWorker extends EventTarget {
            public constructor(_url: URL, private readonly options: {name: string}) {
                super();
                events.push({kind: 'started', worker: options.name});
            }

            public postMessage(message: {id: number; type: string; payload: {label: string}}) {
                events.push({kind: 'sent', worker: this.options.name, payload: message.payload.label});
                queueMicrotask(() => {
                    const threaded = readScanCleanupEngineWorkerThreads(this.options.name) !== null;
                    events.push({kind: threaded ? 'failed' : 'ran', worker: this.options.name, payload: message.payload.label});
                    this.dispatchEvent(new MessageEvent('message', {data: threaded
                        ? {
                            id: message.id,
                            ok: false,
                            error: 'its threads did not start',
                            errorEnvelope: {
                                code: SCAN_CLEANUP_THREADED_ENGINE_UNAVAILABLE,
                                message: 'its threads did not start',
                                details: {payload: {label: `${message.payload.label} returned`}},
                            },
                        }
                        : {
                            id: message.id,
                            ok: true,
                            type: message.type,
                            data: {status: 'succeeded', result: {}},
                        }}));
                });
            }

            public terminate() {}
        }
        vi.stubGlobal('Worker', EngineWorker);
        const {runBrowserScanCleanupWorkerRequest} = await import('@app/platform/browser-api/browserScanCleanupWorkerClient');

        // A 4-page batch and a preview queue at once, more than the pool's places.
        const signal = new AbortController().signal;
        const requests = Array.from({length: 12}, (_unused, index) => runBrowserScanCleanupWorkerRequest(
            'plan-analysis',
            {label: `page ${String(index + 1)}`} as never,
            signal,
            undefined,
            index === 11 ? 1 : 4,
        ));
        await expect(Promise.all(requests)).resolves.toHaveLength(12);

        const firstFailure = events.findIndex(event => event.kind === 'failed');
        expect(firstFailure).toBeGreaterThanOrEqual(0);
        // After the first failure no request reaches a threaded worker, new or already running.
        const afterSwitch = events.slice(firstFailure + 1);
        expect(afterSwitch.filter(event => (event.kind === 'started' || event.kind === 'sent')
            && readScanCleanupEngineWorkerThreads(event.worker) !== null)).toEqual([]);
        // Requests admitted before the switch ran again with the page they handed back; none ran threaded.
        const ran = events.filter(event => event.kind === 'ran');
        expect(ran).toHaveLength(12);
        expect(ran.every(event => readScanCleanupEngineWorkerThreads(event.worker) === null)).toBe(true);
        expect(events.filter(event => event.kind === 'failed').length).toBe(ran.filter(event => event.payload?.endsWith('returned')).length);
        expect(otherPool).toHaveBeenCalledOnce();
        expect(variant.usesThreadedScanCleanupEngine()).toBe(false);
    });

    it('does not retry a request that failed for any other reason', async () => {
        const attempt = vi.fn(async () => {
            throw new Error('The page is damaged');
        });
        await expect(runWithScanCleanupEngineFailover('page', attempt)).rejects.toThrow('The page is damaged');
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
