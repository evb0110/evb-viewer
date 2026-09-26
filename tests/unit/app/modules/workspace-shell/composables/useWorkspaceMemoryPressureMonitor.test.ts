import {
    computed,
    isReadonly,
} from 'vue';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    resolveWorkspaceMemoryPressureLevel,
    useWorkspaceMemoryPressureMonitor,
} from '@app/modules/workspace-shell/composables/useWorkspaceMemoryPressureMonitor';
import { resolveTabLifecycleStates } from '@app/modules/workspace-shell/tabs/resolveTabLifecycleStates';
import type { ISystemMemoryInfo } from '@contracts/systemPlatformFeature';
import type { IEditorPaneState } from '@contracts/editorPanes';
import { requirePaneId } from '@contracts/editorPanes';
import { requireTabId } from '@contracts/windowTabs';
import type { ITab } from '@app/types/tabs';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

const GIB = 1024 ** 3;

const mocks = vi.hoisted(() => ({
    getMemoryInfo: vi.fn<() => ISystemMemoryInfo | null>(),
    getSnapshot: vi.fn(() => ({
        maxBytes: 100,
        reservedBytes: 0,
    })),
    intervalCallbacks: [] as Array<() => void>,
    setPressureLevel: vi.fn(),
    useIntervalFn: vi.fn((callback: () => void) => {
        mocks.intervalCallbacks.push(callback);
    }),
}));

vi.mock('@vueuse/core', () => ({useIntervalFn: mocks.useIntervalFn}));
const platformApi = createElectronPlatformApiFixture({
    system: {getMemoryInfo: mocks.getMemoryInfo},
    host: {getResourceProfile: (() => ({
        logicalCpus: 8,
        performanceMode: 'auto',
        tier: 'high',
        totalRamBytes: 32 * 1024 ** 3,
    })) as never},
});
vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => platformApi}));
vi.mock('@app/utils/electronPlatformBridge', () => ({
    getRawElectronPlatformApi: () => platformApi,
    hasElectronPlatformBridge: () => true,
}));
vi.mock('@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController', () => (
    {workspaceSurfaceBudgetController: {
        getSnapshot: mocks.getSnapshot,
        setPressureLevel: mocks.setPressureLevel,
    }}
));

describe('workspace memory pressure monitor', () => {
    beforeEach(() => {
        mocks.getMemoryInfo.mockReturnValue({
            availableBytes: 16 * GIB,
            freeBytes: 16 * GIB,
            totalBytes: 32 * GIB,
        });
        mocks.getSnapshot.mockReturnValue({
            maxBytes: 100,
            reservedBytes: 0,
        });
        mocks.intervalCallbacks.length = 0;
        vi.clearAllMocks();
    });

    it.each([
        {
            source: 'healthy' as const,
            expected: 'none',
        },
        {
            source: 'guarded' as const,
            expected: 'moderate',
        },
        {
            source: 'moderate' as const,
            expected: 'moderate',
        },
        {
            source: 'critical' as const,
            expected: 'critical',
        },
        {
            source: 'emergency' as const,
            expected: 'critical',
        },
        {
            source: 'post-crash-safe-mode' as const,
            expected: 'critical',
        },
    ])('maps $source surface pressure to $expected lifecycle pressure', ({
        source,
        expected,
    }) => {
        expect(resolveWorkspaceMemoryPressureLevel(source)).toBe(expected);
    });

    it('exposes a readonly budget and recomputes it through one sampling interval', () => {
        const budget = useWorkspaceMemoryPressureMonitor();
        const tabs = [
            {id: 'active'},
            {id: 'inactive'},
            {id: 'visible-split'},
        ] satisfies ITab[];
        const panes = [
            {
                paneId: requirePaneId('pane'),
                activeTabId: requireTabId('active'),
                tabIds: [
                    requireTabId('active'),
                    requireTabId('inactive'),
                ],
            },
            {
                paneId: requirePaneId('split-pane'),
                activeTabId: requireTabId('visible-split'),
                tabIds: [requireTabId('visible-split')],
            },
        ] satisfies IEditorPaneState[];
        const lifecycleById = computed(() => Object.fromEntries(resolveTabLifecycleStates({
            activationOrder: [
                requireTabId('active'),
                requireTabId('inactive'),
                requireTabId('visible-split'),
            ],
            panes,
            policy: 'conservative',
            tabs,
            dirtyTabIds: new Set(),
            tier: budget.value.deviceTier,
            targetWarmViewers: budget.value.targetWarmViewers,
        }).map(state => [
            state.tabId,
            state,
        ])));

        expect(isReadonly(budget)).toBe(true);
        expect(budget.value.targetWarmViewers).toBe(5);
        expect(lifecycleById.value.inactive?.temperature).toBe('warm');
        expect(lifecycleById.value.active?.viewerResidency).toBe('active');
        expect(lifecycleById.value['visible-split']?.viewerResidency).toBe('active');
        expect(mocks.useIntervalFn).toHaveBeenCalledOnce();
        expect(mocks.intervalCallbacks).toHaveLength(1);

        mocks.getMemoryInfo.mockReturnValue({
            availableBytes: 512 * 1024 ** 2,
            freeBytes: 512 * 1024 ** 2,
            totalBytes: 32 * GIB,
        });
        mocks.intervalCallbacks[0]?.();

        expect(mocks.setPressureLevel).toHaveBeenLastCalledWith('emergency');
        expect(budget.value.targetWarmViewers).toBe(0);
        expect(lifecycleById.value.inactive?.temperature).toBe('cold');
        expect(lifecycleById.value.active).toMatchObject({
            shouldMountHost: true,
            temperature: 'hot',
            viewerResidency: 'active',
        });
        expect(lifecycleById.value['visible-split']).toMatchObject({
            shouldMountHost: true,
            temperature: 'hot',
            viewerResidency: 'active',
        });
    });
});
