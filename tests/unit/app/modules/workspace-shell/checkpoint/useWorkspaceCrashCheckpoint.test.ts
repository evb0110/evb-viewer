import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { THostResourceTier } from '@contracts/hostResourceProfile';
import type * as Vue from 'vue';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

function deferred() {
    let resolve: () => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {
        promise,
        reject,
        resolve,
    };
}

const mocks = vi.hoisted(() => ({
    buildIndex: 0,
    buildWorkspaceCheckpoint: vi.fn(),
    onBeforeUnmount: (() => {}) as () => void,
    saveWorkspaceCheckpoint: vi.fn(),
    tier: 'high' as THostResourceTier,
    watchCallback: (() => {}) as () => void,
}));

vi.mock('vue', async (importOriginal) => {
    const actual = await importOriginal<typeof Vue>();
    return {
        ...actual,
        onBeforeUnmount: (callback: () => void) => {
            mocks.onBeforeUnmount = callback;
        },
        watch: (_source: unknown, callback: () => void) => {
            mocks.watchCallback = callback;
            callback();
            return vi.fn();
        },
    };
});
vi.mock('@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpoint', () => ({buildWorkspaceCheckpoint: mocks.buildWorkspaceCheckpoint}));
const platformApi = createElectronPlatformApiFixture({windowTabs: {saveWorkspaceCheckpoint: mocks.saveWorkspaceCheckpoint}});
vi.mock('@app/utils/platform', () => ({
    getPlatformAPI: () => platformApi,
    waitForDesktopPlatformBridge: vi.fn(async () => {}),
}));
vi.mock('@app/utils/performanceProfile', () => ({getPerformanceProfile: () => ({tier: mocks.tier})}));
vi.mock('@app/utils/asyncGuard', () => ({guardAsync: (promise: Promise<unknown>) => {
    void promise.catch(() => {});
}}));

describe('useWorkspaceCrashCheckpoint', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.useFakeTimers();
        mocks.buildIndex = 0;
        mocks.tier = 'high';
        mocks.buildWorkspaceCheckpoint.mockImplementation(() => ({
            version: 1,
            capturedAt: mocks.buildIndex += 1,
            activePaneId: null,
            activeTabId: null,
            layout: null,
            panes: [],
            tabs: [],
        }));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function mountCheckpointWriter() {
        const {useWorkspaceCrashCheckpoint} = await import(
            '@app/modules/workspace-shell/checkpoint/useWorkspaceCrashCheckpoint'
        );
        useWorkspaceCrashCheckpoint({
            enabled: {value: true},
            tabs: {value: []},
        } as never);
    }

    it('uses 500 ms for medium/high tiers and 1,500 ms for low tier', async () => {
        await mountCheckpointWriter();
        await vi.advanceTimersByTimeAsync(499);
        expect(mocks.saveWorkspaceCheckpoint).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(mocks.saveWorkspaceCheckpoint).toHaveBeenCalledOnce();

        mocks.onBeforeUnmount();
        vi.resetModules();
        vi.clearAllMocks();
        mocks.tier = 'low';
        await mountCheckpointWriter();
        await vi.advanceTimersByTimeAsync(1_499);
        expect(mocks.saveWorkspaceCheckpoint).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(mocks.saveWorkspaceCheckpoint).toHaveBeenCalledOnce();
    });

    it('keeps only the latest checkpoint while one save is active', async () => {
        const firstSave = deferred();
        mocks.saveWorkspaceCheckpoint
            .mockReturnValueOnce(firstSave.promise)
            .mockResolvedValueOnce(undefined);
        await mountCheckpointWriter();
        await vi.advanceTimersByTimeAsync(500);
        expect(mocks.saveWorkspaceCheckpoint).toHaveBeenCalledTimes(1);

        mocks.watchCallback();
        await vi.advanceTimersByTimeAsync(500);
        mocks.watchCallback();
        await vi.advanceTimersByTimeAsync(500);
        expect(mocks.saveWorkspaceCheckpoint).toHaveBeenCalledTimes(1);

        firstSave.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(mocks.saveWorkspaceCheckpoint).toHaveBeenCalledTimes(2);
        expect(mocks.saveWorkspaceCheckpoint.mock.calls[1]?.[0]).toMatchObject({capturedAt: 3});
    });

    it('drains the latest checkpoint after a failed active save', async () => {
        const firstSave = deferred();
        mocks.saveWorkspaceCheckpoint
            .mockReturnValueOnce(firstSave.promise)
            .mockResolvedValueOnce(undefined);
        await mountCheckpointWriter();
        await vi.advanceTimersByTimeAsync(500);
        mocks.watchCallback();
        await vi.advanceTimersByTimeAsync(500);

        firstSave.reject(new Error('failed'));
        await Promise.resolve();
        await Promise.resolve();
        expect(mocks.saveWorkspaceCheckpoint).toHaveBeenCalledTimes(2);
        expect(mocks.saveWorkspaceCheckpoint.mock.calls[1]?.[0]).toMatchObject({capturedAt: 2});
    });

    it('retries the same checkpoint once after a transient save failure', async () => {
        mocks.saveWorkspaceCheckpoint
            .mockRejectedValueOnce(new Error('transient checkpoint failure'))
            .mockResolvedValueOnce(undefined);

        await mountCheckpointWriter();
        await vi.advanceTimersByTimeAsync(500);

        expect(mocks.saveWorkspaceCheckpoint).toHaveBeenCalledTimes(2);
        expect(mocks.saveWorkspaceCheckpoint.mock.calls[1]?.[0]).toMatchObject({capturedAt: 1});
    });

    it('keeps the last persisted checkpoint when capture fails', async () => {
        mocks.buildWorkspaceCheckpoint.mockImplementationOnce(() => {
            throw Object.assign(new Error('workspace snapshot unavailable'), {code: 'WORKSPACE_CHECKPOINT_CAPTURE_FAILED'});
        });

        await mountCheckpointWriter();
        await vi.advanceTimersByTimeAsync(500);

        expect(mocks.saveWorkspaceCheckpoint).not.toHaveBeenCalled();
    });

    it('cancels an unstarted debounce and pending latest save on unmount', async () => {
        await mountCheckpointWriter();
        mocks.onBeforeUnmount();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(mocks.saveWorkspaceCheckpoint).not.toHaveBeenCalled();
    });
});
