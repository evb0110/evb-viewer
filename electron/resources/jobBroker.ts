import { clamp } from 'es-toolkit/math';
import type { IHostResourceProfileSnapshot } from '@contracts/hostResourceProfile';
import type { ISystemMemoryInfo } from '@contracts/systemPlatformFeature';
import { readSystemMemoryInfo } from '@electron/resources/systemMemoryInfo';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('job-broker');

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const DEFAULT_AGING_INTERVAL_MS = 5_000;
const DEFAULT_MEMORY_PRESSURE_POLL_INTERVAL_MS = 500;
const DEFAULT_PENDING_ALLOCATION_SETTLE_MS = 2_000;
const DEFAULT_JOB_BROKER_MAX_QUEUED_JOBS = 256;
const DEFAULT_JOB_BROKER_MAX_QUEUED_JOBS_PER_OWNER = 64;
const LIVE_MEMORY_RESERVE_MIN_BYTES = 512 * MIB;
const LIVE_MEMORY_RESERVE_MAX_BYTES = 1 * GIB;

export const MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES: Readonly<IJobResourceVector> = {
    cpuTokens: 1,
    estimatedResidentBytes: 512 * MIB,
    nativeProcesses: 1,
    ioWeight: 4,
};

export const MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES: Readonly<IJobResourceVector> = {
    cpuTokens: 1,
    estimatedResidentBytes: 256 * MIB,
    nativeProcesses: 1,
    ioWeight: 1,
};

// Bulk capacity remains the sustained-throughput budget. Two bounded burst
// slots let one tab keep its visible work while another opens and renders a
// document, without turning the reserve into unbounded per-tab overcommit.
export const MAIN_JOB_BROKER_INTERACTIVE_RESERVE: Readonly<IJobResourceVector> = {
    cpuTokens: 2 * MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES.cpuTokens,
    estimatedResidentBytes: 2 * MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES.estimatedResidentBytes,
    nativeProcesses: 2 * MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES.nativeProcesses,
    ioWeight: 2 * MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES.ioWeight,
};

export type TJobBrokerPriority = 'visible' | 'foreground' | 'user' | 'background';
/**
 * `bulk` work shares the sustained capacity, `interactive` work may also use
 * the bounded reserve. A `leaf` never waits for another lease while it holds
 * its own, as a single native command does. Its caller may already hold a
 * lease the broker cannot see, so a leaf is admitted like bulk work, or,
 * while some other lease is running and no other leaf is, past the capacity:
 * waiting for capacity that its own caller holds would never end. That
 * escape needs the processes charged to be within the process budget, so
 * leaves kept charged for children not proven gone overrun it by at most one.
 */
export type TJobBrokerAdmissionClass = 'bulk' | 'interactive' | 'leaf';

export interface IJobResourceVector {
    cpuTokens: number;
    estimatedResidentBytes: number;
    nativeProcesses: number;
    ioWeight: number;
}

export interface IJobBrokerRequest {
    ownerId: string;
    kind: string;
    priority: TJobBrokerPriority;
    admissionClass?: TJobBrokerAdmissionClass;
    resources: IJobResourceVector;
    perOwnerLimit?: number;
    signal?: AbortSignal;
}

export interface IJobBrokerLease {
    readonly token: string;
    readonly resources: IJobResourceVector;
    release: () => boolean;
    /**
     * Lowers the charge to a smaller vector without a moment uncharged, as a
     * worker that keeps its memory but gives back its core does.
     */
    shrink: (resources: IJobResourceVector) => boolean;
}

export type TTerminationProofSink = (proof: Promise<boolean>) => void;

export interface IJobBrokerRunContext {
    /**
     * Keeps the lease charged until every recorded native child is proven
     * gone. Passing this context to a native command also tells the command
     * that it runs under `lease`, so it does not ask the broker for another.
     */
    onTerminationProof: TTerminationProofSink;
    /**
     * Raw broker lease-accounting proof sink without caller-specific observers
     * or transformations, for internal probes (such as `--build-id`) that run
     * under `lease` without touching caller scratch files.
     */
    readonly leaseTerminationProof?: TTerminationProofSink;
    readonly lease: IJobBrokerLease;
    readonly broker: JobBroker;
}

/**
 * Returns `brokerRun.lease` only when `brokerRun.broker` is a real `JobBroker`
 * (matching `expectedBroker` when given) and that exact lease is currently
 * running (not released and not merely retained for an unproven child).
 */
export function getActiveJobBrokerLease(
    brokerRun: IJobBrokerRunContext | undefined,
    expectedBroker?: JobBroker,
): IJobBrokerLease | undefined {
    if (brokerRun === undefined || !(brokerRun.broker instanceof JobBroker)) {
        return undefined;
    }
    if (expectedBroker !== undefined && brokerRun.broker !== expectedBroker) {
        return undefined;
    }
    return brokerRun.broker.isRunningLease(brokerRun.lease)
        ? brokerRun.lease
        : undefined;
}

/**
 * Combines two termination-proof sinks without invoking the same callback
 * twice when both point to the same function. Invokes `outer` first so a
 * throwing local observer cannot prevent the owning broker from recording the
 * proof.
 */
export function mergeTerminationProofSinks(
    outer: TTerminationProofSink | undefined,
    own: TTerminationProofSink | undefined,
): TTerminationProofSink | undefined {
    if (outer === undefined) {
        return own;
    }
    if (own === undefined || own === outer) {
        return outer;
    }
    return (proof) => {
        try {
            outer(proof);
        } finally {
            own(proof);
        }
    };
}

/**
 * Returns a run context with the same `broker` and `lease` as `outer`,
 * forwarding each proof to `outer.onTerminationProof` first and also recording
 * it with `own` even if `own` throws.
 */
export function chainJobBrokerRunContext(
    outer: IJobBrokerRunContext,
    own: TTerminationProofSink | undefined,
): IJobBrokerRunContext;
export function chainJobBrokerRunContext(
    outer: IJobBrokerRunContext | undefined,
    own: TTerminationProofSink | undefined,
): IJobBrokerRunContext | undefined;
export function chainJobBrokerRunContext(
    outer: IJobBrokerRunContext | undefined,
    own: TTerminationProofSink | undefined,
): IJobBrokerRunContext | undefined {
    if (outer === undefined || own === undefined || own === outer.onTerminationProof) {
        return outer;
    }
    return {
        broker: outer.broker,
        lease: outer.lease,
        leaseTerminationProof: outer.leaseTerminationProof ?? outer.onTerminationProof,
        onTerminationProof: (proof) => {
            try {
                outer.onTerminationProof(proof);
            } finally {
                own(proof);
            }
        },
    };
}

