import {getErrorMessage} from '@contracts/getErrorMessage';
import type {TScanCleanupLog} from '@evb/scan-cleanup/core/types';

/**
 * Residency state of one page inside the window. `staging` means a render is
 * writing it right now, so its slot is taken but the file is not yet publishable
 * and must never be evicted; `ready` means the raster is published and readable.
 */
type TStagedRasterState = 'staging' | 'ready';

export interface IStagedRasterWindowDependencies {
    /** Pages the window may stage, in the order the consumer reads them. */
    pages: readonly number[];
    /** Maximum number of staged rasters resident at once. At least one. */
    window: number;
    /** Renders one page and publishes it atomically at its manifest path. */
    stage: (pageNumber: number) => Promise<void>;
    /** Renders one bounded forward window in a single native invocation. */
    stageBatch?: (pageNumbers: readonly number[]) => Promise<void>;
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
    /** Announced once per page the first time this window stages it. */
    onStaged?: (pageNumber: number) => void;
    log?: TScanCleanupLog;
}

/**
 * A bounded, replayable staging window over a document's page rasters.
 *
 * The consumer leases a page before reading it and releases the lease when it
 * has finished. Between those two points the raster is pinned; outside them the
 * window may drop it and re-render identical pixels on the next lease. That is
 * what lets a document of any length be analysed against a fixed scratch
 * footprint without changing which pixels the analysis sees.
 *
 * Residency is `held.size`, counting both published rasters and the renders
 * currently producing one, so concurrent leases can never overshoot the window
 * by racing between the eviction and the render that follows it.
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
    /** Reading position: the index of the page the consumer asked for last. */
    let cursorIndex = -1;
    const inFlight = new Map<number, Promise<void>>();
    const admitted = new Set<number>();
    let peakResident = 0;
    let prefetching = false;
    let closed = false;

    const observeResident = () => {
        peakResident = Math.max(peakResident, held.size);
    };
    /**
     * Pick the resident raster the consumer is least likely to read next.
     *
     * The sidecar announces a lease and then reads the raster as soon as it
     * exists on disk, so a page inside the reading horizon can be read before
     * this window has processed the announcement. Evicting one of those pages
     * races that read. Released pages are safe, and pages far from the reading
     * position will be re-rendered on demand; pages within one window of the
     * cursor are only taken when nothing else is resident.
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
    const pickEvictionVictim = (exclude: number) => evictionCandidates(exclude)[0];
    const evictOneUnleasedPage = async (exclude: number) => {
        const victim = pickEvictionVictim(exclude);
        for (const [
            pageNumber,
            state,
        ] of held) {
            if (state !== 'ready' || pageNumber !== victim) {
                continue;
            }
            // Claim the slot before awaiting so a concurrent lease cannot pick
            // the same victim and free one raster while believing it freed two.
            held.delete(pageNumber);
            try {
                await dependencies.unstage(pageNumber);
                admitted.delete(pageNumber);
            } catch (error) {
                // Reclaiming a slot is housekeeping, not the lease the consumer
                // is waiting for: a filesystem that refuses this unlink must not
                // fail the page that needed the slot, exactly as disposal treats
                // the same refusal. The page stays admitted so disposal drops it
                // again at the end of the run, and stays out of `held` so slot
                // accounting keeps shrinking rather than counting a raster this
                // window has already given up on.
                log(
                    'warn',
                    `Scan cleanup could not drop staged detection raster for page ${pageNumber}: ${getErrorMessage(error)}`,
                );
            }
            return true;
        }
        return false;
    };
    /**
     * Take one slot for `pageNumber` and mark it as rendering.
     *
     * The claim is what makes the bound hold: every path out of the wait loop
     * writes `staging` into `held` before it yields again, so two renders that
     * both observed a free slot cannot both take it. Splitting the check from
     * the claim across an await is exactly the race that lets a window of two
     * hold three rasters.
     */
    const reserveSlot = async (pageNumber: number) => {
        while (held.size >= window) {
            if (await evictOneUnleasedPage(pageNumber)) {
                continue;
            }
            if (pickEvictionVictim(pageNumber) === undefined) {
                // Every resident raster is leased, still rendering, or sits
                // inside the reading band. A render in flight only becomes
                // another in-band page, and it may be the batch this very call
                // belongs to, so waiting would deadlock; admit this page and
                // let the window overshoot by one raster instead.
                log(
                    'warn',
                    `Scan cleanup staged raster window of ${window} is fully leased or in use; page ${pageNumber} exceeds it by one raster`,
                );
                break;
            }
            // Every resident raster is either leased or still rendering, so no
            // slot can be freed yet. Waiting for the renders in flight is the
            // only progress available; they are the pages that will become
            // evictable next. This page's own render is excluded: it is the one
            // waiting here.
            const pending = [...inFlight]
                .filter(([staging]) => staging !== pageNumber)
                .map(([
                    ,
                    render,
                ]) => render);
            if (pending.length === 0) {
                // The consumer holds a lease on every slot. Admitting this page
                // anyway keeps the run alive rather than deadlocking it, and the
                // overshoot is one raster, but it means the window was sized
                // below the consumer's own concurrency.
                log(
                    'warn',
                    `Scan cleanup staged raster window of ${window} is fully leased; page ${pageNumber} exceeds it by one raster`,
                );
                break;
            }
            await Promise.allSettled(pending);
        }
        held.set(pageNumber, 'staging');
        observeResident();
    };
    const stageSinglePage = (pageNumber: number) => {
        const pending = inFlight.get(pageNumber);
        if (pending) {
            return pending;
        }
        const task = (async () => {
            if (external.has(pageNumber)) {
                if (await dependencies.isStaged(pageNumber)) {
                    return;
                }
                // The cache entry this page was reusing is gone. Rendering it
                // again makes it this window's page, slot and all.
                external.delete(pageNumber);
            }
            if (held.get(pageNumber) === 'ready' && await dependencies.isStaged(pageNumber)) {
                return;
            }
            // Either the page was never staged, or its raster disappeared. Both
            // are answered by rendering the same deterministic pixels again.
            held.delete(pageNumber);
            await reserveSlot(pageNumber);
            try {
                await dependencies.stage(pageNumber);
            } catch (error) {
                held.delete(pageNumber);
                throw error;
            }
            held.set(pageNumber, 'ready');
            released.delete(pageNumber);
            observeResident();
            if (!admitted.has(pageNumber)) {
                admitted.add(pageNumber);
            }
            dependencies.onStaged?.(pageNumber);
        })();
        const tracked = task.finally(() => {
            if (inFlight.get(pageNumber) === tracked) inFlight.delete(pageNumber);
        });
        inFlight.set(pageNumber, tracked);
        return tracked;
    };
    let batchStageTail = Promise.resolve();
    const stagePage = (pageNumber: number) => {
        if (dependencies.stageBatch === undefined) {
            return stageSinglePage(pageNumber);
        }
        const pending = inFlight.get(pageNumber);
        if (pending) {
            return pending;
        }
        const task = batchStageTail.then(async () => {
            if (external.has(pageNumber)) {
                if (await dependencies.isStaged(pageNumber)) {
                    return;
                }
                external.delete(pageNumber);
            }
            if (held.get(pageNumber) === 'ready' && await dependencies.isStaged(pageNumber)) {
                return;
            }
            held.delete(pageNumber);
            const firstIndex = dependencies.pages.indexOf(pageNumber);
            const forwardPages = firstIndex < 0
                ? [pageNumber]
                : dependencies.pages.slice(firstIndex, firstIndex + window);
            const evictable = evictionCandidates(pageNumber).length;
            const capacity = Math.max(1, window - held.size + evictable);
            const batch = forwardPages
                .filter(candidate => (
                    !external.has(candidate)
                    && held.get(candidate) !== 'ready'
                ))
                .slice(0, capacity);
            if (!batch.includes(pageNumber)) {
                batch.unshift(pageNumber);
                batch.splice(capacity);
            }
            for (const candidate of batch) {
                held.delete(candidate);
                await reserveSlot(candidate);
            }
            try {
                await dependencies.stageBatch!(batch);
                for (const candidate of batch) {
                    if (!await dependencies.isStaged(candidate)) {
                        throw new Error(`Scan cleanup batch did not publish page ${String(candidate)}`);
                    }
                    held.set(candidate, 'ready');
                    released.delete(candidate);
                    if (!admitted.has(candidate)) {
                        admitted.add(candidate);
                    }
                    dependencies.onStaged?.(candidate);
                }
                observeResident();
            } catch (error) {
                for (const candidate of batch) {
                    held.delete(candidate);
                }
                throw error;
            }
        });
        batchStageTail = task.then(() => undefined, () => undefined);
        const tracked = task.finally(() => {
            if (inFlight.get(pageNumber) === tracked) inFlight.delete(pageNumber);
        });
        inFlight.set(pageNumber, tracked);
        return tracked;
    };

    return {
        /**
         * Fill the window before the consumer starts, so the first pages it
         * asks for are already readable and its own page sizing has real
         * rasters to measure.
         */
        async prime() {
            await Promise.all(dependencies.pages.slice(0, window).map(pageNumber => stagePage(pageNumber)));
        },
        /** Pin one page and guarantee its raster is readable. */
        async acquire(pageNumber: number) {
            leased.add(pageNumber);
            released.delete(pageNumber);
            cursorIndex = readingIndexByPage.get(pageNumber) ?? cursorIndex;
            await stagePage(pageNumber);
        },
        /**
         * Unpin one page. The raster stays until the window needs its slot, so
         * an immediate second read costs nothing, and the next page in reading
         * order is rendered ahead while the consumer works.
         */
        release(pageNumber: number) {
            leased.delete(pageNumber);
            released.add(pageNumber);
            this.prefetchNext();
        },
        /**
         * Render the next unstaged page while a slot is free. A prefetch is an
         * optimisation: a failure is logged and left for the on-demand lease to
         * retry, never surfaced as a run failure.
         */
        prefetchNext() {
            if (closed || prefetching || held.size >= window) {
                return;
            }
            // Prefetch runs ahead of the reader, never behind it: a consumed
            // page that was evicted must not be re-rendered into a slot the
            // next page in reading order needs.
            const next = dependencies.pages.find(
                (pageNumber, index) => index > cursorIndex
                    && !held.has(pageNumber)
                    && !external.has(pageNumber)
                    && !inFlight.has(pageNumber),
            );
            if (next === undefined) {
                return;
            }
            prefetching = true;
            void stagePage(next)
                .catch((error: unknown) => {
                    log(
                        'debug',
                        `Scan cleanup could not stage page ${next} ahead of its lease: ${getErrorMessage(error)}`,
                    );
                })
                .finally(() => {
                    prefetching = false;
                });
        },
        /**
         * Close the window.
         *
         * One ownership rule governs every raster this window staged: the
         * window owns it until the run ends. A run that published its results
         * hands the rasters still resident to the raster cache, which is the
         * same thing an ordinary page render leaves behind and is bounded by
         * the window. A run that failed or was canceled destroys them, so a
         * detection that published nothing also leaves nothing behind.
         */
        async dispose({retainStaged} = {retainStaged: false}) {
            closed = true;
            await Promise.allSettled([...inFlight.values()]);
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
