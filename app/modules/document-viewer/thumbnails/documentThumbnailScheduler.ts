import type {
    IDocumentPageRenderRequest,
    IDocumentRenderLease,
    TDocumentRenderPriority,
} from '@app/modules/document-viewer/source/documentPageSource';

export type TDocumentThumbnailQuality = 'transient' | 'settled';

export interface IDocumentThumbnailDemand {
    distance: number;
    pageNumber: number;
    priority: TDocumentRenderPriority;
    quality: TDocumentThumbnailQuality;
    rank: number;
    /** The page's render key; a changed key re-renders a committed page. */
    revision: string;
    widthPx: number;
}

export interface IDocumentThumbnailCommittedState {
    heightPx: number;
    pageNumber: number;
    /** Width the accepted demand asked for; the leased raster may be smaller. */
    requestWidthPx: number;
    /** The page render key of the accepted demand. */
    revision: string;
    surface: IDocumentRenderLease['surface'];
    widthPx: number;
}

interface IDocumentThumbnailSchedulerOptions {
    maxConcurrency: number;
    onStateChange: (pageNumber: number, state: IDocumentThumbnailCommittedState | null) => void;
    prepareSurface: (lease: IDocumentRenderLease, signal: AbortSignal) => Promise<void>;
    render: (request: IDocumentPageRenderRequest) => Promise<IDocumentRenderLease>;
    renderTimeoutMs?: number;
    /** Reports a render or surface-preparation failure. Cancellations never reach it. */
    onError?: ((error: unknown, demand: IDocumentThumbnailDemand) => void) | undefined;
}

interface IReleaseOnce {release: () => void;}

interface ICommittedEntry extends IDocumentThumbnailCommittedState {
    lease: IDocumentRenderLease;
    releaseOnce: IReleaseOnce;
    unsubscribe: (() => void) | null;
}

interface IActiveEntry {
    controller: AbortController;
    generation: number;
    key: string;
}

const DEFAULT_DOCUMENT_THUMBNAIL_RENDER_TIMEOUT_MS = 30_000;

function createReleaseOnce(lease: IDocumentRenderLease): IReleaseOnce {
    let released = false;
    return {release() {
        if (released) {
            return;
        }
        released = true;
        lease.release();
    }};
}

function normalizeDemand(demand: IDocumentThumbnailDemand): IDocumentThumbnailDemand {
    return {
        ...demand,
        distance: Math.max(0, Math.trunc(demand.distance)),
        pageNumber: Math.max(1, Math.trunc(demand.pageNumber)),
        rank: Math.max(0, Math.trunc(demand.rank)),
        widthPx: Math.max(1, Math.round(demand.widthPx)),
    };
}

function demandKey(demand: IDocumentThumbnailDemand) {
    return `${String(demand.pageNumber)}:${String(demand.widthPx)}:${demand.revision}`;
}

function isCommittedDemandSatisfied(entry: ICommittedEntry, demand: IDocumentThumbnailDemand) {
    if (entry.revision !== demand.revision) {
        return false;
    }
    return demand.quality === 'transient'
        ? entry.requestWidthPx >= demand.widthPx
        : entry.requestWidthPx === demand.widthPx;
}

function isAbortError(error: unknown) {
    return typeof DOMException !== 'undefined'
        && error instanceof DOMException
        && error.name === 'AbortError';
}