/**
 * Returns a run context with the same `broker` and `lease` as `outer`,
 * replacing `onTerminationProof` with the sink produced by `wrap`.
 */
export function mapJobBrokerRunTerminationProof(
    outer: IJobBrokerRunContext,
    wrap: (outerSink: TTerminationProofSink) => TTerminationProofSink,
): IJobBrokerRunContext;
export function mapJobBrokerRunTerminationProof(
    outer: IJobBrokerRunContext | undefined,
    wrap: (outerSink: TTerminationProofSink) => TTerminationProofSink,
): IJobBrokerRunContext | undefined;
export function mapJobBrokerRunTerminationProof(
    outer: IJobBrokerRunContext | undefined,
    wrap: (outerSink: TTerminationProofSink) => TTerminationProofSink,
): IJobBrokerRunContext | undefined {
    if (outer === undefined) {
        return undefined;
    }
    return {
        broker: outer.broker,
        lease: outer.lease,
        leaseTerminationProof: outer.leaseTerminationProof ?? outer.onTerminationProof,
        onTerminationProof: wrap(outer.onTerminationProof),
    };
}

// Broker ownership is an admission/fairness identity, not a work identifier.
// Features that create a fresh UUID for every request must derive this from
// their stable renderer and logical-owner identities instead, otherwise a
// per-owner limit silently becomes a per-request limit.
export function createStableJobBrokerOwnerId(
    feature: string,
    senderId: number,
    logicalOwnerId: string,
) {
    return `${feature}:${senderId}:${logicalOwnerId}`;
}

interface IActiveJob extends IJobBrokerRequest {
    token: string;
    lease: IJobBrokerLease;
    grantedAt: number;
    pendingResidentBytes: number;
}

interface IQueuedJob {
    id: number;
    enqueuedAt: number;
    request: IJobBrokerRequest;
    resolve: (lease: IJobBrokerLease) => void;
    reject: (reason: Error) => void;
    removeAbortListener: () => void;
}

interface IJobBrokerOptions {
    agingIntervalMs?: number;
    now?: () => number;
    maxQueuedJobs?: number;
    maxQueuedJobsPerOwner?: number;
    maxInteractiveJobResources?: IJobResourceVector;
    interactiveReserve?: IJobResourceVector;
    readSystemMemoryInfo?: () => ISystemMemoryInfo | null;
    liveMemoryReserveBytes?: number;
    memoryPressurePollIntervalMs?: number;
    pendingAllocationSettleMs?: number;
}

const ZERO_RESOURCES: Readonly<IJobResourceVector> = {
    cpuTokens: 0,
    estimatedResidentBytes: 0,
    nativeProcesses: 0,
    ioWeight: 0,
};

const PRIORITY_RANK: Record<TJobBrokerPriority, number> = {
    visible: 0,
    foreground: 1,
    user: 2,
    background: 3,
};

function resolveLiveMemoryReserveBytes(totalBytes: number) {
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
        return 0;
    }
    return Math.round(
        clamp(
            totalBytes * 0.1,
            Math.min(totalBytes / 4, LIVE_MEMORY_RESERVE_MIN_BYTES),
            LIVE_MEMORY_RESERVE_MAX_BYTES,
        ),
    );
}

function addResources(left: IJobResourceVector, right: IJobResourceVector): IJobResourceVector {
    return {
        cpuTokens: left.cpuTokens + right.cpuTokens,
        estimatedResidentBytes: left.estimatedResidentBytes + right.estimatedResidentBytes,
        nativeProcesses: left.nativeProcesses + right.nativeProcesses,
        ioWeight: left.ioWeight + right.ioWeight,
    };
}

function subtractResources(left: IJobResourceVector, right: IJobResourceVector): IJobResourceVector {
    return {
        cpuTokens: left.cpuTokens - right.cpuTokens,
        estimatedResidentBytes: left.estimatedResidentBytes - right.estimatedResidentBytes,
        nativeProcesses: left.nativeProcesses - right.nativeProcesses,
        ioWeight: left.ioWeight - right.ioWeight,
    };
}

function isNonNegativeFinite(value: number) {
    return Number.isFinite(value) && value >= 0;
}

function validateResourceVector(resources: IJobResourceVector) {
    if (
        !isNonNegativeFinite(resources.cpuTokens)
        || !isNonNegativeFinite(resources.estimatedResidentBytes)
        || !isNonNegativeFinite(resources.nativeProcesses)
        || !isNonNegativeFinite(resources.ioWeight)
    ) {
        throw new TypeError('Job resource values must be non-negative finite numbers');
    }
}

function createAbortError(signal: AbortSignal) {
    return signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The resource request was aborted.', 'AbortError');
}

export class JobBroker {
    private readonly active = new Map<string, IActiveJob>();
    // Leases whose work has ended but whose native children are not yet
    // proven gone. They stay charged and wait for no one.
    private readonly retained = new Set<string>();
    private readonly memoryReclaimers = new Set<() => void>();
    private readonly queue: IQueuedJob[] = [];
    private counter = 0;
    private readonly agingIntervalMs: number;
    private readonly now: () => number;
    private readonly maxQueuedJobs: number;
    private readonly maxQueuedJobsPerOwner: number;
    private readonly maxInteractiveJobResources: IJobResourceVector;
    private readonly interactiveReserve: IJobResourceVector;
    private readonly readSystemMemoryInfo: (() => ISystemMemoryInfo | null) | undefined;
    private readonly liveMemoryReserveBytes: number | undefined;
    private readonly memoryPressurePollIntervalMs: number;
    private readonly pendingAllocationSettleMs: number;
    private lastObservedAvailableBytes: number | null = null;
    private memoryPressureTimer: ReturnType<typeof setTimeout> | null = null;
    private reclaimingMemory = false;
    private usedResources: IJobResourceVector = {...ZERO_RESOURCES};
    private usedBulkResources: IJobResourceVector = {...ZERO_RESOURCES};

