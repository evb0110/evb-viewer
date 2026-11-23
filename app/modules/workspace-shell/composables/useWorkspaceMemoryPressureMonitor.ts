import { useIntervalFn } from '@vueuse/core';
import { getSystemCapability } from '@app/utils/getSystemCapability';
import {
    resolveWorkspaceMemoryBudget,
    workspaceSurfaceBudgetController,
} from '@app/modules/document-viewer/public';
import { resolveWorkspaceResourcePressureLevel } from '@app/modules/workspace-shell/memory/resolveWorkspaceResourcePressureLevel';
import { resolvePerformanceProfile } from '@app/utils/performanceProfile';

const MEMORY_SAMPLE_INTERVAL_MS = 2_000;

/** Keeps the renderer raster ledger aligned with live host memory headroom. */
export const useWorkspaceMemoryPressureMonitor = () => {
    const performanceProfile = resolvePerformanceProfile();
    const currentBudget = shallowRef(resolveWorkspaceMemoryBudget({performanceProfile}));

    const sample = () => {
        const memoryInfo = getSystemCapability().getMemoryInfo();
        const environment = memoryInfo ? { totalMemoryBytes: memoryInfo.totalBytes } : undefined;
        const baseBudget = resolveWorkspaceMemoryBudget({
            environment,
            performanceProfile,
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
        });
    };

    sample();
    useIntervalFn(sample, MEMORY_SAMPLE_INTERVAL_MS);
    return readonly(currentBudget);
};
