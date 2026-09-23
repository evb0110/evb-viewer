import {getErrorMessage} from '@contracts/getErrorMessage';
import type {TScanCleanupLog} from '@evb/scan-cleanup/core/types';

/**
 * Residency state of one page inside the window. `staging` reserves a slot for
 * an unpublished render; `evicting` keeps the slot until its file is dropped.
 */
type TStagedRasterState = 'staging' | 'ready' | 'evicting';

export interface IStagedRasterWindowDependencies {
    /** Pages the window may stage, in the order the consumer reads them. */
    pages: readonly number[];
    /** Maximum number of staged rasters resident at once. At least one. */
    window: number;
    /** Renders one page and publishes it atomically at its manifest path. */
    stage: (pageNumber: number) => Promise<void>;
    /** Drops one staged raster. Called once per page the window admitted. */
    unstage: (pageNumber: number) => Promise<void>;
    /**
     * Whether the page's raster is readable right now. The window trusts its
     * own bookkeeping for accounting but re-probes before handing a lease out,
     * so a raster something else removed is re-rendered instead of leaving the
     * consumer waiting for a file nobody will publish.
     */
    isStaged: (pageNumber: number) => Promise<boolean>;
    /**
     * Pages whose raster already exists and is owned by something else, such as
     * a cache entry a previous render left behind. They are readable without a
     * render and cost this window no scratch, because they were already on disk
     * when the window was admitted, so they never occupy one of its slots and
     * are never dropped by it. One that disappears becomes an ordinary staged
     * page and is re-rendered.
     */
    alreadyStaged?: readonly number[];
    /** Announced whenever this window publishes a staged raster. */
    onStaged?: (pageNumber: number) => void;
    log?: TScanCleanupLog;
}

/**
 * A bounded, replayable staging window over a document's page rasters.
 *
 * The consumer leases a page before reading it and releases the lease when it
 * has finished. Between those two points the raster is pinned; outside them the
 * window may drop it and re-render identical pixels on the next lease. The
 * producer keeps every open render and published page inside the admitted
 * window, while filling freed slots ahead of the reader.
 */
