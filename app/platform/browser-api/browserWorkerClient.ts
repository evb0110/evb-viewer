import {
    BrowserWorkerClientLifecycle,
    BrowserWorkerResetError,
} from '@app/platform/browser-api/browserWorkerClientLifecycle';
export {BrowserWorkerResetError} from '@app/platform/browser-api/browserWorkerClientLifecycle';
import {postPrecompiledWasmModules} from '@app/platform/browser/loadWasmWithDeadline';
import {getPerformanceProfile} from '@app/utils/performanceProfile';
import type {IResolvedStreamingRasterHandoffBudget} from '@evb/scan-cleanup/core/streamingRasterHandoff';

const DEFAULT_WARM_CANCEL_DRAIN_TIMEOUT_MS = 5_000;

function isMatchingResponseId(response: unknown, requestId: number) {
    return typeof response === 'object'
        && response !== null
        && Reflect.get(response, 'id') === requestId;
}

interface IBrowserWorkerClientOptions<TPendingRequest> {
    /**
     * Starts the worker. `key` is the kind of worker a request asked for, such
     * as an engine's thread count; a worker keeps its key for life.
     */
    createWorker: (key: string | undefined) => Worker;
    /**
     * Public WASM paths to compile once on the main thread and share with each
     * spawned worker via structured clone so worker clones never recompile.
     */
    preloadWasmPaths?: (key: string | undefined) => readonly string[];
    /** The page-wide budget a worker of a counted key holds a place in while it lives. */
    budget?: BrowserWorkerBudget;
    idleTtlMs: number;
    requestTimeoutMs?: number;
    handleMessage: (
        pendingRequests: Map<number, TPendingRequest>,
        response: unknown,
        scheduleIdleWorkerTermination: () => void,
    ) => void;
    /** Optional observer called when a stale reply from a warm-canceled request finishes draining. */
    onDrainedMessage?: (response: unknown) => void;
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
    /** Set by the request owner while it has admitted a request here. */
    public leased = false;
    /** Soft affinity hint (e.g. cached document key) kept while the worker lives. */
    public affinityKey: string | null = null;
    private currentWorkerKey: string | undefined = undefined;
    private workerEventListeners: IWorkerEventListeners | null = null;
    private workerGeneration = 0;
    private nextRequestId = 1;
    private idleTerminateTimer: ReturnType<typeof setTimeout> | null = null;
    private drainingRequestId: number | null = null;
    private drainTimer: ReturnType<typeof setTimeout> | null = null;
    private drainSettledListener: (() => void) | null = null;
    private readonly lifecycle = new BrowserWorkerClientLifecycle();

    public constructor(private readonly options: IBrowserWorkerClientOptions<TPendingRequest>) {}

    /** Registers a callback invoked whenever a warm-canceled request finishes draining or times out. */
    public setDrainSettledListener(listener: (() => void) | null) {
        this.drainSettledListener = listener;
    }

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

    private clearDrainState() {
        const wasDraining = this.drainingRequestId !== null;
        this.drainingRequestId = null;
        if (this.drainTimer !== null) {
            clearTimeout(this.drainTimer);
            this.drainTimer = null;
        }
        return wasDraining;
    }

    public scheduleIdleWorkerTermination = () => {
        this.clearIdleTerminateTimer();
        if (!this.worker || this.pendingRequests.size > 0 || this.drainingRequestId !== null) {
            return;
        }

        this.idleTerminateTimer = setTimeout(() => {
            this.idleTerminateTimer = null;
            if (!this.worker || this.pendingRequests.size > 0 || this.drainingRequestId !== null) {
                return;
            }

            this.resetWorker();
        }, this.options.idleTtlMs);
    };

