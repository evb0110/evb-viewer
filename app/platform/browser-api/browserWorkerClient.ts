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
        const timeoutMs = requestTimeoutMs ?? this.options.requestTimeoutMs;
        if (typeof timeoutMs === 'number' && timeoutMs > 0) {
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

        this.pendingRequests.set(requestId, pendingRequest);
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

    private clearRequestTimeout(request: TPendingRequest) {
        if (request.timeoutTimer === undefined || request.timeoutTimer === null) {
            return;
        }

        clearTimeout(request.timeoutTimer);
        request.timeoutTimer = null;
    }
}
