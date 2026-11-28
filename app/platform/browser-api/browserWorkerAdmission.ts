import {BrowserWorkerClientLifecycle, BrowserWorkerResetError} from '@app/platform/browser-api/browserWorkerClientLifecycle';
import {
    detectBrowserEngine,
    getPerformanceProfile,
    isMobileBrowserUserAgent,
    readNavigatorBrowserMemoryEnvironment,
    type IBrowserMemoryEnvironment,
} from '@app/utils/performanceProfile';
import {HOST_TIER_LOW_CPU_MAX} from '@contracts/hostResourceProfile';

export type TBrowserHeavyWorkerCategory = 'ocr' | 'ocr-preprocess' | 'scan-cleanup' | 'search' | 'page-ops';
export type TBrowserHeavyWorkerPriority = 'interactive' | 'batch';

export type TBrowserWorkerCategoryLimit = number | (() => number | undefined);

export interface IBrowserWorkerAdmissionOptions {
    category: TBrowserHeavyWorkerCategory;
    priority?: TBrowserHeavyWorkerPriority;
    /** Optional per-category concurrency ceiling matching a pool's local worker cap so queued requests never hoard aggregate slots. */
    categoryLimit?: TBrowserWorkerCategoryLimit;
    signal?: AbortSignal | undefined;
    createAbortError?: () => Error;
}

export interface IBrowserWorkerAdmissionSnapshot {
    active: number;
    activeByCategory: Readonly<Record<TBrowserHeavyWorkerCategory, number>>;
    queuedInteractive: number;
    queuedBatch: number;
    limit: number;
}

const MIN_AGGREGATE_HEAVY_WORKERS = 2;
const MAX_AGGREGATE_HEAVY_WORKERS_WEBKIT = 6;
const MAX_AGGREGATE_HEAVY_WORKERS_DESKTOP = 8;

/**
 * Computes the aggregate concurrent heavy-worker ceiling shared across browser
 * OCR, Scan Cleanup, Search, and PageOps pools.
 *
 * - Constrained devices (mobile, `lowMemory`, `deviceMemory <= 4`, or `<= 2` cores)
 *   stay at 2 (1 batch + 1 reserved interactive slot) so background jobs never
 *   starve interactive search/page operations or blow past tab memory caps.
 * - Desktop WebKit caps at 6 to stay within WebKit's tighter WASM linear-memory
 *   and shared-memory ceiling.
 * - Desktop Firefox (`deviceMemory === undefined`) and Chromium (`deviceMemory > 4`)
 *   scale up to 8 concurrent heavy workers on high-core workstations.
 */
export function resolveBrowserHeavyWorkerLimit(environment?: IBrowserMemoryEnvironment & {lowMemory?: boolean}): number {
    const nav = environment ? undefined : readNavigatorBrowserMemoryEnvironment();
    const userAgent = environment?.userAgent ?? nav?.userAgent;
    const maxTouchPoints = environment?.maxTouchPoints ?? nav?.maxTouchPoints ?? 0;
    const mobile =
        environment?.mobile ??
        (environment?.userAgent !== undefined ? isMobileBrowserUserAgent(userAgent, maxTouchPoints) : (nav?.mobile ?? false));
    const deviceMemory = environment && 'deviceMemory' in environment ? environment.deviceMemory : nav?.deviceMemory;
    const cores = environment && 'hardwareConcurrency' in environment ? environment.hardwareConcurrency : nav?.hardwareConcurrency;
    const lowMemory = environment?.lowMemory ?? (environment ? false : getPerformanceProfile().lowMemory);
    const hasLowDeviceMemory = typeof deviceMemory === 'number' && Number.isFinite(deviceMemory) && deviceMemory > 0 && deviceMemory <= 4;
    const normalizedCores = typeof cores === 'number' && Number.isFinite(cores) && cores > 0 ? Math.floor(cores) : 4;

    if (mobile || lowMemory || hasLowDeviceMemory || normalizedCores <= HOST_TIER_LOW_CPU_MAX) {
        return MIN_AGGREGATE_HEAVY_WORKERS;
    }
    const engine = detectBrowserEngine(userAgent);
    const ceiling =
        engine === 'webkit'
            ? MAX_AGGREGATE_HEAVY_WORKERS_WEBKIT
            : engine === 'firefox' || (typeof deviceMemory === 'number' && deviceMemory > 4)
              ? MAX_AGGREGATE_HEAVY_WORKERS_DESKTOP
              : MAX_AGGREGATE_HEAVY_WORKERS_WEBKIT;
    return Math.max(MIN_AGGREGATE_HEAVY_WORKERS, Math.min(ceiling, normalizedCores - 1));
}