    constructor(
        private capacity: IJobResourceVector,
        options: IJobBrokerOptions = {},
    ) {
        this.agingIntervalMs = options.agingIntervalMs ?? DEFAULT_AGING_INTERVAL_MS;
        this.now = options.now ?? Date.now;
        this.maxQueuedJobs = options.maxQueuedJobs ?? DEFAULT_JOB_BROKER_MAX_QUEUED_JOBS;
        this.maxQueuedJobsPerOwner = options.maxQueuedJobsPerOwner
            ?? DEFAULT_JOB_BROKER_MAX_QUEUED_JOBS_PER_OWNER;
        this.interactiveReserve = {...(options.interactiveReserve ?? ZERO_RESOURCES)};
        this.maxInteractiveJobResources = {...(
            options.maxInteractiveJobResources
            ?? options.interactiveReserve
            ?? ZERO_RESOURCES
        )};
        this.readSystemMemoryInfo = options.readSystemMemoryInfo;
        this.liveMemoryReserveBytes = options.liveMemoryReserveBytes;
        this.memoryPressurePollIntervalMs = options.memoryPressurePollIntervalMs
            ?? DEFAULT_MEMORY_PRESSURE_POLL_INTERVAL_MS;
        this.pendingAllocationSettleMs = options.pendingAllocationSettleMs
            ?? DEFAULT_PENDING_ALLOCATION_SETTLE_MS;
        validateResourceVector(capacity);
        validateResourceVector(this.maxInteractiveJobResources);
        validateResourceVector(this.interactiveReserve);
        if (!Number.isSafeInteger(this.maxQueuedJobs) || this.maxQueuedJobs < 1) {
            throw new TypeError('Job broker queue limit must be a positive safe integer');
        }
        if (!Number.isSafeInteger(this.maxQueuedJobsPerOwner) || this.maxQueuedJobsPerOwner < 1) {
            throw new TypeError('Job broker per-owner queue limit must be a positive safe integer');
        }
        if (this.liveMemoryReserveBytes !== undefined && !isNonNegativeFinite(this.liveMemoryReserveBytes)) {
            throw new TypeError('Job broker live memory reserve must be a non-negative finite number');
        }
        if (!isNonNegativeFinite(this.memoryPressurePollIntervalMs)) {
            throw new TypeError('Job broker memory pressure poll interval must be a non-negative finite number');
        }
        if (!isNonNegativeFinite(this.pendingAllocationSettleMs)) {
            throw new TypeError('Job broker pending allocation settle window must be a non-negative finite number');
        }
    }

    reconfigureCapacity(capacity: IJobResourceVector) {
        if (this.active.size > 0 || this.queue.length > 0) {
            throw new Error('Job broker capacity cannot be reconfigured after work is admitted');
        }
        validateResourceVector(capacity);
        this.capacity = capacity;
    }

    acquire(request: IJobBrokerRequest): Promise<IJobBrokerLease> {
        validateResourceVector(request.resources);
        if (
            request.admissionClass === 'interactive'
            && !this.fitsWithin(request.resources, this.maxInteractiveJobResources)
        ) {
            return Promise.reject(new RangeError(
                `Interactive job ${request.kind} exceeds broker interactive job limit`,
            ));
        }
        if (!this.fitsWithin(request.resources, this.capacity)) {
            return Promise.reject(new RangeError(`Job ${request.kind} exceeds broker capacity`));
        }
        if (request.signal?.aborted) {
            return Promise.reject(createAbortError(request.signal));
        }
        if (this.queue.length >= this.maxQueuedJobs) {
            return Promise.reject(new RangeError(`Job broker queue is full (${this.maxQueuedJobs} jobs)`));
        }
        let ownerQueuedJobs = 0;
        for (const queued of this.queue) {
            if (queued.request.ownerId === request.ownerId) {
                ownerQueuedJobs += 1;
            }
        }
        if (ownerQueuedJobs >= this.maxQueuedJobsPerOwner) {
            return Promise.reject(new RangeError(
                `Job broker owner queue is full (${this.maxQueuedJobsPerOwner} jobs for ${request.ownerId})`,
            ));
        }
        return new Promise<IJobBrokerLease>((resolve, reject) => {
            const id = ++this.counter;
            const handleAbort = () => {
                const index = this.queue.findIndex(item => item.id === id);
                if (index < 0) {
                    return;
                }
                const [queued] = this.queue.splice(index, 1);
                queued?.removeAbortListener();
                reject(createAbortError(request.signal!));
                // A blocked head that leaves may have held back runnable work.
                this.dispatch();
            };
            request.signal?.addEventListener('abort', handleAbort, {once: true});
            this.queue.push({
                id,
                enqueuedAt: this.now(),
                request,
                resolve,
                reject,
                removeAbortListener: () => request.signal?.removeEventListener('abort', handleAbort),
            });
            this.dispatch();
        });
    }

    async run<T>(
        request: IJobBrokerRequest,
        work: (context: IJobBrokerRunContext) => Promise<T>,
    ): Promise<T> {
        const lease = await this.acquire(request);
        let pendingProofs = 0;
        let hasUnprovenProof = false;
        let workSettled = false;
        const onTerminationProof: TTerminationProofSink = (proof) => {
            pendingProofs += 1;
            void proof.catch(() => false).then((proven) => {
                pendingProofs -= 1;
                if (!proven) {
                    hasUnprovenProof = true;
                }
                if (workSettled && pendingProofs === 0 && !hasUnprovenProof) {
                    lease.release();
                }
            });
        };
        let workStarted = false;
        try {
            request.signal?.throwIfAborted();
            workStarted = true;
            return await work({
                broker: this,
                onTerminationProof,
                leaseTerminationProof: onTerminationProof,
                lease,
            });
        } finally {
            workSettled = true;
            const hasOutstandingOrFailedProof = pendingProofs > 0 || hasUnprovenProof;
            // Only a lease whose own native child has a pending or unprovable
            // proof stays charged for it. A sibling abort reason without any
            // recorded child proof releases immediately.
            if (!workStarted || !hasOutstandingOrFailedProof) {
                lease.release();
            } else if (this.active.has(lease.token)) {
                this.retained.add(lease.token);
                this.dispatch();
            }
        }
    }

    /**
     * Called when queued work waits for memory, so owners of idle caches,
     * such as warm OCR workers, can end them and release what they hold.
     */
    registerMemoryReclaimer(reclaim: () => void) {
        this.memoryReclaimers.add(reclaim);
        return () => {
            this.memoryReclaimers.delete(reclaim);
        };
    }