export function createStagedRasterWindow(dependencies: IStagedRasterWindowDependencies) {
    const window = Math.max(1, Math.floor(dependencies.window));
    const log = dependencies.log ?? (() => undefined);
    const held = new Map<number, TStagedRasterState>();
    const external = new Set<number>(dependencies.alreadyStaged ?? []);
    const leased = new Set<number>();
    /** Pages the consumer has finished reading since their raster was staged. */
    const released = new Set<number>();
    const readingIndexByPage = new Map(dependencies.pages.map((pageNumber, index) => [
        pageNumber,
        index,
    ]));
    /** Furthest reading position reached by the consumer. */
    let cursorIndex = -1;
    const inFlight = new Map<number, Promise<void>>();
    const admitted = new Set<number>();
    const prefetchFailures = new Set<number>();
    const slotWaiters = new Set<() => void>();
    /** Advances on every slot change, so a waiter cannot miss one that raced its check. */
    let slotVersion = 0;
    let peakResident = 0;
    let prefetchTask: Promise<void> | null = null;
    let prefetchRequested = false;
    let closed = false;

    const observeResident = () => {
        peakResident = Math.max(peakResident, held.size);
    };
    const notifySlotWaiters = () => {
        slotVersion += 1;
        const waiters = [...slotWaiters];
        slotWaiters.clear();
        for (const wake of waiters) wake();
    };
    const waitForSlotChange = (seenVersion = slotVersion) => new Promise<void>(resolve => {
        slotWaiters.add(resolve);
        if (closed || slotVersion !== seenVersion) {
            slotWaiters.delete(resolve);
            resolve();
        }
    });

    /**
     * The sidecar announces a lease and then reads the raster as soon as it
     * exists on disk. Released pages are safe to reclaim. A page inside the
     * reading horizon can already be open by native code, so on-demand staging
     * leaves it resident and waits for a lease release instead of exceeding the
     * bound.
     */
    const evictionCandidates = (exclude: number) => {
        const candidates = [...held]
            .filter(([
                pageNumber,
                state,
            ]) => state === 'ready' && pageNumber !== exclude && !leased.has(pageNumber))
            .map(([pageNumber]) => pageNumber);
        const indexOf = (pageNumber: number) => readingIndexByPage.get(pageNumber) ?? -1;
        const distance = (pageNumber: number) => Math.abs(indexOf(pageNumber) - cursorIndex);
        const releasedCandidates = candidates.filter(pageNumber => released.has(pageNumber));
        const outsideBand = candidates
            .filter(pageNumber => !released.has(pageNumber) && distance(pageNumber) > window)
            .sort((left, right) => distance(right) - distance(left));
        return [
            ...releasedCandidates,
            ...outsideBand,
        ];
    };

    const evictOneUnleasedPage = async (exclude: number, releasedOnly = false) => {
        const candidates = evictionCandidates(exclude);
        const victim = releasedOnly
            ? candidates.find(pageNumber => released.has(pageNumber))
            : candidates[0];
        if (victim === undefined) return false;

        held.set(victim, 'evicting');
        try {
            await dependencies.unstage(victim);
            admitted.delete(victim);
        } catch (error) {
            // A refused unlink is housekeeping: keep the raster admitted so
            // disposal can drop it again, and let the waiting lease proceed.
            log(
                'warn',
                `Scan cleanup could not drop staged detection raster for page ${victim}: ${getErrorMessage(error)}`,
            );
        } finally {
            held.delete(victim);
            released.delete(victim);
            notifySlotWaiters();
        }
        return true;
    };

    /** Reserve before yielding so parallel renders cannot take the same slot. */
    const reserveSlot = async (pageNumber: number) => {
        while (!closed) {
            if (held.size < window) {
                held.set(pageNumber, 'staging');
                observeResident();
                return;
            }
            // An eviction elsewhere can free a slot while this one is refused.
            const seenVersion = slotVersion;
            if (await evictOneUnleasedPage(pageNumber)) continue;
            await waitForSlotChange(seenVersion);
        }
        throw new Error(`Scan cleanup staged raster window closed before page ${pageNumber} could be staged`);
    };

    const stageSinglePage = (pageNumber: number): Promise<void> => {
        const pending = inFlight.get(pageNumber);
        if (pending) return pending;

        const task = (async () => {
            while (!closed) {
                if (external.has(pageNumber)) {
                    if (await dependencies.isStaged(pageNumber)) return;
                    // The cache entry this page was reusing is gone. Rendering it
                    // again makes it this window's page, slot and all.
                    external.delete(pageNumber);
                }

                const state = held.get(pageNumber);
                if (state === 'ready') {
                    if (await dependencies.isStaged(pageNumber)) return;
                    // A raster removed by another owner becomes an ordinary
                    // staged page again.
                    held.delete(pageNumber);
                    notifySlotWaiters();
                } else if (state === 'staging' || state === 'evicting') {
                    await waitForSlotChange();
                    continue;
                }

                await reserveSlot(pageNumber);
                try {
                    await dependencies.stage(pageNumber);
                } catch (error) {
                    held.delete(pageNumber);
                    notifySlotWaiters();
                    throw error;
                }
                held.set(pageNumber, 'ready');
                released.delete(pageNumber);
                observeResident();
                admitted.add(pageNumber);
                dependencies.onStaged?.(pageNumber);
                notifySlotWaiters();
                return;
            }
            throw new Error(`Scan cleanup staged raster window closed before page ${pageNumber} was ready`);
        })();
        const tracked = task.finally(() => {
            if (inFlight.get(pageNumber) === tracked) inFlight.delete(pageNumber);
            notifySlotWaiters();
        });
        inFlight.set(pageNumber, tracked);
        return tracked;
    };

    /** Leases that have no slot yet. A page already rendering holds its slot. */
    const waitingLeaseCount = () => [...leased]
        .filter(pageNumber => !held.has(pageNumber) && !external.has(pageNumber))
        .length;

    const prefetchNext = () => {
        if (closed) return;
        prefetchRequested = true;
        if (prefetchTask !== null) return;

        prefetchTask = (async () => {
            while (prefetchRequested && !closed) {
                prefetchRequested = false;
                while (!closed) {
                    const next = dependencies.pages.find(
                        (pageNumber, index) => index > cursorIndex
                            && !held.has(pageNumber)
                            && !external.has(pageNumber)
                            && !inFlight.has(pageNumber),
                    );
                    // Read-ahead stops at a page it could not stage rather than
                    // skipping it. Staging past it would fill the window with
                    // unread pages that may not be dropped, and that page's own
                    // lease could then wait for a slot nobody frees.
                    if (next === undefined || prefetchFailures.has(next)) break;
                    // A lease still waiting for its raster owns the next free
                    // slot. Prefetching past it would fill the window with
                    // unread pages that cannot be evicted, and the lease would
                    // wait for a slot nobody frees.
                    if (waitingLeaseCount() > 0) break;
                    if (held.size >= window) {
                        // Forward prefetch only reclaims a page native explicitly
                        // released. Unleased pages in the reading horizon may
                        // already be open by the sidecar.
                        if (!await evictOneUnleasedPage(next, true)) break;
                        continue;
                    }
                    void stageSinglePage(next).catch((error: unknown) => {
                        if (closed) return;
                        prefetchFailures.add(next);
                        log(
                            'debug',
                            `Scan cleanup could not stage page ${next} ahead of its lease: ${getErrorMessage(error)}`,
                        );
                        prefetchNext();
                    });
                }
            }
        })().finally(() => {
            prefetchTask = null;
            if (prefetchRequested && !closed) prefetchNext();
        });
    };

    return {
        /** Start the first input, then fill the remaining slots beside analysis. */
        async prime() {
            const firstPage = dependencies.pages[0];
            if (firstPage === undefined) return;
            cursorIndex = 0;
            const firstPageTask = stageSinglePage(firstPage);
            prefetchNext();
            await firstPageTask;
        },
        /** Pin one page and guarantee its raster is readable. */
        async acquire(pageNumber: number) {
            if (closed) throw new Error('Scan cleanup staged raster window is closed');
            leased.add(pageNumber);
            released.delete(pageNumber);
            prefetchFailures.delete(pageNumber);
            cursorIndex = Math.max(cursorIndex, readingIndexByPage.get(pageNumber) ?? cursorIndex);
            try {
                await stageSinglePage(pageNumber);
            } catch (error) {
                leased.delete(pageNumber);
                notifySlotWaiters();
                throw error;
            }
        },
        /** Unpin one page and refill the window immediately. */
        release(pageNumber: number) {
            leased.delete(pageNumber);
            if (held.has(pageNumber)) {
                released.add(pageNumber);
            } else {
                released.delete(pageNumber);
            }
            notifySlotWaiters();
            prefetchNext();
        },
        /** Ask the producer to fill every free slot ahead of the reader. */
        prefetchNext() {
            prefetchNext();
        },
        /**
         * Close the window. A successful run hands resident rasters to the
         * cache; a failed or canceled run drops every raster it admitted.
         */
        async dispose({retainStaged} = {retainStaged: false}) {
            closed = true;
            notifySlotWaiters();
            await Promise.allSettled([
                ...inFlight.values(),
                ...(prefetchTask === null ? [] : [prefetchTask]),
            ]);
            if (retainStaged) {
                admitted.clear();
                held.clear();
                leased.clear();
                return;
            }
            const staged = [...admitted];
            admitted.clear();
            held.clear();
            leased.clear();
            const settled = await Promise.allSettled(staged.map(pageNumber => dependencies.unstage(pageNumber)));
            for (const outcome of settled) {
                if (outcome.status === 'rejected') {
                    log(
                        'warn',
                        `Scan cleanup could not drop a staged detection raster: ${getErrorMessage(outcome.reason)}`,
                    );
                }
            }
        },
        /** Pages this window still holds on disk. Diagnostics and tests only. */
        residentPages() {
            return [...held.keys()];
        },
        /** Highest number of rasters this window ever held at once. */
        peakResidentPages() {
            return peakResident;
        },
    };
}

export type TStagedRasterWindow = ReturnType<typeof createStagedRasterWindow>;