function defaultAbortError(signal?: AbortSignal) {
    if (signal?.reason instanceof Error) {
        return signal.reason;
    }
    return new DOMException('Browser worker request was canceled', 'AbortError');
}

interface IQueuedWaiter {
    category: TBrowserHeavyWorkerCategory;
    priority: TBrowserHeavyWorkerPriority;
    categoryLimit: TBrowserWorkerCategoryLimit | undefined;
    signal: AbortSignal | undefined;
    createAbortError: (() => Error) | undefined;
    admit: (release: () => void) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
}

/**
 * Shared lightweight aggregate admission owner for heavy browser Web Workers
 * (OCR, Scan Cleanup, Search, PageOps). Preserves synchronous zero-overhead
 * fast-path entry when capacity is free, prioritizes interactive operations
 * over batch work, reserves one slot for interactive requests when `limit > 1`,
 * and supports immediate queue eviction on `AbortSignal`.
 */
export class BrowserHeavyWorkerAdmission {
    private activeCount = 0;
    private readonly activeByCategory: Record<TBrowserHeavyWorkerCategory, number> = {
        ocr: 0,
        'ocr-preprocess': 0,
        'scan-cleanup': 0,
        search: 0,
        'page-ops': 0,
    };
    private readonly interactiveQueue: IQueuedWaiter[] = [];
    private readonly batchQueue: IQueuedWaiter[] = [];
    private readonly lifecycle = new BrowserWorkerClientLifecycle();
    private resetGeneration = 0;

    public constructor(private readonly resolveLimit: () => number = () => resolveBrowserHeavyWorkerLimit()) {}

    private syncLifecycle() {
        if (this.activeCount > 0 || this.interactiveQueue.length > 0 || this.batchQueue.length > 0) {
            this.lifecycle.register(() => this.resetQueued());
        } else {
            this.lifecycle.clear();
        }
    }

    private resetQueued() {
        this.resetGeneration += 1;
        const queued = [...this.interactiveQueue.splice(0), ...this.batchQueue.splice(0)];
        this.syncLifecycle();
        const error = new BrowserWorkerResetError();
        for (const waiter of queued) {
            waiter.cleanup();
            waiter.reject(error);
        }
    }

    private currentLimit() {
        return Math.max(1, Math.floor(this.resolveLimit()));
    }

    private resolveCategoryLimit(categoryLimit: TBrowserWorkerCategoryLimit | undefined): number | undefined {
        const value = typeof categoryLimit === 'function' ? categoryLimit() : categoryLimit;
        if (value === undefined || !Number.isFinite(value)) {
            return undefined;
        }
        return Math.max(0, Math.floor(value));
    }

    private hasAdmittableInteractiveWaiter(limit: number): boolean {
        return this.interactiveQueue.some(
            (waiter) => !waiter.signal?.aborted && this.canAdmit(waiter.category, 'interactive', limit, waiter.categoryLimit),
        );
    }

    private canAdmit(
        category: TBrowserHeavyWorkerCategory,
        priority: TBrowserHeavyWorkerPriority,
        limit: number,
        categoryLimit?: TBrowserWorkerCategoryLimit,
    ): boolean {
        const resolvedCategoryLimit = this.resolveCategoryLimit(categoryLimit);
        if (resolvedCategoryLimit !== undefined && this.activeByCategory[category] >= resolvedCategoryLimit) {
            return false;
        }
        if (priority === 'interactive') {
            return this.activeCount < limit;
        }
        const interactiveReserve = limit > 1 ? 1 : 0;
        return !this.hasAdmittableInteractiveWaiter(limit) && this.activeCount < Math.max(1, limit - interactiveReserve);
    }