    isActive(lease: Pick<IJobBrokerLease, 'token'>) {
        return this.active.has(lease.token);
    }

    /**
     * Whether `lease` is the exact, currently-running lease object issued by
     * this broker (not released and not merely retained for an unproven child).
     */
    isRunningLease(lease: IJobBrokerLease) {
        const active = this.active.get(lease.token);
        return active !== undefined && active.lease === lease && !this.retained.has(lease.token);
    }

    /**
     * Runs admission again, for an owner whose idle cache became reclaimable
     * without any lease changing, so queued work short of memory can reclaim it.
     */
    recheck() {
        this.dispatch();
    }

    /** Whether this request still waits in the queue; false once granted, rejected or removed. */
    isQueued(request: IJobBrokerRequest) {
        return this.queue.some(queued => queued.request === request);
    }

    release(token: string) {
        const active = this.active.get(token);
        if (!active) {
            return false;
        }
        // Reconcile any OS memory drop against this lease first before removing
        // it so its own allocation is not misattributed to a sibling's pending
        // reservation regardless of grant order.
        if (active.pendingResidentBytes > 0) {
            this.reconcilePendingMemory(this.readCurrentSystemMemoryInfo(), token);
        }
        this.active.delete(token);
        this.retained.delete(token);
        this.accountLease(active, subtractResources);
        this.dispatch();
        return true;
    }

    // Active leases represent live OS resources that remain charged until their
    // holder exits or proves native termination and calls `lease.release()`.
    // Cancelling an owner therefore rejects only queued requests so active
    // native children cannot be under-accounted before they exit.
    cancelOwner(ownerId: string, reason = `Resource requests canceled for owner ${ownerId}`) {
        for (let index = this.queue.length - 1; index >= 0; index -= 1) {
            const queued = this.queue[index];
            if (queued?.request.ownerId !== ownerId) {
                continue;
            }
            this.queue.splice(index, 1);
            queued.removeAbortListener();
            queued.reject(new Error(reason));
        }
        // A blocked head that leaves may have held back runnable work.
        this.dispatch();
    }

    getSnapshot() {
        return {
            capacity: {...this.capacity},
            maxInteractiveJobResources: {...this.maxInteractiveJobResources},
            interactiveReserve: {...this.interactiveReserve},
            active: this.active.size,
            queued: this.queue.length,
            used: {...this.usedResources},
            usedBulk: {...this.usedBulkResources},
        };
    }

    private shrink(token: string, resources: IJobResourceVector) {
        const active = this.active.get(token);
        if (!active) {
            return false;
        }
        validateResourceVector(resources);
        if (!this.fitsWithin(resources, active.resources)) {
            throw new RangeError(`Lease ${token} can only shrink`);
        }
        // Reconcile any OS memory drop against this lease first BEFORE clearing
        // or clamping its pending allocation so its own allocation is not
        // credited to another still-pending sibling lease regardless of grant order.
        if (active.pendingResidentBytes > 0) {
            this.reconcilePendingMemory(this.readCurrentSystemMemoryInfo(), token);
        }
        this.accountLease(active, subtractResources);
        active.resources = {...resources};
        if (this.isParkedMemoryLease(resources)) {
            // Parked memory-only leases (such as warm idle OCR workers) hold
            // already-resident memory that the OS snapshot already deducts.
            active.pendingResidentBytes = 0;
        } else {
            active.pendingResidentBytes = Math.min(active.pendingResidentBytes, resources.estimatedResidentBytes);
        }
        this.accountLease(active, addResources);
        this.dispatch();
        return true;
    }

    private dispatch() {
        while (this.queue.length > 0) {
            const memoryInfo = this.readCurrentSystemMemoryInfo();
            const pendingBytes = this.reconcilePendingMemory(memoryInfo);
            const selection = this.findNextGrantable(memoryInfo, pendingBytes);
            if (selection.index < 0) {
                let shouldPollLiveMemory = selection.shouldPollLiveMemory;
                if (!this.reclaimingMemory && this.memoryReclaimers.size > 0 && selection.shortOfMemory) {
                    this.reclaimingMemory = true;
                    try {
                        for (const reclaim of Array.from(this.memoryReclaimers)) {
                            try {
                                reclaim();
                            } catch (error) {
                                let message = 'Unknown error';
                                try {
                                    message = getErrorMessage(error);
                                } catch {
                                    // Null-prototype or hostile thrown objects must not abort broker dispatch.
                                }
                                logger.warn('Job broker memory reclaimer failed', {error: message});
                            }
                        }
                    } finally {
                        this.reclaimingMemory = false;
                    }
                    if (this.queue.length === 0) {
                        this.clearMemoryPressureTimer();
                        return;
                    }
                    if (memoryInfo !== null) {
                        const updatedMemoryInfo = this.readCurrentSystemMemoryInfo();
                        const updatedPendingBytes = this.reconcilePendingMemory(updatedMemoryInfo);
                        const rechecked = this.findNextGrantable(updatedMemoryInfo, updatedPendingBytes);
                        shouldPollLiveMemory = rechecked.shouldPollLiveMemory;
                        if (rechecked.index >= 0) {
                            continue;
                        }
                    }
                }
                this.syncMemoryPressureTimer(shouldPollLiveMemory);
                return;
            }
            const [next] = this.queue.splice(selection.index, 1);
            if (!next) {
                this.clearMemoryPressureTimer();
                return;
            }
            next.removeAbortListener();
            const token = `job-${next.id}`;
            let released = false;
            const active: IActiveJob = {
                ...next.request,
                resources: {...next.request.resources},
                token,
                lease: undefined as unknown as IJobBrokerLease,
                grantedAt: this.now(),
                pendingResidentBytes: next.request.resources.estimatedResidentBytes,
            };
            const lease: IJobBrokerLease = {
                token,
                get resources() {
                    return {...active.resources};
                },
                release: () => {
                    if (released) {
                        return false;
                    }
                    released = true;
                    return this.release(token);
                },
                shrink: resources => !released && this.shrink(token, resources),
            };
            active.lease = lease;
            this.active.set(token, active);
            this.accountLease(active, addResources);
            next.resolve(lease);
        }
        this.clearMemoryPressureTimer();
    }

    private clearMemoryPressureTimer() {
        if (this.memoryPressureTimer !== null) {
            clearTimeout(this.memoryPressureTimer);
            this.memoryPressureTimer = null;
        }
    }

