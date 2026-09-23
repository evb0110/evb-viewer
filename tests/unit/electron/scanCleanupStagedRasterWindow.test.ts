import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createStagedRasterWindow} from '@evb/scan-cleanup/core/createStagedRasterWindow';

function createRecordingWindow(
    pages: readonly number[],
    window: number,
    overrides: {stage?: (pageNumber: number) => Promise<void>} = {},
) {
    const resident = new Set<number>();
    const staged: number[] = [];
    const unstaged: number[] = [];
    let peak = 0;
    const controller = createStagedRasterWindow({
        pages,
        window,
        async stage(pageNumber) {
            await overrides.stage?.(pageNumber);
            resident.add(pageNumber);
            staged.push(pageNumber);
            peak = Math.max(peak, resident.size);
        },
        async unstage(pageNumber) {
            resident.delete(pageNumber);
            unstaged.push(pageNumber);
        },
        async isStaged(pageNumber) {
            return resident.has(pageNumber);
        },
    });
    return {
        controller,
        resident,
        staged,
        unstaged,
        peak: () => peak,
    };
}

describe('createStagedRasterWindow', () => {
    it('fills free slots concurrently ahead of the first lease', async () => {
        const pages = Array.from({length: 8}, (_, index) => index + 1);
        const resident = new Set<number>();
        const stageStarted = new Set<number>();
        const stageGate = Promise.withResolvers<undefined>();
        let activeStages = 0;
        let peakActiveStages = 0;
        const controller = createStagedRasterWindow({
            pages,
            window: 4,
            async stage(pageNumber) {
                stageStarted.add(pageNumber);
                if (pageNumber > 1) {
                    activeStages += 1;
                    peakActiveStages = Math.max(peakActiveStages, activeStages);
                    await stageGate.promise;
                    activeStages -= 1;
                }
                resident.add(pageNumber);
            },
            unstage: async pageNumber => {
                resident.delete(pageNumber);
            },
            isStaged: async pageNumber => resident.has(pageNumber),
        });

        await controller.prime();
        await vi.waitFor(() => expect(stageStarted.size).toBe(4));
        expect(resident.has(1)).toBe(true);
        expect(peakActiveStages).toBe(3);
        expect(controller.peakResidentPages()).toBe(4);
        stageGate.resolve(undefined);
        await vi.waitFor(() => expect(resident.size).toBe(4));

        for (const pageNumber of pages) {
            await controller.acquire(pageNumber);
            expect(resident.has(pageNumber)).toBe(true);
            expect(resident.size).toBeLessThanOrEqual(4);
            controller.release(pageNumber);
        }
        await controller.dispose();
        expect(resident.size).toBe(0);
    });

    it('keeps at most one window of rasters on disk across a long document', async () => {
        const pages = Array.from({length: 148}, (_, index) => index + 1);
        const harness = createRecordingWindow(pages, 3);
        await harness.controller.prime();
        for (const pageNumber of pages) {
            await harness.controller.acquire(pageNumber);
            expect(harness.resident.has(pageNumber)).toBe(true);
            expect(harness.resident.size).toBeLessThanOrEqual(3);
            harness.controller.release(pageNumber);
        }
        await harness.controller.dispose();

        expect(harness.peak()).toBeLessThanOrEqual(3);
        expect(harness.controller.peakResidentPages()).toBeLessThanOrEqual(3);
        // Every page was read, and the document never needed to exist at once.
        expect(new Set(harness.staged)).toEqual(new Set(pages));
        expect(harness.resident.size).toBe(0);
    });

    it('waits for a released slot instead of growing residency when all pages are leased', async () => {
        const harness = createRecordingWindow([
            1,
            2,
            3,
            4,
        ], 2);
        await harness.controller.acquire(1);
        await harness.controller.acquire(2);
        const thirdPage = harness.controller.acquire(3);
        expect(harness.resident.size).toBe(2);
        expect(harness.resident.has(3)).toBe(false);

        harness.controller.release(1);
        await thirdPage;
        expect(harness.resident.has(1)).toBe(false);
        expect(harness.resident.has(2)).toBe(true);
        expect(harness.resident.has(3)).toBe(true);
        expect(harness.resident.size).toBeLessThanOrEqual(2);

        harness.controller.release(2);
        harness.controller.release(3);
        await harness.controller.acquire(4);
        expect(harness.resident.size).toBeLessThanOrEqual(2);
        await harness.controller.dispose();
        expect(harness.resident.size).toBe(0);
    });

    it('drops a released page before filling the next forward slot', async () => {
        const harness = createRecordingWindow([
            1,
            2,
            3,
            4,
        ], 2);
        await harness.controller.acquire(1);
        harness.controller.release(1);
        await vi.waitFor(() => expect(harness.resident.has(2)).toBe(true));
        await harness.controller.acquire(2);
        harness.controller.release(2);
        await vi.waitFor(() => {
            expect(harness.resident.has(1)).toBe(false);
            expect(harness.resident.has(3)).toBe(true);
        });
        expect(harness.resident.size).toBeLessThanOrEqual(2);
        await harness.controller.dispose();
        expect(harness.resident.size).toBe(0);
    });

    it('keeps a prefetched page readable when another in-window lease advances', async () => {
        const harness = createRecordingWindow(Array.from({length: 8}, (_, index) => index + 1), 3);
        await harness.controller.prime();
        await vi.waitFor(() => expect(harness.resident.size).toBe(3));
        await harness.controller.acquire(1);
        harness.controller.release(1);
        await vi.waitFor(() => expect(harness.resident.has(4)).toBe(true));
        await harness.controller.acquire(3);
        expect(harness.resident.has(2)).toBe(true);
        expect(harness.resident.has(3)).toBe(true);
        expect(harness.resident.size).toBeLessThanOrEqual(3);
        harness.controller.release(3);
        await harness.controller.dispose();
    });

    it('re-renders a released page instead of consuming it', async () => {
        const harness = createRecordingWindow([
            1,
            2,
        ], 1);
        await harness.controller.acquire(1);
        harness.controller.release(1);
        await harness.controller.acquire(2);
        expect(harness.unstaged).toContain(1);
        harness.controller.release(2);
        // Reconciliation re-reads page 1 after the window already dropped it.
        await harness.controller.acquire(1);
        expect(harness.resident.has(1)).toBe(true);
        expect(harness.staged).toContain(1);
        await harness.controller.dispose();
    });

    it('re-renders a staged raster that disappeared underneath it', async () => {
        const harness = createRecordingWindow([1], 2);
        await harness.controller.acquire(1);
        harness.controller.release(1);
        harness.resident.delete(1);
        await harness.controller.acquire(1);
        expect(harness.resident.has(1)).toBe(true);
        expect(harness.staged).toEqual([
            1,
            1,
        ]);
        await harness.controller.dispose();
    });

    it('holds concurrent leases inside the window under parallel demand', async () => {
        const readerCount = 4;
        const pages = Array.from({length: 40}, (_, index) => index + 1);
        const harness = createRecordingWindow(pages, readerCount, {stage: async () => {
            await new Promise(resolve => setTimeout(resolve, 1));
        }});
        await harness.controller.prime();
        // A barrier rather than a sleep: every reader holds its first lease
        // until all four have one, so the concurrency this measures is a fact
        // about the window rather than about how the scheduler happened to
        // interleave four timers. Four leases fit a window of four, so nothing
        // here can wait on a slot that will not be freed.
        let arrived = 0;
        const allLeased = Promise.withResolvers<undefined>();
        const holdUntilAllLeased = async () => {
            arrived += 1;
            if (arrived === readerCount) allLeased.resolve(undefined);
            await allLeased.promise;
        };
        // Recorded rather than asserted inside the readers: an assertion that
        // throws while three readers are parked on the barrier would be
        // reported as a timeout instead of as the residency it disagreed with.
        const unreadablePages: number[] = [];
        const residentAtLease: number[] = [];
        const firstLeaseByReader: number[] = [];
        let leases = 0;
        let peakLeases = 0;
        let next = 0;
        const readers = Array.from({length: readerCount}, async (_value, reader) => {
            let leasedBefore = false;
            while (next < pages.length) {
                const pageNumber = pages[next]!;
                next += 1;
                await harness.controller.acquire(pageNumber);
                leases += 1;
                peakLeases = Math.max(peakLeases, leases);
                if (!harness.resident.has(pageNumber)) unreadablePages.push(pageNumber);
                residentAtLease.push(harness.resident.size);
                if (leasedBefore) {
                    await new Promise(resolve => setTimeout(resolve, 1));
                } else {
                    leasedBefore = true;
                    firstLeaseByReader[reader] = pageNumber;
                    await holdUntilAllLeased();
                }
                leases -= 1;
                harness.controller.release(pageNumber);
            }
        });
        await Promise.all(readers);
        await harness.controller.dispose();

        // Four readers held a lease at the same moment, so the residency bound
        // below is a bound on real concurrency and not on serialized reads.
        expect(peakLeases).toBe(readerCount);
        // Each reader's first lease is one of the pages priming staged, so the
        // barrier they all wait on can never ask the window for a fifth slot.
        expect(firstLeaseByReader).toEqual([
            1,
            2,
            3,
            4,
        ]);
        expect(unreadablePages).toEqual([]);
        expect(Math.max(...residentAtLease)).toBeGreaterThan(1);
        expect(Math.max(...residentAtLease)).toBeLessThanOrEqual(readerCount);
        expect(harness.peak()).toBeGreaterThan(1);
        expect(harness.peak()).toBeLessThanOrEqual(readerCount);
        expect(harness.controller.peakResidentPages()).toBeLessThanOrEqual(readerCount);
        expect(harness.resident.size).toBe(0);
    });

    it('drops every staged raster when the run is abandoned', async () => {
        const harness = createRecordingWindow([
            1,
            2,
            3,
        ], 3);
        await harness.controller.prime();
        await vi.waitFor(() => expect(harness.resident.size).toBe(3));
        await harness.controller.dispose();
        expect(harness.resident.size).toBe(0);
        expect(new Set(harness.unstaged)).toEqual(new Set([
            1,
            2,
            3,
        ]));
    });

    it('hands the rasters still resident to the cache when the run succeeded', async () => {
        const harness = createRecordingWindow([
            1,
            2,
        ], 2);
        await harness.controller.prime();
        await vi.waitFor(() => expect(harness.resident.size).toBe(2));
        await harness.controller.dispose({retainStaged: true});
        expect(harness.resident.size).toBe(2);
        expect(harness.unstaged).toEqual([]);
    });

    it('keeps a refused eviction off the lease that needed the slot and drops it at disposal', async () => {
        const refusals = new Map([[
            1,
            1,
        ]]);
        const log = vi.fn();
        const resident = new Set<number>();
        const unstaged: number[] = [];
        const controller = createStagedRasterWindow({
            pages: [
                1,
                2,
            ],
            window: 1,
            async stage(pageNumber) {
                resident.add(pageNumber);
            },
            async unstage(pageNumber) {
                unstaged.push(pageNumber);
                const remaining = refusals.get(pageNumber) ?? 0;
                if (remaining > 0) {
                    refusals.set(pageNumber, remaining - 1);
                    throw new Error(`unstage refused for page ${pageNumber}`);
                }
                resident.delete(pageNumber);
            },
            async isStaged(pageNumber) {
                return resident.has(pageNumber);
            },
            log,
        });
        await controller.acquire(1);
        controller.release(1);
        // A window of one: page 2 can only be admitted by dropping page 1, and
        // the filesystem refuses that drop. Reclaiming a slot is housekeeping,
        // so the lease the consumer is waiting for still succeeds.
        await expect(controller.acquire(2)).resolves.toBeUndefined();
        expect(resident.has(2)).toBe(true);
        expect(log.mock.calls.some(([
            level,
            message,
        ]) => level === 'warn'
            && message.includes('page 1')
            && message.includes('unstage refused for page 1'))).toBe(true);
        // The slot is accounted as free even though the file outlived the
        // eviction, so the window keeps shrinking rather than stalling on a
        // raster it has already given up on.
        expect(controller.residentPages()).toEqual([2]);
        controller.release(2);

        // The refused page stayed admitted, so disposal drops it again, and
        // this time the drop is accepted.
        await controller.dispose();
        expect(unstaged.filter(pageNumber => pageNumber === 1)).toHaveLength(2);
        expect(resident.size).toBe(0);
        expect(controller.residentPages()).toEqual([]);
    });

    it('finishes the run and raises no unhandled rejection when every eviction is refused', async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);
        const log = vi.fn();
        const resident = new Set<number>();
        const controller = createStagedRasterWindow({
            pages: [
                1,
                2,
                3,
            ],
            window: 1,
            async stage(pageNumber) {
                resident.add(pageNumber);
            },
            async unstage(pageNumber) {
                throw new Error(`unstage refused for page ${pageNumber}`);
            },
            async isStaged(pageNumber) {
                return resident.has(pageNumber);
            },
            log,
        });
        try {
            for (const pageNumber of [
                1,
                2,
                3,
            ]) {
                await expect(controller.acquire(pageNumber)).resolves.toBeUndefined();
                controller.release(pageNumber);
            }
            await expect(controller.dispose()).resolves.toBeUndefined();
            // Node reports an unhandled rejection on a later turn than the one
            // that created it, so give it one before reading the record.
            await new Promise(resolve => setTimeout(resolve, 10));
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
        expect(unhandled).toEqual([]);
        // Every refusal was reported: two evictions and the pages disposal
        // could not drop either.
        expect(log.mock.calls.filter(([
            level,
            message,
        ]) => level === 'warn' && message.includes('unstage refused for page')).length)
            .toBeGreaterThanOrEqual(3);
    });

    it('stops read-ahead at a page it could not stage so that page can still be leased', async () => {
        const pages = Array.from({length: 6}, (_, index) => index + 1);
        let failPageThree = true;
        const harness = createRecordingWindow(pages, 2, {stage: async pageNumber => {
            if (pageNumber === 3 && failPageThree) {
                failPageThree = false;
                throw new Error('render failed for page 3');
            }
        }});
        await harness.controller.prime();
        // One sequential reader that lets read-ahead settle between pages, as
        // the sidecar does while it analyses one: nothing else will release a
        // slot while page 3 waits, so read-ahead past the failed page would
        // strand it. Staging here is microtask-only, so one turn settles it.
        for (const pageNumber of pages) {
            await harness.controller.acquire(pageNumber);
            expect(harness.resident.has(pageNumber)).toBe(true);
            harness.controller.release(pageNumber);
            await new Promise(setImmediate);
        }
        expect(harness.peak()).toBeLessThanOrEqual(2);
        await harness.controller.dispose();
        expect(harness.resident.size).toBe(0);
    });

    it('surfaces an on-demand staging failure and swallows a prefetch failure', async () => {
        const failures = new Set([
            2,
            3,
        ]);
        const log = vi.fn();
        const resident = new Set<number>();
        const controller = createStagedRasterWindow({
            pages: [
                1,
                2,
                3,
            ],
            window: 2,
            async stage(pageNumber) {
                if (failures.has(pageNumber)) {
                    throw new Error(`render failed for page ${pageNumber}`);
                }
                resident.add(pageNumber);
            },
            async unstage(pageNumber) {
                resident.delete(pageNumber);
            },
            async isStaged(pageNumber) {
                return resident.has(pageNumber);
            },
            log,
        });
        await controller.acquire(1);
        // Releasing prefetches page 2, whose failure must not fail the run.
        controller.release(1);
        await vi.waitFor(() => {
            expect(log.mock.calls.some(([
                level,
                message,
            ]) => level === 'debug' && message.includes('page 2'))).toBe(true);
        });

        await expect(controller.acquire(2)).rejects.toThrow('render failed for page 2');
        // A failed stage leaves no slot behind: the next page can still be
        // admitted once its own render succeeds.
        failures.delete(3);
        await controller.acquire(3);
        expect(resident.has(3)).toBe(true);
        await controller.dispose();
        expect(resident.size).toBe(0);
    });
});
