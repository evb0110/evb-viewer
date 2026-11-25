import {
    BrowserWorkerClientLifecycle,
    BrowserWorkerResetError,
} from '@app/platform/browser-api/browserWorkerClientLifecycle';
export {BrowserWorkerResetError} from '@app/platform/browser-api/browserWorkerClientLifecycle';
import {getPerformanceProfile} from '@app/utils/performanceProfile';
import type {IResolvedStreamingRasterHandoffBudget} from '@evb/scan-cleanup/core/streamingRasterHandoff';

interface IBrowserWorkerClientOptions<TPendingRequest> {
    /**
     * Starts the worker. `key` is the kind of worker a request asked for, such
     * as an engine's thread count; a worker keeps its key for life.
     */
    createWorker: (key: string | undefined) => Worker;
    /** The key of a worker started for a request that takes any kind. */
    defaultWorkerKey?: () => string;
    idleTtlMs: number;
    requestTimeoutMs?: number;
    handleMessage: (
        pendingRequests: Map<number, TPendingRequest>,
        response: unknown,
        scheduleIdleWorkerTermination: () => void,
    ) => void;
    createError: (event: ErrorEvent) => Error;
}

interface IWorkerEventListeners {
    message: (event: MessageEvent<unknown>) => void;
    error: (event: ErrorEvent) => void;
}

const MAX_PAGE_LANES = 8;

/**
 * The pages a browser document job works on at once, and the memory they may
 * hold together. Each page runs on one thread of its own engine instance, so
 * pages in flight are how a job uses the device's cores. One core stays free
 * for interaction and one for a preview's lane; at most a quarter of reported
 * memory goes to the pages in flight. Browsers omit or round deviceMemory
 * down, so an unknown device is taken for a 4 GiB one. A phone, a small device
 * and the low performance mode run one page at a time: the performance profile
 * calls those low memory.
 */
export function resolveBrowserPageLanes(): IResolvedStreamingRasterHandoffBudget {
    const cores = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2;
    const memoryGb = typeof navigator === 'undefined'
        ? undefined
        : (navigator as Navigator & {deviceMemory?: number}).deviceMemory;
    const lanes = getPerformanceProfile().lowMemory
        ? 1
        : Math.max(1, Math.min(MAX_PAGE_LANES, cores - 2));
    return {
        producerConcurrency: lanes,
        // A finished page is committed as soon as every page before it is.
        maxChunkPages: 1,
        // Finished pages waiting on an earlier one leave the other lanes working.
        maxInFlightPages: lanes * 2,
        maxInFlightBytes: (memoryGb ?? 4) * 1024 ** 3 / 4,
    };
}