    private syncMemoryPressureTimer(stalledByLiveMemory: boolean) {
        if (this.queue.length === 0 || !stalledByLiveMemory || this.memoryPressurePollIntervalMs <= 0) {
            this.clearMemoryPressureTimer();
            return;
        }
        if (this.memoryPressureTimer !== null) {
            return;
        }
        const timer = setTimeout(() => {
            this.memoryPressureTimer = null;
            if (this.queue.length > 0) {
                this.dispatch();
            }
        }, this.memoryPressurePollIntervalMs);
        timer.unref?.();
        this.memoryPressureTimer = timer;
    }

    private readCurrentSystemMemoryInfo(): ISystemMemoryInfo | null {
        if (!this.readSystemMemoryInfo) {
            return null;
        }
        try {
            const info = this.readSystemMemoryInfo();
            if (
                info === null
                || !Number.isFinite(info.totalBytes)
                || info.totalBytes <= 0
                || !Number.isFinite(info.availableBytes)
                || info.availableBytes < 0
            ) {
                return null;
            }
            return info;
        } catch {
            return null;
        }
    }

    /**
     * Tracks only outstanding (unobserved) allocations from recently granted
     * leases against live OS available memory so resident/parked leases are not
     * double-counted while same-turn bursts (including leaf escapes) cannot
     * overcommit past available RAM.
     */
    private reconcilePendingMemory(memoryInfo: ISystemMemoryInfo | null, preferredToken?: string) {
        const now = this.now();
        for (const active of this.active.values()) {
            if (active.pendingResidentBytes > 0 && now - active.grantedAt >= this.pendingAllocationSettleMs) {
                active.pendingResidentBytes = 0;
            }
        }
        if (memoryInfo === null) {
            this.lastObservedAvailableBytes = null;
            return 0;
        }
        if (this.lastObservedAvailableBytes !== null && memoryInfo.availableBytes < this.lastObservedAvailableBytes) {
            let drop = this.lastObservedAvailableBytes - memoryInfo.availableBytes;
            if (preferredToken !== undefined) {
                const preferred = this.active.get(preferredToken);
                if (preferred && preferred.pendingResidentBytes > 0) {
                    const absorbed = Math.min(preferred.pendingResidentBytes, drop);
                    preferred.pendingResidentBytes -= absorbed;
                    drop -= absorbed;
                }
            }
            for (const active of this.active.values()) {
                if (drop <= 0) {
                    break;
                }
                if (active.token === preferredToken || active.pendingResidentBytes <= 0) {
                    continue;
                }
                const absorbed = Math.min(active.pendingResidentBytes, drop);
                active.pendingResidentBytes -= absorbed;
                drop -= absorbed;
            }
        }
        this.lastObservedAvailableBytes = memoryInfo.availableBytes;
        let pendingBytes = 0;
        for (const active of this.active.values()) {
            pendingBytes += active.pendingResidentBytes;
        }
        return pendingBytes;
    }

    private isParkedMemoryLease(resources: IJobResourceVector) {
        return resources.cpuTokens === 0 && resources.nativeProcesses === 0 && resources.ioWeight === 0;
    }

    private hasActiveWork() {
        for (const active of this.active.values()) {
            if (!this.isParkedMemoryLease(active.resources)) {
                return true;
            }
        }
        return false;
    }

    private getIdleLiveMemoryHeadroomBytes(memoryInfo: ISystemMemoryInfo | null) {
        if (memoryInfo === null) {
            return Number.POSITIVE_INFINITY;
        }
        const bulkReserve = this.liveMemoryReserveBytes ?? resolveLiveMemoryReserveBytes(memoryInfo.totalBytes);
        // On an otherwise idle broker (no active work running), keep a tighter
        // OOM safety floor (1/4 of the bulk reserve, e.g. 128 MiB on 4 GiB,
        // 256 MiB on >=10 GiB) so single fitting operations (such as 128 MiB
        // pdfinfo probes at 380 MiB available or 512 MiB conformance at 900 MiB)
        // always make forward progress instead of stalling indefinitely.
        const idleOomFloorReserve = Math.floor(bulkReserve / 4);
        return Math.max(0, memoryInfo.availableBytes - idleOomFloorReserve);
    }

    private getLiveMemoryHeadroomBytes(
        admissionClass: TJobBrokerAdmissionClass | undefined,
        memoryInfo: ISystemMemoryInfo | null,
        forLeafEscape = false,
    ) {
        if (memoryInfo === null) {
            return Number.POSITIVE_INFINITY;
        }
        if (!this.hasActiveWork()) {
            return this.getIdleLiveMemoryHeadroomBytes(memoryInfo);
        }
        const bulkReserve = this.liveMemoryReserveBytes ?? resolveLiveMemoryReserveBytes(memoryInfo.totalBytes);
        const interactiveReserve = Math.floor(bulkReserve / 2);
        const reserve = admissionClass === 'interactive' || forLeafEscape ? interactiveReserve : bulkReserve;
        return Math.max(0, memoryInfo.availableBytes - reserve);
    }

    private fitsLiveMemory(request: IJobBrokerRequest, memoryInfo: ISystemMemoryInfo | null, pendingBytes: number) {
        const bytes = request.resources.estimatedResidentBytes;
        if (bytes <= 0 || memoryInfo === null) {
            return true;
        }
        return pendingBytes + bytes <= this.getLiveMemoryHeadroomBytes(request.admissionClass, memoryInfo);
    }

    private fitsLeafLiveMemory(request: IJobBrokerRequest, memoryInfo: ISystemMemoryInfo | null, pendingBytes: number) {
        const bytes = request.resources.estimatedResidentBytes;
        if (bytes <= 0 || memoryInfo === null) {
            return true;
        }
        return pendingBytes + bytes <= this.getLiveMemoryHeadroomBytes(request.admissionClass, memoryInfo, true);
    }

    private accountLease(
        lease: Pick<IJobBrokerRequest, 'admissionClass' | 'resources'>,
        apply: (left: IJobResourceVector, right: IJobResourceVector) => IJobResourceVector,
    ) {
        this.usedResources = apply(this.usedResources, lease.resources);
        if (lease.admissionClass !== 'interactive') {
            this.usedBulkResources = apply(this.usedBulkResources, lease.resources);
        }
    }

