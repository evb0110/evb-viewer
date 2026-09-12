import { clamp } from 'es-toolkit/math';
import type { IHostResourceProfileSnapshot } from '@contracts/hostResourceProfile';
import { createLogger } from '@electron/utils/createLogger';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const DEFAULT_AGING_INTERVAL_MS = 5_000;
/**
 * A lease that outlives this is treated as abandoned rather than merely slow: a
 * holder that has not released by now has almost certainly lost its release path,
 * and its resources would otherwise be unreachable for the life of the process.
 */
export const JOB_LEASE_MAX_HOLD_MS = 30 * 60 * 1_000;
const DEFAULT_JOB_BROKER_MAX_QUEUED_JOBS = 256;
const DEFAULT_JOB_BROKER_MAX_QUEUED_JOBS_PER_OWNER = 64;
const logger = createLogger('job-broker');

export const MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES: Readonly<IJobResourceVector> = {
    cpuTokens: 2,
    estimatedResidentBytes: 256 * MIB,
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
export type TJobBrokerAdmissionClass = 'bulk' | 'interactive';

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
    grantedAt: number;
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

function addResources(left: IJobResourceVector, right: IJobResourceVector): IJobResourceVector {
    return {
        cpuTokens: left.cpuTokens + right.cpuTokens,
        estimatedResidentBytes: left.estimatedResidentBytes + right.estimatedResidentBytes,
        nativeProcesses: left.nativeProcesses + right.nativeProcesses,
        ioWeight: left.ioWeight + right.ioWeight,
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
    private readonly queue: IQueuedJob[] = [];
    private counter = 0;
    private readonly agingIntervalMs: number;
    private readonly now: () => number;
    private readonly maxQueuedJobs: number;
    private readonly maxQueuedJobsPerOwner: number;
    private readonly maxInteractiveJobResources: IJobResourceVector;
    private readonly interactiveReserve: IJobResourceVector;

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
        validateResourceVector(capacity);
        validateResourceVector(this.maxInteractiveJobResources);
        validateResourceVector(this.interactiveReserve);
        if (!Number.isSafeInteger(this.maxQueuedJobs) || this.maxQueuedJobs < 1) {
            throw new TypeError('Job broker queue limit must be a positive safe integer');
        }
        if (!Number.isSafeInteger(this.maxQueuedJobsPerOwner) || this.maxQueuedJobsPerOwner < 1) {
            throw new TypeError('Job broker per-owner queue limit must be a positive safe integer');
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
        const ownerQueuedJobs = this.queue.reduce(
            (count, queued) => count + Number(queued.request.ownerId === request.ownerId),
            0,
        );
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

    release(token: string) {
        if (!this.active.delete(token)) {
            return false;
        }
        this.dispatch();
        return true;
    }

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
        // Cancelling an owner has to drop its granted leases too. The holder is
        // being torn down and will never call `release()`, so leaving the leases
        // active would hold the resources until the process exits.
        let releasedLeaseCount = 0;
        for (const [
            token,
            active,
        ] of this.active) {
            if (active.ownerId !== ownerId) {
                continue;
            }
            this.active.delete(token);
            releasedLeaseCount += 1;
        }
        if (releasedLeaseCount > 0) {
            this.dispatch();
        }
    }

    getSnapshot() {
        return {
            capacity: {...this.capacity},
            maxInteractiveJobResources: {...this.maxInteractiveJobResources},
            interactiveReserve: {...this.interactiveReserve},
            active: this.active.size,
            queued: this.queue.length,
            used: this.getUsedResources(),
            usedBulk: this.getUsedBulkResources(),
        };
    }

    private dispatch() {
        this.sweepExpiredLeases();
        while (this.queue.length > 0) {
            const grantableIndex = this.findNextGrantableIndex();
            if (grantableIndex < 0) {
                return;
            }
            const [next] = this.queue.splice(grantableIndex, 1);
            if (!next) {
                return;
            }
            next.removeAbortListener();
            const token = `job-${next.id}`;
            this.active.set(token, {
                ...next.request,
                token,
                grantedAt: this.now(),
            });
            let released = false;
            next.resolve({
                token,
                resources: {...next.request.resources},
                release: () => {
                    if (released) {
                        return false;
                    }
                    released = true;
                    return this.release(token);
                },
            });
        }
    }

    private sweepExpiredLeases() {
        const now = this.now();
        for (const [
            token,
            active,
        ] of this.active) {
            const heldMs = now - active.grantedAt;
            if (heldMs < JOB_LEASE_MAX_HOLD_MS) {
                continue;
            }
            this.active.delete(token);
            logger.warn(
                `Reclaimed expired job broker lease token=${token} owner=${active.ownerId} `
                + `kind=${active.kind} heldMs=${heldMs}`,
            );
        }
    }

    private findNextGrantableIndex() {
        let bestIndex = -1;
        for (let index = 0; index < this.queue.length; index += 1) {
            const candidate = this.queue[index];
            if (!candidate || !this.canGrant(candidate.request)) {
                continue;
            }
            const best = bestIndex >= 0 ? this.queue[bestIndex] : undefined;
            if (!best || this.compareQueued(candidate, best) < 0) {
                bestIndex = index;
            }
        }
        return bestIndex;
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

    private getEffectivePriorityRank(item: IQueuedJob) {
        const ageSteps = this.agingIntervalMs > 0
            ? Math.floor(Math.max(0, this.now() - item.enqueuedAt) / this.agingIntervalMs)
            : 0;
        return Math.max(0, PRIORITY_RANK[item.request.priority] - ageSteps);
    }

    private canGrant(request: IJobBrokerRequest) {
        if (
            request.perOwnerLimit !== undefined
            && this.getOwnerActiveCount(request.ownerId, request.kind) >= request.perOwnerLimit
        ) {
            return false;
        }
        const proposedTotal = addResources(this.getUsedResources(), request.resources);
        if (!this.fitsWithin(proposedTotal, addResources(this.capacity, this.interactiveReserve))) {
            return false;
        }
        if (request.admissionClass === 'interactive') {
            return true;
        }
        const proposedBulk = addResources(this.getUsedBulkResources(), request.resources);
        return this.fitsWithin(proposedBulk, this.capacity);
    }

    private fitsWithin(resources: IJobResourceVector, capacity: IJobResourceVector) {
        return resources.cpuTokens <= capacity.cpuTokens
            && resources.estimatedResidentBytes <= capacity.estimatedResidentBytes
            && resources.nativeProcesses <= capacity.nativeProcesses
            && resources.ioWeight <= capacity.ioWeight;
    }

    private getOwnerActiveCount(ownerId: string, kind: string) {
        return Array.from(this.active.values())
            .filter(active => active.ownerId === ownerId && active.kind === kind)
            .length;
    }

    private getUsedResources() {
        return Array.from(this.active.values()).reduce(
            (total, active) => addResources(total, active.resources),
            {...ZERO_RESOURCES},
        );
    }

    private getUsedBulkResources() {
        return Array.from(this.active.values()).reduce(
            (total, active) => active.admissionClass === 'interactive'
                ? total
                : addResources(total, active.resources),
            {...ZERO_RESOURCES},
        );
    }
}

export function resolveMainJobBrokerCapacity(
    profile: IHostResourceProfileSnapshot,
): IJobResourceVector {
    const cpuCount = Math.max(1, profile.logicalCpus);
    const totalMemoryBytes = Math.max(0, profile.totalRamBytes);
    const freeReserveBytes = clamp(totalMemoryBytes * 0.15, GIB, 4 * GIB);
    const cpuTokens = clamp(
        Math.floor(cpuCount * 0.75),
        MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.cpuTokens,
        16,
    );
    const nativeProcesses = clamp(
        Math.floor(cpuCount / 2),
        MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.nativeProcesses,
        8,
    );
    return {
        cpuTokens: profile.tier === 'low'
            ? Math.min(cpuTokens, 2)
            : cpuTokens,
        estimatedResidentBytes: Math.max(
            MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.estimatedResidentBytes,
            totalMemoryBytes - freeReserveBytes,
        ),
        // DjVu export/print nests a conversion lease inside its output-slot
        // lease (pdfExport.runDjvuConversionJobWithSlot), so any capacity
        // below 2 deadlocks that workflow.
        nativeProcesses: profile.tier === 'low'
            ? 2
            : Math.max(nativeProcesses, profile.tier === 'medium' ? 2 : 3),
        // A weight of four is used by supported bulk save and combine jobs.
        // Keep that work admissible on low-core hosts while
        // still allowing additional I/O concurrency on larger machines.
        ioWeight: profile.tier === 'low'
            ? 4
            : clamp(Math.floor(cpuCount / 2), MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.ioWeight, 8),
    };
}

export function configureMainJobBroker(profile: IHostResourceProfileSnapshot) {
    mainJobBroker.reconfigureCapacity(resolveMainJobBrokerCapacity(profile));
}

export const mainJobBroker = new JobBroker(MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES, {
    maxInteractiveJobResources: MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES,
    interactiveReserve: MAIN_JOB_BROKER_INTERACTIVE_RESERVE,
});
