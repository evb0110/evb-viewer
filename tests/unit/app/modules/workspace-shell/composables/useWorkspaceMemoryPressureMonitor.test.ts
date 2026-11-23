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
import { resolveTabLifecycleStates } from '@app/modules/workspace-shell/tabs/resolveTabLifecycleStates';
import type { IHostResourceProfileSnapshot } from '@contracts/hostResourceProfile';
import type { ISystemMemoryInfo } from '@contracts/systemPlatformFeature';
import type { IEditorPaneState } from '@contracts/editorPanes';
import { requirePaneId } from '@contracts/editorPanes';
import { requireTabId } from '@contracts/windowTabs';
import type { ITab } from '@app/types/tabs';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const mocks = vi.hoisted(() => ({
    getMemoryInfo: vi.fn<() => ISystemMemoryInfo | null>(),
    getResourceProfile: vi.fn<() => Partial<IHostResourceProfileSnapshot>>(),
    intervalCallbacks: [] as Array<() => void>,
    useIntervalFn: vi.fn((callback: () => void) => {
        mocks.intervalCallbacks.push(callback);
    }),
}));

vi.mock('@vueuse/core', () => ({useIntervalFn: mocks.useIntervalFn}));
const platformApi = createElectronPlatformApiFixture({
    system: {getMemoryInfo: mocks.getMemoryInfo},
    host: {getResourceProfile: mocks.getResourceProfile as never},
});
vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => platformApi}));
vi.mock('@app/utils/electronPlatformBridge', () => ({
    getRawElectronPlatformApi: () => platformApi,
    hasElectronPlatformBridge: () => true,
}));

function useHost(totalBytes: number, availableBytes: number, logicalCpus: number, tier: IHostResourceProfileSnapshot['tier']) {
    mocks.getResourceProfile.mockReturnValue({
        logicalCpus,
        performanceMode: 'auto',
        tier,
        totalRamBytes: totalBytes,
    });
    mocks.getMemoryInfo.mockReturnValue({
        availableBytes,
        freeBytes: availableBytes,
        totalBytes,
    });
}

// Each test gets a fresh controller singleton, as each app start does.
async function loadMonitor() {
    const [
        {useWorkspaceMemoryPressureMonitor},
        {workspaceSurfaceBudgetController},
    ] = await Promise.all([
        import('@app/modules/workspace-shell/composables/useWorkspaceMemoryPressureMonitor'),
        import('@app/modules/document-viewer/runtime/workspaceSurfaceBudgetController'),
    ]);
    return {
        controller: workspaceSurfaceBudgetController,
        useWorkspaceMemoryPressureMonitor,
        runInterval: () => mocks.intervalCallbacks.at(-1)?.(),
    };
}

describe('workspace memory pressure monitor', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.intervalCallbacks.length = 0;
        useHost(32 * GIB, 16 * GIB, 8, 'high');
    });

    it('replaces the import-time raster cap with the cap derived from host RAM', async () => {
        useHost(4 * GIB, 2 * GIB, 4, 'low');
        const {
            controller,
            useWorkspaceMemoryPressureMonitor,
        } = await loadMonitor();
        expect(controller.getSnapshot().maxBytes).toBe(768 * MIB);

        useWorkspaceMemoryPressureMonitor();

        expect(controller.getSnapshot().maxBytes).toBe(Math.ceil(4 * GIB * 0.06));
        expect(controller.getSnapshot().maxBytes).toBeLessThan(246 * MIB);
    });

    it('keeps the 1.5 GiB raster cap on a 32 GiB workstation', async () => {
        const {
            controller,
            useWorkspaceMemoryPressureMonitor,
        } = await loadMonitor();

        useWorkspaceMemoryPressureMonitor();

        expect(controller.getSnapshot()).toMatchObject({
            maxBytes: 1536 * MIB,
            effectiveMaxBytes: 1536 * MIB,
            pressureLevel: 'none',
        });
    });

    it('keeps a nearly full raster ledger resident while host memory is healthy', async () => {
        const {
            controller,
            useWorkspaceMemoryPressureMonitor,
            runInterval,
        } = await loadMonitor();
        useWorkspaceMemoryPressureMonitor();
        const evict = vi.fn();
        const reservedBytes = Math.floor(controller.getSnapshot().maxBytes * 0.95);
        controller.reserve({
            scopeId: 'nearby-pages',
            category: 'pdf-page-canvas',
            bytes: reservedBytes,
            evict,
        });

        for (let sample = 0; sample < 5; sample += 1) {
            runInterval();
            expect(controller.getSnapshot()).toMatchObject({
                pressureLevel: 'none',
                reservedBytes,
            });
        }
        expect(evict).not.toHaveBeenCalled();
    });

    it('keeps a lease that fits the final budget when the cap rises and pressure tightens in one sample', async () => {
        mocks.getResourceProfile.mockReturnValue({
            logicalCpus: 8,
            performanceMode: 'low',
            tier: 'low',
            totalRamBytes: 32 * GIB,
        });
        mocks.getMemoryInfo.mockReturnValue(null);
        const {
            controller,
            useWorkspaceMemoryPressureMonitor,
            runInterval,
        } = await loadMonitor();
        useWorkspaceMemoryPressureMonitor();
        expect(controller.getSnapshot()).toMatchObject({
            maxBytes: 768 * MIB,
            pressureLevel: 'none',
        });
        const evict = vi.fn();
        controller.reserve({
            scopeId: 'nearby-pages',
            category: 'pdf-page-canvas',
            bytes: 700 * MIB,
            evict,
        });

        mocks.getMemoryInfo.mockReturnValue({
            availableBytes: 3 * GIB,
            freeBytes: 3 * GIB,
            totalBytes: 32 * GIB,
        });
        runInterval();

        expect(controller.getSnapshot()).toMatchObject({
            maxBytes: 1536 * MIB,
            effectiveMaxBytes: 1152 * MIB,
            pressureLevel: 'moderate',
            reservedBytes: 700 * MIB,
        });
        expect(evict).not.toHaveBeenCalled();
    });

    it('tightens and relaxes the raster budget as host memory falls and recovers', async () => {
        const {
            controller,
            useWorkspaceMemoryPressureMonitor,
            runInterval,
        } = await loadMonitor();
        useWorkspaceMemoryPressureMonitor();
        const levels = [
            3 * GIB,
            1 * GIB,
            8 * GIB,
        ].map((availableBytes) => {
            useHost(32 * GIB, availableBytes, 8, 'high');
            runInterval();
            const snapshot = controller.getSnapshot();
            return [
                snapshot.pressureLevel,
                snapshot.effectiveMaxBytes / snapshot.maxBytes,
            ];
        });

        expect(levels).toEqual([
            [
                'moderate',
                0.75,
            ],
            [
                'critical',
                0.5,
            ],
            [
                'none',
                1,
            ],
        ]);
    });

    it('exposes a readonly budget and recomputes it through one sampling interval', async () => {
        const {
            controller,
            useWorkspaceMemoryPressureMonitor,
            runInterval,
        } = await loadMonitor();
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
            documentTabIds: new Set([
                'active',
                'warm',
                'cold',
            ]),
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

        useHost(32 * GIB, 512 * MIB, 8, 'high');
        runInterval();

        expect(controller.getSnapshot().pressureLevel).toBe('critical');
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
