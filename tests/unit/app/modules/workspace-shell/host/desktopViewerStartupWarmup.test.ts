import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    scheduleDesktopViewerWarmup,
    type IScheduleDesktopViewerWarmupOptions,
} from '@app/modules/workspace-shell/host/warmupDesktopViewerChunks';
import type {
    TWorkspaceViewerChunkLoader,
    TWorkspaceViewerChunkTarget,
} from '@app/modules/workspace-shell/viewers/workspaceViewerChunkLoaders';
import type { TCancelIdleWork } from '@app/utils/scheduleIdleWork';

function createHarness(overrides: Partial<Record<TWorkspaceViewerChunkTarget, TWorkspaceViewerChunkLoader>> = {}) {
    const loaded: TWorkspaceViewerChunkTarget[] = [];
    const idleCallbacks: Array<() => void | Promise<void>> = [];
    const cancelledCallbacks = new Set<() => void | Promise<void>>();
    const loaderOverrides = Object.fromEntries([
        'chassis',
        'pdfjs',
        'page-source',
    ].map((target) => {
        const typedTarget = target as TWorkspaceViewerChunkTarget;
        return [
            typedTarget,
            overrides[typedTarget] ?? vi.fn(async () => {
                loaded.push(typedTarget);
            }),
        ];
    })) as Record<TWorkspaceViewerChunkTarget, TWorkspaceViewerChunkLoader>;
    const scheduleIdle = vi.fn((work: () => void | Promise<void>): TCancelIdleWork => {
        idleCallbacks.push(work);
        return () => {
            cancelledCallbacks.add(work);
        };
    });

    return {
        idleCallbacks,
        loaded,
        loaderOverrides,
        pendingIdleCount: () => idleCallbacks.filter(callback => !cancelledCallbacks.has(callback)).length,
        runNextIdle: async () => {
            const callback = idleCallbacks.find(candidate => !cancelledCallbacks.has(candidate));
            if (!callback) {
                return;
            }
            cancelledCallbacks.add(callback);
            await callback();
        },
        scheduleIdle,
    };
}

function schedule(
    strategy: IScheduleDesktopViewerWarmupOptions['strategy'],
    harness: ReturnType<typeof createHarness>,
) {
    return scheduleDesktopViewerWarmup({
        isDesktopRuntime: true,
        strategy,
        loaderOverrides: harness.loaderOverrides,
        scheduleIdle: harness.scheduleIdle,
    });
}

describe('scheduleDesktopViewerWarmup', () => {
    it('skips every loader on the low strategy', () => {
        const harness = createHarness();

        expect(schedule('skip', harness)).toBeNull();
        expect(harness.scheduleIdle).not.toHaveBeenCalled();
        expect(harness.loaded).toEqual([]);
    });

    it('runs one medium-tier target per idle turn in canonical order', async () => {
        const harness = createHarness();
        const handle = schedule('staged', harness);

        expect(harness.loaded).toEqual([]);
        expect(harness.pendingIdleCount()).toBe(1);
        for (const expected of [
            'chassis',
            'pdfjs',
            'page-source',
        ]) {
            await harness.runNextIdle();
            expect(harness.loaded.at(-1)).toBe(expected);
        }
        await expect(handle?.completion).resolves.toBeUndefined();
        expect(harness.scheduleIdle).toHaveBeenCalledTimes(3);
    });

    it('runs every high-tier loader concurrently from one idle turn', async () => {
        const harness = createHarness();
        const handle = schedule('eager', harness);

        expect(harness.loaded).toEqual([]);
        expect(harness.pendingIdleCount()).toBe(1);
        await harness.runNextIdle();

        await expect(handle?.completion).resolves.toBeUndefined();
        expect(harness.loaded).toEqual([
            'chassis',
            'pdfjs',
            'page-source',
        ]);
        expect(harness.scheduleIdle).toHaveBeenCalledOnce();
    });

    it('stops staged work after a loader rejects', async () => {
        const rejection = new Error('pdfjs unavailable');
        const harness = createHarness({pdfjs: vi.fn(async () => {
            throw rejection;
        })});
        const handle = schedule('staged', harness);

        await harness.runNextIdle();
        await harness.runNextIdle();

        await expect(handle?.completion).rejects.toBe(rejection);
        expect(harness.scheduleIdle).toHaveBeenCalledTimes(2);
    });

    it('cancels a pending first stage', async () => {
        const harness = createHarness();
        const handle = schedule('staged', harness);

        handle?.cancel();
        await harness.runNextIdle();

        await expect(handle?.completion).resolves.toBeUndefined();
        expect(harness.loaded).toEqual([]);
    });

    it('cancels pending later stages after the current stage settles', async () => {
        const harness = createHarness();
        const handle = schedule('staged', harness);

        await harness.runNextIdle();
        handle?.cancel();
        await harness.runNextIdle();

        await expect(handle?.completion).resolves.toBeUndefined();
        expect(harness.loaded).toEqual(['chassis']);
    });
});