export function createDocumentThumbnailScheduler(options: IDocumentThumbnailSchedulerOptions) {
    const maxConcurrency = Math.max(1, Math.trunc(options.maxConcurrency));
    const renderTimeoutMs = Math.max(
        0,
        Math.trunc(options.renderTimeoutMs ?? DEFAULT_DOCUMENT_THUMBNAIL_RENDER_TIMEOUT_MS),
    );
    const active = new Map<number, IActiveEntry>();
    const committed = new Map<number, ICommittedEntry>();
    const desired = new Map<number, IDocumentThumbnailDemand>();
    const queued = new Map<number, IDocumentThumbnailDemand>();
    const idleWaiters = new Set<() => void>();
    let generation = 0;
    let activeCount = 0;
    let disposed = false;

    function notifyIdle() {
        if (activeCount !== 0 || queued.size !== 0) {
            return;
        }
        for (const resolve of idleWaiters) resolve();
        idleWaiters.clear();
    }

    function releaseCommitted(pageNumber: number, expected?: ICommittedEntry) {
        const entry = committed.get(pageNumber);
        if (!entry || (expected && entry !== expected)) {
            return false;
        }
        committed.delete(pageNumber);
        entry.unsubscribe?.();
        entry.unsubscribe = null;
        entry.releaseOnce.release();
        options.onStateChange(pageNumber, null);
        return true;
    }

    function enqueueIfNeeded(demand: IDocumentThumbnailDemand) {
        const existing = committed.get(demand.pageNumber);
        if (existing) {
            existing.lease.promotePriority?.(demand.priority);
            if (isCommittedDemandSatisfied(existing, demand)) {
                queued.delete(demand.pageNumber);
                return;
            }
        }
        queued.set(demand.pageNumber, demand);
        const inFlight = active.get(demand.pageNumber);
        if (inFlight && inFlight.key !== demandKey(demand)) inFlight.controller.abort();
    }

    function nextQueuedDemand() {
        let next: IDocumentThumbnailDemand | null = null;
        for (const demand of queued.values()) {
            if (
                !next
                || demand.rank < next.rank
                || (demand.rank === next.rank && demand.distance < next.distance)
                || (
                    demand.rank === next.rank
                    && demand.distance === next.distance
                    && demand.pageNumber < next.pageNumber
                )
            ) {
                next = demand;
            }
        }
        return next;
    }

    function handleInvalidation(entry: ICommittedEntry) {
        if (!releaseCommitted(entry.pageNumber, entry)) {
            return;
        }
        const demand = desired.get(entry.pageNumber);
        if (demand) {
            queued.set(entry.pageNumber, demand);
            pumpQueue();
        }
    }

    async function startRender(demand: IDocumentThumbnailDemand) {
        const pageNumber = demand.pageNumber;
        const controller = new AbortController();
        const renderGeneration = generation;
        const key = demandKey(demand);
        const activeEntry = {
            controller,
            generation: renderGeneration,
            key,
        };
        active.set(pageNumber, activeEntry);
        activeCount += 1;
        let pendingLease: {
            lease: IDocumentRenderLease;
            releaseOnce: IReleaseOnce;
        } | null = null;
        let renderTimedOut = false;
        let renderTimer: ReturnType<typeof setTimeout> | null = null;

        try {
            const renderPromise = options.render({
                pageNumber,
                widthPx: demand.widthPx,
                priority: demand.priority,
                signal: controller.signal,
            });
            void renderPromise.then((lease) => {
                if (renderTimedOut) {
                    lease.release();
                }
            }, () => undefined);
            const timeoutPromise = new Promise<never>((_resolve, reject) => {
                renderTimer = setTimeout(() => {
                    renderTimedOut = true;
                    controller.abort();
                    reject(new Error(`Thumbnail render timed out after ${String(renderTimeoutMs)}ms`));
                }, renderTimeoutMs);
            });
            const lease = await Promise.race([
                renderPromise,
                timeoutPromise,
            ]);
            pendingLease = {
                lease,
                releaseOnce: createReleaseOnce(lease),
            };
            controller.signal.throwIfAborted();
            await options.prepareSurface(lease, controller.signal);
            controller.signal.throwIfAborted();
            const latestDemand = desired.get(pageNumber);
            if (
                disposed
                || generation !== renderGeneration
                || !latestDemand
                || demandKey(latestDemand) !== key
            ) {
                return;
            }

            lease.promotePriority?.(latestDemand.priority);
            const entry: ICommittedEntry = {
                pageNumber,
                widthPx: lease.widthPx,
                heightPx: lease.heightPx,
                surface: lease.surface,
                lease,
                requestWidthPx: demand.widthPx,
                revision: demand.revision,
                releaseOnce: pendingLease.releaseOnce,
                unsubscribe: null,
            };
            pendingLease = null;
            entry.unsubscribe = lease.onInvalidated?.(() => handleInvalidation(entry)) ?? null;
            const previous = committed.get(pageNumber);
            committed.set(pageNumber, entry);
            options.onStateChange(pageNumber, {
                pageNumber,
                widthPx: entry.widthPx,
                heightPx: entry.heightPx,
                requestWidthPx: entry.requestWidthPx,
                revision: entry.revision,
                surface: entry.surface,
            });
            if (previous && previous !== entry) {
                previous.unsubscribe?.();
                previous.unsubscribe = null;
                previous.releaseOnce.release();
            }
        } catch (error) {
            if (!controller.signal.aborted && isAbortError(error)) {
                // The source refused the page, as a closing document does;
                // asking again at once would spin, so the next reconcile asks.
                if (desired.get(pageNumber) === demand) desired.delete(pageNumber);
            } else if (!controller.signal.aborted) options.onError?.(error, demand);
        } finally {
            if (renderTimer !== null) {
                clearTimeout(renderTimer);
                renderTimer = null;
            }
            pendingLease?.releaseOnce.release();
            if (active.get(pageNumber) === activeEntry) active.delete(pageNumber);
            activeCount -= 1;
            const latestDemand = desired.get(pageNumber);
            if (latestDemand) enqueueIfNeeded(latestDemand);
            pumpQueue();
            notifyIdle();
        }
    }

    function pumpQueue() {
        if (disposed) {
            return;
        }
        while (activeCount < maxConcurrency && queued.size > 0) {
            const demand = nextQueuedDemand();
            if (!demand) break;
            queued.delete(demand.pageNumber);
            if (active.has(demand.pageNumber)) continue;
            const latest = desired.get(demand.pageNumber);
            if (!latest || demandKey(latest) !== demandKey(demand)) continue;
            const existing = committed.get(demand.pageNumber);
            if (existing && isCommittedDemandSatisfied(existing, latest)) continue;
            void startRender(latest);
        }
        notifyIdle();
    }

    function reconcile(nextDemands: readonly IDocumentThumbnailDemand[]) {
        if (disposed) {
            return;
        }
        const normalized = new Map(nextDemands.map((demand) => {
            const value = normalizeDemand(demand);
            return [
                value.pageNumber,
                value,
            ] as const;
        }));
        desired.clear();
        normalized.forEach((demand, pageNumber) => desired.set(pageNumber, demand));

        for (const pageNumber of [...queued.keys()]) {
            if (!desired.has(pageNumber)) queued.delete(pageNumber);
        }
        for (const [
            pageNumber,
            entry,
        ] of [...active.entries()]) {
            if (!desired.has(pageNumber)) entry.controller.abort();
        }
        for (const pageNumber of [...committed.keys()]) {
            if (!desired.has(pageNumber)) releaseCommitted(pageNumber);
        }
        for (const demand of desired.values()) enqueueIfNeeded(demand);
        pumpQueue();
    }

    function reset() {
        generation += 1;
        desired.clear();
        queued.clear();
        active.forEach(entry => entry.controller.abort());
        for (const pageNumber of [...committed.keys()]) releaseCommitted(pageNumber);
        notifyIdle();
    }

    function dispose() {
        if (disposed) {
            return;
        }
        disposed = true;
        reset();
    }

    return {
        dispose,
        getSnapshot: () => ({
            activeCount,
            activePages: [...active.keys()],
            committedPages: [...committed.keys()],
            queuedPages: [...queued.keys()],
        }),
        reconcile,
        reset,
        whenIdle() {
            if (activeCount === 0 && queued.size === 0) {
                return Promise.resolve();
            }
            return new Promise<void>(resolve => idleWaiters.add(resolve));
        },
    };
}
