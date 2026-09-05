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
    private nextRequestId = 1;
    private idleTerminateTimer: ReturnType<typeof setTimeout> | null = null;
    private cleanupListenerRegistered = false;

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

        if (this.worker) {
            this.worker.removeEventListener('message', this.handleWorkerMessage);
            this.worker.removeEventListener('error', this.handleWorkerError);
            this.worker.terminate();
            this.worker = null;
        }

        if (error) {
            pending.forEach(request => request.reject(error));
        }
    }

    public getWorker() {
        if (this.worker) {
            this.clearIdleTerminateTimer();
            return this.worker;
        }

        const worker = this.options.createWorker();
        worker.addEventListener('message', this.handleWorkerMessage);
        worker.addEventListener('error', this.handleWorkerError);
        this.registerCleanupListener();
        this.worker = worker;
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

    private readonly handleWorkerMessage = (event: MessageEvent<unknown>) => {
        this.options.handleMessage(
            this.pendingRequests,
            event.data,
            this.scheduleIdleWorkerTermination,
        );
    };

    private readonly handleWorkerError = (event: ErrorEvent) => {
        this.resetWorker(this.options.createError(event));
    };

    private readonly handleWindowBeforeUnload = () => {
        this.resetWorker();
    };

    private registerCleanupListener() {
        if (
            this.cleanupListenerRegistered
            || typeof window === 'undefined'
            || typeof window.addEventListener !== 'function'
        ) {
            return;
        }

        this.cleanupListenerRegistered = true;
        window.addEventListener('beforeunload', this.handleWindowBeforeUnload);
    }

    private clearRequestTimeout(request: TPendingRequest) {
        if (!request.timeoutTimer) {
            return;
        }

        clearTimeout(request.timeoutTimer);
        request.timeoutTimer = null;
    }
}
