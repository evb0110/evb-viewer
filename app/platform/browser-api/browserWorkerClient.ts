import {
    BrowserWorkerClientLifecycle,
    BrowserWorkerResetError,
} from '@app/platform/browser-api/browserWorkerClientLifecycle';
export {BrowserWorkerResetError} from '@app/platform/browser-api/browserWorkerClientLifecycle';

interface IBrowserWorkerClientOptions<TPendingRequest> {
    createWorker: () => Worker;
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

    public getWorker() {
        if (this.worker) {
            this.clearIdleTerminateTimer();
            return this.worker;
        }

        const worker = this.options.createWorker();
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

/** Admission and cancellation for synchronous engines, one request per worker. */
export class BrowserWorkerRequestOwner<TPendingRequest extends {
    reject: (error: Error) => void;
    timeoutTimer?: ReturnType<typeof setTimeout> | null;
}> {
    private readonly primary: BrowserWorkerClient<TPendingRequest>;
    private readonly lifecycle = new BrowserWorkerClientLifecycle();
    private readonly requests = new Map<number, {
        client: BrowserWorkerClient<TPendingRequest> | null;
        start: (client: BrowserWorkerClient<TPendingRequest>) => void;
        reject: (error: Error) => void;
    }>();
    private readonly concurrency = Math.min(2, Math.max(1, Math.floor(
        (typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency || 4) / 2,
    )));

    public constructor(private readonly createClient: () => BrowserWorkerClient<TPendingRequest>) {
        this.primary = createClient();
    }

    public createRequestId() {
        return this.primary.createRequestId();
    }

    public run<TResult>(
        requestId: number,
        run: (client: BrowserWorkerClient<TPendingRequest>) => Promise<TResult>,
    ): Promise<TResult> {
        const request: {
            client: BrowserWorkerClient<TPendingRequest> | null;
            start: (client: BrowserWorkerClient<TPendingRequest>) => void;
            reject: (error: Error) => void;
        } = {
            client: null,
            start: () => {},
            reject: () => {},
        };
        const promise = new Promise<TResult>((resolve, reject) => {
            request.reject = reject;
            request.start = client => {
                request.client = client;
                try {
                    void run(client).then(resolve, reject);
                } catch (error) {
                    reject(error);
                }
            };
            this.requests.set(requestId, request);
            this.lifecycle.register(() => this.reset());
            this.admitWaitingRequests();
        });
        return promise.finally(() => {
            if (request.client && request.client !== this.primary) request.client.resetWorker();
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
            if (admitted.length >= this.concurrency) return;
            const client = admitted.includes(this.primary) ? this.createClient() : this.primary;
            request.start(client);
            admitted.push(client);
        }
    }
}
