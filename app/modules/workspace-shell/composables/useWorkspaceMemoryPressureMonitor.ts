import {
    getCurrentScope,
    onScopeDispose,
} from 'vue';
import { useIntervalFn } from '@vueuse/core';
import type { IHostRasterBudgetSnapshot } from '@contracts/hostPlatformFeature';
import { guardAsync } from '@app/utils/asyncGuard';
import { getHostCapability } from '@app/utils/getHostCapability';
import { getSystemCapability } from '@app/utils/getSystemCapability';
import {
    resolveWorkspaceMemoryBudget,
    workspaceSurfaceBudgetController,
} from '@app/modules/document-viewer/public';
import { resolveWorkspaceResourcePressureLevel } from '@app/modules/workspace-shell/memory/resolveWorkspaceResourcePressureLevel';
import { resolvePerformanceProfile } from '@app/utils/performanceProfile';

const MEMORY_SAMPLE_INTERVAL_MS = 2_000;

/** Keeps the renderer raster ledger aligned with live host memory headroom and per-window share. */
export const useWorkspaceMemoryPressureMonitor = () => {
    const performanceProfile = resolvePerformanceProfile();
    const currentBudget = shallowRef(resolveWorkspaceMemoryBudget({performanceProfile}));
    let hostRasterSurfaceBytes: number | undefined;
    let receivedLiveRasterBudgetEvent = false;
    let disposed = false;

    const sample = () => {
        const memoryInfo = getSystemCapability().getMemoryInfo();
        const environment = memoryInfo ? { totalMemoryBytes: memoryInfo.totalBytes } : undefined;
        const baseBudget = resolveWorkspaceMemoryBudget({
            environment,
            performanceProfile,
            hostRasterSurfaceBytes,
        });
        const pressureLevel = resolveWorkspaceResourcePressureLevel({
            memoryInfo,
            systemFreeReserveBytes: baseBudget.systemFreeReserveBytes,
        });
        workspaceSurfaceBudgetController.setBudget({
            maxBytes: baseBudget.maxRasterSurfaceBytes,
            pressureLevel,
        });
        currentBudget.value = resolveWorkspaceMemoryBudget({
            environment,
            performanceProfile,
            pressure: {level: pressureLevel},
            hostRasterSurfaceBytes,
        });
    };

    const applyHostRasterBudget = (snapshot: IHostRasterBudgetSnapshot | null) => {
        if (disposed || !snapshot) {
            return false;
        }
        const nextBytes = snapshot.maxRasterSurfaceBytes;
        if (typeof nextBytes !== 'number' || !Number.isFinite(nextBytes) || nextBytes <= 0) {
            return false;
        }
        if (hostRasterSurfaceBytes !== nextBytes) {
            hostRasterSurfaceBytes = nextBytes;
            sample();
        }
        return true;
    };

    sample();
    const host = getHostCapability();
    const unsubscribeRasterBudget = host.onRasterBudgetChange((snapshot) => {
        if (applyHostRasterBudget(snapshot)) {
            receivedLiveRasterBudgetEvent = true;
        }
    });
    guardAsync(
        host.getRasterBudget().then((snapshot) => {
            if (!receivedLiveRasterBudgetEvent) {
                applyHostRasterBudget(snapshot);
            }
        }),
        {
            category: 'background-diagnostic',
            scope: 'workspace-memory',
            message: 'Failed to read host raster budget',
        },
    );
    if (getCurrentScope()) {
        onScopeDispose(() => {
            disposed = true;
            unsubscribeRasterBudget();
        });
    }
    useIntervalFn(sample, MEMORY_SAMPLE_INTERVAL_MS);
    return readonly(currentBudget);
};