    /**
     * The best queued request runs as soon as it fits. While it does not, a
     * smaller one may run ahead only when the best has neither aged nor a
     * better priority, when it takes nothing the best needs (interactive work
     * counted against the total it shares with the best, bulk work also
     * against the bulk budget), when the best cannot fit in current live OS
     * memory even when idle, or when it is a leaf escaping a lease that
     * may be waiting for it. A stream of small jobs, interactive or not,
     * therefore cannot keep a large one waiting once that one has aged and
     * live headroom permits it to run.
     */
    private findNextGrantable(memoryInfo: ISystemMemoryInfo | null, pendingBytes: number) {
        let waitingIndex = -1;
        for (let index = 0; index < this.queue.length; index += 1) {
            const candidate = this.queue[index];
            if (!candidate || this.isOwnerLimited(candidate.request)) {
                continue;
            }
            const waiting = waitingIndex >= 0 ? this.queue[waitingIndex] : undefined;
            if (!waiting || this.compareQueued(candidate, waiting) < 0) {
                waitingIndex = index;
            }
        }
        let shouldPollLiveMemory = false;
        let shortOfMemory = false;
        const waiting = waitingIndex >= 0 ? this.queue[waitingIndex] : undefined;
        if (waiting) {
            const waitingGrant = this.evaluateGrant(waiting.request, memoryInfo, pendingBytes);
            if (waitingGrant.grantable) {
                return {index: waitingIndex, shouldPollLiveMemory: false, shortOfMemory: false};
            }
            shouldPollLiveMemory ||= waitingGrant.blockedByLiveMemory;
            shortOfMemory ||= waitingGrant.shortOfMemory;
        }
        let bestIndex = -1;
        for (let index = 0; index < this.queue.length; index += 1) {
            const candidate = this.queue[index];
            if (!candidate || index === waitingIndex) {
                continue;
            }
            const candidateGrant = this.evaluateGrant(candidate.request, memoryInfo, pendingBytes);
            if (!candidateGrant.grantable) {
                shouldPollLiveMemory ||= candidateGrant.blockedByLiveMemory;
                shortOfMemory ||= candidateGrant.shortOfMemory;
                continue;
            }
            if (waiting !== undefined) {
                const runAhead = this.evaluateRunAhead(candidate, waiting, memoryInfo, pendingBytes);
                if (!runAhead.allowed) {
                    shouldPollLiveMemory ||= runAhead.dependsOnLiveMemory;
                    shortOfMemory ||= runAhead.blockedByLiveMemory;
                    continue;
                }
            }
            const best = bestIndex >= 0 ? this.queue[bestIndex] : undefined;
            if (!best || this.compareQueued(candidate, best) < 0) {
                bestIndex = index;
            }
        }
        return {
            index: bestIndex,
            shouldPollLiveMemory,
            shortOfMemory,
        };
    }

    private evaluateRunAhead(
        candidate: IQueuedJob,
        waiting: IQueuedJob,
        memoryInfo: ISystemMemoryInfo | null,
        pendingBytes: number,
    ) {
        const waitingIsProtected = this.getAgeSteps(waiting) >= 1
            || this.getEffectivePriorityRank(waiting) < this.getEffectivePriorityRank(candidate);
        if (!waitingIsProtected) {
            return {allowed: true, blockedByLiveMemory: false, dependsOnLiveMemory: false};
        }
        if (this.canEscapeAsLeaf(candidate.request, memoryInfo, pendingBytes)) {
            return {allowed: true, blockedByLiveMemory: false, dependsOnLiveMemory: false};
        }
        const waitingDependsOnLiveHeadroom = memoryInfo !== null && waiting.request.resources.estimatedResidentBytes > 0;
        const waitingIdleLiveHeadroom = waitingDependsOnLiveHeadroom
            ? this.getIdleLiveMemoryHeadroomBytes(memoryInfo)
            : Number.POSITIVE_INFINITY;
        // If `waiting` cannot fit in current live OS headroom even once the
        // broker drains to idle, holding back a fitting job cannot help
        // `waiting` run and would stall all fitting work behind external memory
        // pressure.
        if (waitingDependsOnLiveHeadroom && waiting.request.resources.estimatedResidentBytes > waitingIdleLiveHeadroom) {
            return {allowed: true, blockedByLiveMemory: false, dependsOnLiveMemory: false};
        }
        if (this.takesStaticResourcesWaitingNeeds(candidate.request, waiting.request)) {
            // Even when static fairness denies run-ahead today, a future drop
            // in live OS headroom below `waiting`'s requirement would make this
            // grantable candidate eligible to run ahead, so keep polling armed.
            return {allowed: false, blockedByLiveMemory: false, dependsOnLiveMemory: waitingDependsOnLiveHeadroom};
        }
        // Only reserve live OS memory (and idle-drain opportunity) for `waiting`
        // when `waiting` is not already blocked by an independent non-memory
        // resource (such as CPU or process slots) that `candidate` does not touch.
        if (waitingDependsOnLiveHeadroom && this.fitsNonMemoryStatic(waiting.request)) {
            const waitingLiveHeadroom = this.getLiveMemoryHeadroomBytes(waiting.request.admissionClass, memoryInfo);
            const candidatePreventsIdleDrain =
                waiting.request.resources.estimatedResidentBytes > waitingLiveHeadroom
                && !this.isParkedMemoryLease(candidate.request.resources);
            const candidateExceedsLiveHeadroom =
                candidate.request.resources.estimatedResidentBytes > 0
                && pendingBytes
                    + candidate.request.resources.estimatedResidentBytes
                    + waiting.request.resources.estimatedResidentBytes
                    > waitingLiveHeadroom;
            if (candidatePreventsIdleDrain || candidateExceedsLiveHeadroom) {
                return {allowed: false, blockedByLiveMemory: true, dependsOnLiveMemory: true};
            }
        }
        return {allowed: true, blockedByLiveMemory: false, dependsOnLiveMemory: false};
    }