export function canUseBrowserWorker() {
    return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

export class BrowserWorkerClient<
    TPendingRequest extends {
        reject: (error: Error) => void;
        timeoutTimer?: ReturnType<typeof setTimeout> | null;
    },
> {
    public readonly pendingRequests = new Map<number, TPendingRequest>();

    private worker: Worker | null = null;
    private currentWorkerKey: string | undefined = undefined;
    private workerEventListeners: IWorkerEventListeners | null = null;
    private workerGeneration = 0;
    private nextRequestId = 1;
    private idleTerminateTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly lifecycle = new BrowserWorkerClientLifecycle();

    public constructor(private readonly options: IBrowserWorkerClientOptions<TPendingRequest>) {}

    public createRequestId() {
        const requestId = this.nextRequestId;
        this.nextRequestId += 1;
        return requestId;
    }

    public clearIdleTerminateTimer() {
        if (!this.idleTerminateTimer) {
            return;
        }

        clearTimeout(this.idleTerminateTimer);
        this.idleTerminateTimer = null;
    }

    public scheduleIdleWorkerTermination = () => {
        this.clearIdleTerminateTimer();
        if (!this.worker || this.pendingRequests.size > 0) {
            return;
        }

        this.idleTerminateTimer = setTimeout(() => {
            this.idleTerminateTimer = null;
            if (!this.worker || this.pendingRequests.size > 0) {
                return;
            }

            this.resetWorker();
        }, this.options.idleTtlMs);
    };

    public resetWorker(error?: Error) {
        const pending = Array.from(this.pendingRequests.values());
        this.pendingRequests.clear();
        this.clearIdleTerminateTimer();
        pending.forEach(request => this.clearRequestTimeout(request));

        this.workerGeneration += 1;
        const worker = this.worker;
        const workerEventListeners = this.workerEventListeners;
        this.worker = null;
        this.workerEventListeners = null;
        this.lifecycle.clear();

        if (worker) {
            if (workerEventListeners) {
                worker.removeEventListener('message', workerEventListeners.message);
                worker.removeEventListener('error', workerEventListeners.error);
            }
            worker.terminate();
        }

        if (pending.length > 0) {
            const resetError = error ?? new BrowserWorkerResetError();
            pending.forEach(request => request.reject(resetError));
        }
    }

    /**
     * The worker for a request of `key`. A worker of another key is replaced,
     * so ask only while the client runs nothing else; no key takes any worker.
     */
    public getWorker(key?: string) {
        if (this.worker && (key === undefined || key === this.currentWorkerKey)) {
            this.clearIdleTerminateTimer();
            return this.worker;
        }
        if (this.worker) this.resetWorker();

        const workerKey = key ?? this.options.defaultWorkerKey?.();
        const worker = this.options.createWorker(workerKey);
        this.currentWorkerKey = workerKey;
        const generation = this.workerGeneration + 1;
        const workerEventListeners: IWorkerEventListeners = {
            message: event => {
                if (this.worker !== worker || this.workerGeneration !== generation) {
                    return;
                }

                this.options.handleMessage(
                    this.pendingRequests,
                    event.data,
                    this.scheduleIdleWorkerTermination,
                );
            },
            error: event => {
                if (this.worker !== worker || this.workerGeneration !== generation) {
                    return;
                }

                this.resetWorker(this.options.createError(event));
            },
        };

        this.worker = worker;
        this.workerGeneration = generation;
        this.workerEventListeners = workerEventListeners;
        worker.addEventListener('message', workerEventListeners.message);
        worker.addEventListener('error', workerEventListeners.error);
        this.lifecycle.register(() => this.resetWorker());
        return worker;
    }

    public hasWorker() {
        return this.worker !== null;
    }

    /** The key of the running worker, or undefined when none runs. */
    public get workerKey() {
        return this.worker === null ? undefined : this.currentWorkerKey;
    }

    public hasPendingRequest(requestId: number) {
        return this.pendingRequests.has(requestId);
    }

    public registerPendingRequest(
        requestId: number,
        pendingRequest: TPendingRequest,
        createTimeoutError: () => Error,
        requestTimeoutMs?: number,
    ) {
        this.clearIdleTerminateTimer();
        this.pendingRequests.set(requestId, pendingRequest);
        this.armRequestTimeout(
            requestId,
            pendingRequest,
            createTimeoutError,
            requestTimeoutMs ?? this.options.requestTimeoutMs,
        );
    }

    /** Replaces a pending request's timeout, measured from now. */
    public restartRequestTimeout(
        requestId: number,
        createTimeoutError: () => Error,
        timeoutMs: number,
    ) {
        const pendingRequest = this.pendingRequests.get(requestId);
        if (!pendingRequest) {
            return;
        }

        this.clearRequestTimeout(pendingRequest);
        this.armRequestTimeout(requestId, pendingRequest, createTimeoutError, timeoutMs);
    }

    public cancelPendingRequest(
        requestId: number,
        error: Error,
        options: {
            resetWorker?: boolean;
            resetError?: Error;
        } = {},
    ) {
        const pendingRequest = this.pendingRequests.get(requestId);
        if (!pendingRequest) {
            return false;
        }

        this.pendingRequests.delete(requestId);
        this.clearRequestTimeout(pendingRequest);
        pendingRequest.reject(error);
        if (options.resetWorker) {
            this.resetWorker(options.resetError ?? error);
        } else {
            this.scheduleIdleWorkerTermination();
        }
        return true;
    }

    private armRequestTimeout(
        requestId: number,
        pendingRequest: TPendingRequest,
        createTimeoutError: () => Error,
        timeoutMs: number | undefined,
    ) {
        if (typeof timeoutMs !== 'number' || timeoutMs <= 0) {
            return;
        }

        pendingRequest.timeoutTimer = setTimeout(() => {
            if (!this.pendingRequests.delete(requestId)) {
                return;
            }

            this.clearRequestTimeout(pendingRequest);
            const timeoutError = createTimeoutError();
            pendingRequest.reject(timeoutError);
            if (this.pendingRequests.size === 0) {
                this.resetWorker();
            } else {
                this.scheduleIdleWorkerTermination();
            }
        }, timeoutMs);
    }

    private clearRequestTimeout(request: TPendingRequest) {
        if (request.timeoutTimer === undefined || request.timeoutTimer === null) {
            return;
        }

        clearTimeout(request.timeoutTimer);
        request.timeoutTimer = null;
    }
}

interface IOwnedRequest<TPendingRequest extends {
    reject: (error: Error) => void;
    timeoutTimer?: ReturnType<typeof setTimeout> | null;
}> {
    client: BrowserWorkerClient<TPendingRequest> | null;
    workerKey: string | undefined;
    start: (client: BrowserWorkerClient<TPendingRequest>) => void;
    reject: (error: Error) => void;
}

/**
 * Admission and cancellation for synchronous engines, one request per worker.
 * Each slot keeps its worker until the worker's idle lifetime ends.
 */
export class BrowserWorkerRequestOwner<TPendingRequest extends {
    reject: (error: Error) => void;
    timeoutTimer?: ReturnType<typeof setTimeout> | null;
}> {
    private readonly clients: Array<BrowserWorkerClient<TPendingRequest>>;
    private readonly lifecycle = new BrowserWorkerClientLifecycle();
    private readonly requests = new Map<number, IOwnedRequest<TPendingRequest>>();

    public constructor(
        createClient: () => BrowserWorkerClient<TPendingRequest>,
        slots = Math.min(2, Math.max(1, Math.floor(
            (typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency || 4) / 2,
        ))),
    ) {
        this.clients = Array.from({length: slots}, () => createClient());
    }

    public createRequestId() {
        return this.clients[0]!.createRequestId();
    }

    /**
     * Runs a request once a client is free. A request with `workerKey` gets a
     * client whose worker has that key if one is free, else one with no
     * worker, else any free client, whose worker `run` then replaces by asking
     * for its key. A request without a key prefers a client whose worker runs.
     */
    public run<TResult>(
        requestId: number,
        run: (client: BrowserWorkerClient<TPendingRequest>, isAdmitted: () => boolean) => Promise<TResult>,
        workerKey?: string,
    ): Promise<TResult> {
        const request: IOwnedRequest<TPendingRequest> = {
            client: null,
            workerKey,
            start: () => {},
            reject: () => {},
        };
        const promise = new Promise<TResult>((resolve, reject) => {
            request.reject = reject;
            request.start = client => {
                request.client = client;
                try {
                    // A reset or cancellation frees the entry; a run that resumes
                    // after one reads that before it starts more work.
                    void run(client, () => this.requests.get(requestId) === request).then(resolve, reject);
                } catch (error) {
                    reject(error);
                }
            };
            this.requests.set(requestId, request);
            this.lifecycle.register(() => this.reset());
            this.admitWaitingRequests();
        });
        return promise.finally(() => {
            this.requests.delete(requestId);
            if (this.requests.size === 0) this.lifecycle.clear();
            this.admitWaitingRequests();
        });
    }

    public cancel(requestId: number, error: Error) {
        const request = this.requests.get(requestId);
        if (!request) return;
        if (request.client) {
            // Releasing admission also stops the engine. A canceled request
            // cannot keep consuming CPU while a waiting request starts.
            request.client.cancelPendingRequest(requestId, error, {resetWorker: true});
        } else {
            this.requests.delete(requestId);
            request.reject(error);
        }
    }

    /** Ends the workers of the clients that run nothing now; busy ones keep theirs until replaced. */
    public resetIdleWorkers() {
        const admitted = new Set([...this.requests.values()].map(entry => entry.client));
        for (const client of this.clients) {
            if (!admitted.has(client)) client.resetWorker();
        }
    }

    private reset() {
        const requests = [...this.requests.values()];
        this.requests.clear();
        this.lifecycle.clear();
        const error = new BrowserWorkerResetError();
        for (const request of requests) {
            request.client?.resetWorker(error);
            request.reject(error);
        }
    }

    private admitWaitingRequests() {
        const admitted = [...this.requests.values()].flatMap(entry => entry.client ? [entry.client] : []);
        for (const request of this.requests.values()) {
            if (request.client) continue;
            const free = this.clients.filter(candidate => !admitted.includes(candidate));
            const client = (request.workerKey === undefined
                ? free.find(candidate => candidate.hasWorker())
                : free.find(candidate => candidate.workerKey === request.workerKey)
                    ?? free.find(candidate => !candidate.hasWorker())) ?? free[0];
            if (!client) return;
            request.start(client);
            admitted.push(client);
        }
    }
}