    private claimSlot(category: TBrowserHeavyWorkerCategory): () => void {
        this.activeCount += 1;
        this.activeByCategory[category] += 1;
        this.syncLifecycle();
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.activeCount = Math.max(0, this.activeCount - 1);
            this.activeByCategory[category] = Math.max(0, this.activeByCategory[category] - 1);
            this.drainQueues();
        };
    }

    private drainQueue(queue: IQueuedWaiter[], priority: TBrowserHeavyWorkerPriority, limit: number) {
        let index = 0;
        while (index < queue.length) {
            const waiter = queue[index]!;
            if (!this.canAdmit(waiter.category, priority, limit, waiter.categoryLimit)) {
                index += 1;
                continue;
            }
            queue.splice(index, 1);
            waiter.cleanup();
            if (waiter.signal?.aborted) {
                waiter.reject(waiter.createAbortError ? waiter.createAbortError() : defaultAbortError(waiter.signal));
                continue;
            }
            waiter.admit(this.claimSlot(waiter.category));
        }
    }

    private drainQueues() {
        const limit = this.currentLimit();
        this.drainQueue(this.interactiveQueue, 'interactive', limit);
        this.drainQueue(this.batchQueue, 'batch', limit);
        this.syncLifecycle();
    }

    /** Re-evaluates queued waiters when an external pool budget (such as threaded WASM) frees room. */
    public wake() {
        this.drainQueues();
    }

    /** Synchronously acquires a slot when immediately available, or returns `null` when queued admission is needed. */
    public tryAcquire(
        category: TBrowserHeavyWorkerCategory,
        priority: TBrowserHeavyWorkerPriority = 'interactive',
        categoryLimit?: TBrowserWorkerCategoryLimit,
    ): (() => void) | null {
        const limit = this.currentLimit();
        if (!this.canAdmit(category, priority, limit, categoryLimit)) {
            return null;
        }
        return this.claimSlot(category);
    }

    public acquire(options: IBrowserWorkerAdmissionOptions): Promise<() => void> {
        const {category, priority = 'interactive', categoryLimit, signal, createAbortError} = options;
        if (signal?.aborted) {
            return Promise.reject(createAbortError ? createAbortError() : defaultAbortError(signal));
        }
        const immediate = this.tryAcquire(category, priority, categoryLimit);
        if (immediate !== null) {
            return Promise.resolve(immediate);
        }
        const queue = priority === 'interactive' ? this.interactiveQueue : this.batchQueue;
        return new Promise<() => void>((resolve, reject) => {
            const waiter: IQueuedWaiter = {
                category,
                priority,
                categoryLimit,
                signal,
                createAbortError,
                admit: resolve,
                reject,
                cleanup: () => {
                    signal?.removeEventListener('abort', onAbort);
                },
            };
            const onAbort = () => {
                const index = queue.indexOf(waiter);
                if (index >= 0) {
                    queue.splice(index, 1);
                }
                waiter.cleanup();
                this.syncLifecycle();
                reject(createAbortError ? createAbortError() : defaultAbortError(signal));
                this.drainQueues();
            };
            queue.push(waiter);
            this.syncLifecycle();
            signal?.addEventListener('abort', onAbort, {once: true});
        });
    }

    /**
     * Runs `task` with an explicit `release` callback (for callers that defer slot release
     * across warm-cancel worker draining) while guarding queued grants against page resets
     * (`pagehide`/persisted `pageshow`) and aborts in the microtask dispatch window.
     */
    public runDeferred<TResult>(
        options: IBrowserWorkerAdmissionOptions,
        task: (release: () => void) => Promise<TResult>,
    ): Promise<TResult> {
        const {category, priority = 'interactive', categoryLimit, signal, createAbortError} = options;
        if (signal?.aborted) {
            return Promise.reject(createAbortError ? createAbortError() : defaultAbortError(signal));
        }
        const immediateRelease = this.tryAcquire(category, priority, categoryLimit);
        if (immediateRelease !== null) {
            try {
                return task(immediateRelease);
            } catch (error) {
                immediateRelease();
                return Promise.reject(error);
            }
        }
        const enqueueGeneration = this.resetGeneration;
        return this.acquire(options).then((release) => {
            if (this.resetGeneration !== enqueueGeneration) {
                release();
                throw new BrowserWorkerResetError();
            }
            if (signal?.aborted) {
                release();
                throw createAbortError ? createAbortError() : defaultAbortError(signal);
            }
            try {
                return task(release);
            } catch (error) {
                release();
                throw error;
            }
        });
    }

    public run<TResult>(options: IBrowserWorkerAdmissionOptions, task: () => Promise<TResult>): Promise<TResult> {
        return this.runDeferred(options, (release) => task().finally(release));
    }

    public snapshot(): IBrowserWorkerAdmissionSnapshot {
        return {
            active: this.activeCount,
            activeByCategory: {...this.activeByCategory},
            queuedInteractive: this.interactiveQueue.length,
            queuedBatch: this.batchQueue.length,
            limit: this.currentLimit(),
        };
    }
}

export const browserHeavyWorkerAdmission = new BrowserHeavyWorkerAdmission();

export function runWithBrowserWorkerAdmission<TResult>(
    options: IBrowserWorkerAdmissionOptions,
    task: () => Promise<TResult>,
): Promise<TResult> {
    return browserHeavyWorkerAdmission.run(options, task);
}