    private fitsNonMemoryStatic(request: IJobBrokerRequest) {
        if (
            this.usedResources.cpuTokens + request.resources.cpuTokens
                > this.capacity.cpuTokens + this.interactiveReserve.cpuTokens
            || this.usedResources.nativeProcesses + request.resources.nativeProcesses
                > this.capacity.nativeProcesses + this.interactiveReserve.nativeProcesses
            || this.usedResources.ioWeight + request.resources.ioWeight
                > this.capacity.ioWeight + this.interactiveReserve.ioWeight
        ) {
            return false;
        }
        if (request.admissionClass === 'interactive') {
            return true;
        }
        return this.usedBulkResources.cpuTokens + request.resources.cpuTokens <= this.capacity.cpuTokens
            && this.usedBulkResources.nativeProcesses + request.resources.nativeProcesses
                <= this.capacity.nativeProcesses
            && this.usedBulkResources.ioWeight + request.resources.ioWeight <= this.capacity.ioWeight;
    }

    // Whether running the candidate uses any static dimension the waiting
    // request would then no longer find room in. Interactive work is charged
    // to the total only, bulk work to the total and the bulk budget.
    private takesStaticResourcesWaitingNeeds(candidate: IJobBrokerRequest, waiting: IJobBrokerRequest) {
        const checkBulk = waiting.admissionClass !== 'interactive' && candidate.admissionClass !== 'interactive';
        return (
            (candidate.resources.cpuTokens > 0 && (
                this.usedResources.cpuTokens + candidate.resources.cpuTokens + waiting.resources.cpuTokens
                    > this.capacity.cpuTokens + this.interactiveReserve.cpuTokens
                || (checkBulk && this.usedBulkResources.cpuTokens
                    + candidate.resources.cpuTokens + waiting.resources.cpuTokens > this.capacity.cpuTokens)
            ))
            || (candidate.resources.estimatedResidentBytes > 0 && (
                this.usedResources.estimatedResidentBytes
                    + candidate.resources.estimatedResidentBytes + waiting.resources.estimatedResidentBytes
                    > this.capacity.estimatedResidentBytes + this.interactiveReserve.estimatedResidentBytes
                || (checkBulk && this.usedBulkResources.estimatedResidentBytes
                    + candidate.resources.estimatedResidentBytes + waiting.resources.estimatedResidentBytes
                    > this.capacity.estimatedResidentBytes)
            ))
            || (candidate.resources.nativeProcesses > 0 && (
                this.usedResources.nativeProcesses
                    + candidate.resources.nativeProcesses + waiting.resources.nativeProcesses
                    > this.capacity.nativeProcesses + this.interactiveReserve.nativeProcesses
                || (checkBulk && this.usedBulkResources.nativeProcesses
                    + candidate.resources.nativeProcesses + waiting.resources.nativeProcesses
                    > this.capacity.nativeProcesses)
            ))
            || (candidate.resources.ioWeight > 0 && (
                this.usedResources.ioWeight + candidate.resources.ioWeight + waiting.resources.ioWeight
                    > this.capacity.ioWeight + this.interactiveReserve.ioWeight
                || (checkBulk && this.usedBulkResources.ioWeight
                    + candidate.resources.ioWeight + waiting.resources.ioWeight > this.capacity.ioWeight)
            ))
        );
    }

    private isOwnerLimited(request: IJobBrokerRequest) {
        return request.perOwnerLimit !== undefined
            && this.getOwnerActiveCount(request.ownerId, request.kind) >= request.perOwnerLimit;
    }

    private isShortOfStaticMemory(request: IJobBrokerRequest) {
        const bytes = request.resources.estimatedResidentBytes;
        if (bytes <= 0) {
            return false;
        }
        return this.usedResources.estimatedResidentBytes + bytes
            > this.capacity.estimatedResidentBytes + this.interactiveReserve.estimatedResidentBytes
            || (request.admissionClass !== 'interactive'
                && this.usedBulkResources.estimatedResidentBytes + bytes > this.capacity.estimatedResidentBytes);
    }

    private canEscapeAsLeafWithoutLiveMemory(request: IJobBrokerRequest) {
        const maxLeafMemoryOverrun = Math.min(
            this.capacity.estimatedResidentBytes,
            MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.estimatedResidentBytes,
        );
        if (
            request.admissionClass !== 'leaf'
            || request.resources.nativeProcesses > 1
            || this.usedResources.nativeProcesses + request.resources.nativeProcesses
                > this.capacity.nativeProcesses + this.interactiveReserve.nativeProcesses + 1
            || this.usedResources.estimatedResidentBytes + request.resources.estimatedResidentBytes
                > this.capacity.estimatedResidentBytes
                    + this.interactiveReserve.estimatedResidentBytes
                    + maxLeafMemoryOverrun
        ) {
            return false;
        }
        let runningNonLeaves = 0;
        for (const active of this.active.values()) {
            if (this.retained.has(active.token)) {
                continue;
            }
            if (active.admissionClass === 'leaf') {
                return false;
            }
            if (
                active.resources.cpuTokens === 0
                && active.resources.nativeProcesses === 0
                && active.resources.ioWeight === 0
            ) {
                continue;
            }
            runningNonLeaves += 1;
        }
        return runningNonLeaves > 0;
    }

    // A leaf may pass the capacity + interactive reserve only while a lease
    // that may be waiting for it runs and no other leaf runs, and only by one
    // process and one bounded single-job memory slice, never into live OOM
    // pressure or pending-allocation overcommit.
    private canEscapeAsLeaf(request: IJobBrokerRequest, memoryInfo: ISystemMemoryInfo | null, pendingBytes: number) {
        return this.canEscapeAsLeafWithoutLiveMemory(request)
            && this.fitsLeafLiveMemory(request, memoryInfo, pendingBytes);
    }

    private compareQueued(left: IQueuedJob, right: IQueuedJob) {
        const leftRank = this.getEffectivePriorityRank(left);
        const rightRank = this.getEffectivePriorityRank(right);
        if (leftRank !== rightRank) {
            return leftRank - rightRank;
        }
        const leftOwnerLoad = this.getOwnerActiveCount(left.request.ownerId, left.request.kind);
        const rightOwnerLoad = this.getOwnerActiveCount(right.request.ownerId, right.request.kind);
        return leftOwnerLoad - rightOwnerLoad || left.id - right.id;
    }

    private getAgeSteps(item: IQueuedJob) {
        return this.agingIntervalMs > 0
            ? Math.floor(Math.max(0, this.now() - item.enqueuedAt) / this.agingIntervalMs)
            : 0;
    }

    private getEffectivePriorityRank(item: IQueuedJob) {
        return Math.max(0, PRIORITY_RANK[item.request.priority] - this.getAgeSteps(item));
    }

