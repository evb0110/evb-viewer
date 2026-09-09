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
    BrowserWorkerResetError,
} from '@app/platform/browser-api/browserWorkerClient';

interface IPendingTestRequest {
    reject: (error: Error) => void;
    timeoutTimer?: ReturnType<typeof setTimeout> | null;
}

class FakeWorker extends EventTarget implements Worker {
    public static terminateCount = 0;
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