    public resetWorker(error?: Error) {
        const wasDraining = this.clearDrainState();
        const pending = Array.from(this.pendingRequests.values());
        this.pendingRequests.clear();
        this.clearIdleTerminateTimer();
        pending.forEach(request => this.clearRequestTimeout(request));

        this.workerGeneration += 1;
        const worker = this.worker;
        const workerEventListeners = this.workerEventListeners;
        this.worker = null;
        this.affinityKey = null;
        this.workerEventListeners = null;
        this.lifecycle.clear();
        this.options.budget?.release(this);

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

        if (wasDraining) {
            this.drainSettledListener?.();
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

        // A worker started for a request that takes any worker has no key, and counts for nothing.
        const worker = this.options.createWorker(key);
        this.currentWorkerKey = key;
        if (this.options.budget?.counts(key)) this.options.budget.hold(this);
        const generation = this.workerGeneration + 1;
        const workerEventListeners: IWorkerEventListeners = {
            message: event => {
                if (this.worker !== worker || this.workerGeneration !== generation) {
                    return;
                }

                if (this.drainingRequestId !== null && isMatchingResponseId(event.data, this.drainingRequestId)) {
                    this.clearDrainState();
                    this.options.onDrainedMessage?.(event.data);
                    this.scheduleIdleWorkerTermination();
                    this.drainSettledListener?.();
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
        const preloadPaths = this.options.preloadWasmPaths?.(key);
        if (preloadPaths && preloadPaths.length > 0) {
            postPrecompiledWasmModules(worker, preloadPaths);
        }
        return worker;
    }

    /** Posts a control message to the live worker, if one is running, without starting one. */
    public postControlMessage(message: unknown) {
        if (!this.worker) return;
        try {
            this.worker.postMessage(message);
        } catch {
            // Ignore post failures on a closing worker.
        }
    }

    public hasWorker() {
        return this.worker !== null;
    }

    /** Whether a warm-canceled request is still finishing on this worker before it can be reused. */
    public get draining() {
        return this.drainingRequestId !== null;
    }

    /** Whether the client runs nothing and has no admitted request, so its worker may be ended. */
    public get idle() {
        return !this.leased && !this.draining && this.pendingRequests.size === 0;
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
            keepWarm?: boolean;
            drainTimeoutMs?: number;
            resetError?: Error;
        } = {},
    ) {
        const pendingRequest = this.pendingRequests.get(requestId);
        if (!pendingRequest) {
            return false;
        }

        this.pendingRequests.delete(requestId);
        this.clearRequestTimeout(pendingRequest);
        if (options.keepWarm && this.worker !== null && this.pendingRequests.size === 0) {
            this.clearIdleTerminateTimer();
            this.drainingRequestId = requestId;
            const timeoutMs = options.drainTimeoutMs ?? DEFAULT_WARM_CANCEL_DRAIN_TIMEOUT_MS;
            this.drainTimer = setTimeout(() => {
                this.drainTimer = null;
                if (this.drainingRequestId === requestId) {
                    this.resetWorker();
                }
            }, timeoutMs);
            pendingRequest.reject(error);
            return true;
        }
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

type TAnyBrowserWorkerClient = BrowserWorkerClient<{reject: (error: Error) => void}>;

/**
 * Places for workers whose key needs a scarce resource, shared by every pool
 * that runs such workers: a threaded engine's shared memory, which a browser
 * reserves in full and grants only so many of. A worker of a counted key holds
 * a place from its start until it is ended. A pool admits a request that
 * would start one only into a free place, by replacing an idle counted worker
 * of its own, or after ending an idle counted worker of any pool; otherwise
 * the request waits until a place is released.
 */
export class BrowserWorkerBudget {
    private readonly holders = new Set<TAnyBrowserWorkerClient>();
    private readonly waiters = new Set<() => void>();
    private wakeQueued = false;

    public constructor(
        private readonly limit: () => number,
        public readonly counts: (key: string | undefined) => boolean,
        /** Keys the page no longer runs; a worker of one ends as soon as its request settles. */
        public readonly retired: (key: string | undefined) => boolean = () => false,
    ) {}

    public holds(client: object) {
        return this.holders.has(client as TAnyBrowserWorkerClient);
    }

    /**
     * Whether one more counted request may run with `keepFree` places left
     * over. Only busy workers count here: an idle one can be replaced or ended.
     */
    public admits(keepFree: number) {
        let busy = 0;
        for (const holder of this.holders) {
            if (!holder.idle) busy += 1;
        }
        return busy + 1 + keepFree <= this.limit();
    }

    /** Whether one more counted worker fits beside the ones alive, busy or idle. */
    public hasRoom() {
        return this.holders.size < this.limit();
    }

    /** Ends idle counted workers until one more worker fits; call only after `admits`. */
    public makeRoom() {
        for (const holder of [...this.holders]) {
            if (this.hasRoom()) break;
            if (holder.idle) holder.resetWorker();
        }
    }

    public hold(client: object) {
        this.holders.add(client as TAnyBrowserWorkerClient);
    }

    public release(client: object) {
        if (this.holders.delete(client as TAnyBrowserWorkerClient)) this.wake();
    }

    /**
     * Lets every pool admit again, once the caller has unwound: a place was
     * released, or a request ended and left its worker idle for reclaiming.
     */
    public wake() {
        if (this.wakeQueued) return;
        this.wakeQueued = true;
        queueMicrotask(() => {
            this.wakeQueued = false;
            for (const wake of this.waiters) wake();
        });
    }

    /** Calls `wake` whenever a pool may admit again. */
    public onRelease(wake: () => void) {
        this.waiters.add(wake);
    }
}

export interface IBrowserWorkerAdmission {
    /** The key of the worker the request needs, read when it is admitted; undefined takes any worker. */
    workerKey?: () => string | undefined;
    /** Soft affinity hint (e.g. cached document key) to prefer the worker already warm for this resource. */
    affinityKey?: string;
    /** Places of the pool's budget a counted request must leave free for others, such as interactive ones. */
    budgetReserve?: number;
    /**
     * When true, canceling an in-flight request rejects the caller immediately
     * while letting the warm worker finish and discard the stale reply instead
     * of terminating the worker pool (bounded by `drainTimeoutMs`).
     */
    keepWarmOnCancel?: boolean;
    drainTimeoutMs?: number;
}

interface IOwnedRequest<TPendingRequest extends {
    reject: (error: Error) => void;
    timeoutTimer?: ReturnType<typeof setTimeout> | null;
}> {
    client: BrowserWorkerClient<TPendingRequest> | null;
    admission: IBrowserWorkerAdmission;
    start: (client: BrowserWorkerClient<TPendingRequest>, workerKey: string | undefined) => void;
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
        private readonly budget?: BrowserWorkerBudget,
    ) {
        this.clients = Array.from({length: slots}, () => {
            const client = createClient();
            client.setDrainSettledListener(() => {
                if (client.idle && this.budget?.retired(client.workerKey)) client.resetWorker();
                this.admitWaitingRequests();
                this.budget?.wake();
            });
            return client;
        });
        budget?.onRelease(() => this.admitWaitingRequests());
    }

    public createRequestId() {
        return this.clients[0]!.createRequestId();
    }

    /**
     * Runs a request once a client is free. Its worker key is read when it is
     * admitted, so a request that waited follows what the page decided since,
     * and `run` gets it to ask the client for that worker. A request with a
     * key gets a client whose worker has that key if one is free, else one
     * with no worker, else any free client, whose worker is then replaced. A
     * request without a key prefers a client whose worker runs. A key the
     * owner's budget counts is admitted only within the budget.
     */
    public run<TResult>(
        requestId: number,
        run: (
            client: BrowserWorkerClient<TPendingRequest>,
            isAdmitted: () => boolean,
            workerKey: string | undefined,
        ) => Promise<TResult>,
        admission: IBrowserWorkerAdmission = {},
    ): Promise<TResult> {
        const request: IOwnedRequest<TPendingRequest> = {
            client: null,
            admission,
            start: () => {},
            reject: () => {},
        };
        const promise = new Promise<TResult>((resolve, reject) => {
            request.reject = reject;
            request.start = (client, workerKey) => {
                request.client = client;
                client.leased = true;
                if (admission.affinityKey !== undefined) {
                    client.affinityKey = admission.affinityKey;
                }
                try {
                    // A reset or cancellation frees the entry; a run that resumes
                    // after one reads that before it starts more work.
                    void run(client, () => this.requests.get(requestId) === request, workerKey).then(resolve, reject);
                } catch (error) {
                    reject(error);
                }
            };
            this.requests.set(requestId, request);
            this.lifecycle.register(() => this.reset());
            this.admitWaitingRequests();
        });
        return promise.finally(() => {
            if (request.client) {
                request.client.leased = false;
                if (request.client.idle && this.budget?.retired(request.client.workerKey)) request.client.resetWorker();
            }
            this.requests.delete(requestId);
            if (this.requests.size === 0) this.lifecycle.clear();
            this.admitWaitingRequests();
            this.budget?.wake();
        });
    }

    public cancel(requestId: number, error: Error) {
        const request = this.requests.get(requestId);
        if (!request) return;
        if (request.client) {
            if (request.admission.keepWarmOnCancel) {
                const canceledPending = request.client.cancelPendingRequest(requestId, error, {
                    keepWarm: true,
                    ...(request.admission.drainTimeoutMs === undefined
                        ? {}
                        : {drainTimeoutMs: request.admission.drainTimeoutMs}),
                });
                if (!canceledPending) {
                    this.requests.delete(requestId);
                    request.reject(error);
                }
                return;
            }
            // Releasing admission also stops the engine. A canceled request
            // cannot keep consuming CPU while a waiting request starts.
            request.client.cancelPendingRequest(requestId, error, {resetWorker: true});
        } else {
            this.requests.delete(requestId);
            request.reject(error);
        }
    }

    /** Sends a control message to every currently live worker in the pool without spawning new ones. */
    public postToActiveWorkers(message: unknown, clearAffinityPrefix?: string) {
        for (const client of this.clients) {
            if (clearAffinityPrefix !== undefined && client.affinityKey?.startsWith(clearAffinityPrefix)) {
                client.affinityKey = null;
            }
            client.postControlMessage(message);
        }
    }

    /** Ends the workers of the clients that run nothing now; busy ones keep theirs until replaced. */
    public resetIdleWorkers() {
        for (const client of this.clients) {
            if (client.idle) client.resetWorker();
        }
    }

    private reset() {
        const requests = [...this.requests.values()];
        for (const request of requests) {
            if (request.client) request.client.leased = false;
        }
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
            const free = this.clients.filter(candidate => !admitted.includes(candidate) && !candidate.draining);
            if (free.length === 0) return;
            const workerKey = request.admission.workerKey?.();
            const client = this.chooseClient(
                free,
                workerKey,
                request.admission.budgetReserve ?? 0,
                request.admission.affinityKey,
            );
            // A request waiting for a budget place or draining same-key worker lets later independent ones start.
            if (!client) continue;
            request.start(client, workerKey);
            admitted.push(client);
        }
    }

    private chooseClient(
        free: Array<BrowserWorkerClient<TPendingRequest>>,
        workerKey: string | undefined,
        keepFree: number,
        affinityKey?: string,
    ) {
        if (workerKey === undefined) {
            if (affinityKey !== undefined) {
                return free.find(candidate => candidate.hasWorker() && candidate.affinityKey === affinityKey)
                    ?? free.find(candidate => candidate.hasWorker() && candidate.affinityKey === null)
                    ?? free.find(candidate => !candidate.hasWorker())
                    ?? free[0];
            }
            return free.find(candidate => candidate.hasWorker()) ?? free[0];
        }
        const budget = this.budget?.counts(workerKey) ? this.budget : null;
        if (budget && !budget.admits(keepFree)) return null;
        const same = free.find(candidate => candidate.workerKey === workerKey);
        if (same) return same;
        // Wait for a warm worker of the exact same key that is finishing a
        // warm-canceled request rather than cold-booting a duplicate worker pool.
        if (this.clients.some(candidate => candidate.draining && candidate.workerKey === workerKey)) {
            return null;
        }
        const empty = free.find(candidate => !candidate.hasWorker()) ?? free[0];
        if (!budget || budget.hasRoom()) return empty;
        // Replacing an idle counted worker of this pool keeps the count.
        const holder = free.find(candidate => budget.holds(candidate));
        if (holder) return holder;
        budget.makeRoom();
        return empty;
    }
}