    private evaluateGrant(request: IJobBrokerRequest, memoryInfo: ISystemMemoryInfo | null, pendingBytes: number) {
        if (this.isOwnerLimited(request)) {
            return {grantable: false, blockedByLiveMemory: false, shortOfMemory: false};
        }
        if (this.canEscapeAsLeafWithoutLiveMemory(request)) {
            if (this.fitsLeafLiveMemory(request, memoryInfo, pendingBytes)) {
                return {grantable: true, blockedByLiveMemory: false, shortOfMemory: false};
            }
            return {grantable: false, blockedByLiveMemory: true, shortOfMemory: true};
        }
        const shortOfStaticMemory = this.isShortOfStaticMemory(request);
        const fitsStatic =
            !shortOfStaticMemory
            && this.usedResources.cpuTokens + request.resources.cpuTokens
                <= this.capacity.cpuTokens + this.interactiveReserve.cpuTokens
            && this.usedResources.nativeProcesses + request.resources.nativeProcesses
                <= this.capacity.nativeProcesses + this.interactiveReserve.nativeProcesses
            && this.usedResources.ioWeight + request.resources.ioWeight
                <= this.capacity.ioWeight + this.interactiveReserve.ioWeight
            && (request.admissionClass === 'interactive'
                || (this.usedBulkResources.cpuTokens + request.resources.cpuTokens <= this.capacity.cpuTokens
                    && this.usedBulkResources.nativeProcesses + request.resources.nativeProcesses
                        <= this.capacity.nativeProcesses
                    && this.usedBulkResources.ioWeight + request.resources.ioWeight <= this.capacity.ioWeight));
        const fitsLive = this.fitsLiveMemory(request, memoryInfo, pendingBytes);
        if (fitsStatic && fitsLive) {
            return {grantable: true, blockedByLiveMemory: false, shortOfMemory: false};
        }
        return {
            grantable: false,
            blockedByLiveMemory: !fitsLive,
            shortOfMemory: shortOfStaticMemory || !fitsLive,
        };
    }

    private fitsWithin(resources: IJobResourceVector, capacity: IJobResourceVector) {
        return resources.cpuTokens <= capacity.cpuTokens
            && resources.estimatedResidentBytes <= capacity.estimatedResidentBytes
            && resources.nativeProcesses <= capacity.nativeProcesses
            && resources.ioWeight <= capacity.ioWeight;
    }

    private getOwnerActiveCount(ownerId: string, kind: string) {
        let count = 0;
        for (const active of this.active.values()) {
            if (active.ownerId === ownerId && active.kind === kind) {
                count += 1;
            }
        }
        return count;
    }

}

// The system, the renderer and the app's own heap keep 2 GiB until 15 % is
// more, at about 13.3 GiB of RAM; from there they keep 15 %, at most 4 GiB
// (reached at about 26.7 GiB). A 4 GiB host keeps 2 GiB and gives 2 GiB to
// jobs, an 8 GiB host keeps 2 GiB and gives 6 GiB. Hosts below 4 GiB keep half.
const SMALL_HOST_FREE_RESERVE_BYTES = 2 * GIB;
const MAX_FREE_RESERVE_BYTES = 4 * GIB;
// The memory one concurrent native process is budgeted, as for the largest
// single job.
const NATIVE_PROCESS_MEMORY_BUDGET_BYTES = MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.estimatedResidentBytes;

export function resolveMainJobBrokerCapacity(
    profile: IHostResourceProfileSnapshot,
): IJobResourceVector {
    const cpuCount = Math.max(1, profile.logicalCpus);
    const totalMemoryBytes = Math.max(0, profile.totalRamBytes);
    const freeReserveBytes = clamp(
        totalMemoryBytes * 0.15,
        Math.min(totalMemoryBytes / 2, SMALL_HOST_FREE_RESERVE_BYTES),
        MAX_FREE_RESERVE_BYTES,
    );
    const estimatedResidentBytes = Math.max(
        MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.estimatedResidentBytes,
        totalMemoryBytes - freeReserveBytes,
    );
    const cpuTokens = Math.max(
        MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.cpuTokens,
        Math.floor(cpuCount * 0.75),
    );
    // Native processes scale with both cores and the memory each is budgeted.
    // An unknown memory size leaves the CPU bound alone.
    const memoryProcessBound = totalMemoryBytes > 0
        ? Math.floor(estimatedResidentBytes / NATIVE_PROCESS_MEMORY_BUDGET_BYTES)
        : Number.POSITIVE_INFINITY;
    const nativeProcesses = Math.max(
        MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.nativeProcesses,
        Math.min(Math.floor(cpuCount / 2), memoryProcessBound),
    );
    const tierNativeProcesses = profile.tier === 'low'
        ? Math.min(nativeProcesses, 2)
        : Math.max(nativeProcesses, profile.tier === 'medium' ? 2 : 3);
    return {
        cpuTokens: profile.performanceMode === 'low'
            ? Math.min(cpuTokens, 2)
            : cpuTokens,
        estimatedResidentBytes,
        // DjVu export/print nests a conversion lease inside an output-slot
        // lease with an all-zero resource vector. The outer lease still owns
        // the workflow and counts toward its per-owner limit, but consumes no
        // capacity, so nested admission cannot deadlock below any process
        // capacity.
        nativeProcesses: tierNativeProcesses,
        // A weight of four is used by supported bulk save and combine jobs.
        // Each native command weighs one, so I/O admits at least as many
        // processes as the process budget does.
        ioWeight: profile.tier === 'low'
            ? MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.ioWeight
            : Math.max(MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.ioWeight, tierNativeProcesses),
    };
}

let mainJobBrokerConfigured = false;

export function configureMainJobBroker(profile: IHostResourceProfileSnapshot) {
    mainJobBroker.reconfigureCapacity(resolveMainJobBrokerCapacity(profile));
    mainJobBrokerConfigured = true;
}

/**
 * The main broker once the host profile has sized it. Worker threads and
 * utility processes never configure their copy: the work they run was
 * admitted by the lease the main process holds for it.
 */
export function getConfiguredMainJobBroker() {
    return mainJobBrokerConfigured ? mainJobBroker : null;
}

export const mainJobBroker = new JobBroker(MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES, {
    maxInteractiveJobResources: MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES,
    interactiveReserve: MAIN_JOB_BROKER_INTERACTIVE_RESERVE,
    readSystemMemoryInfo,
});
