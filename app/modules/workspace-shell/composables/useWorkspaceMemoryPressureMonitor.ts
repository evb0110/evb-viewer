import { useIntervalFn } from '@vueuse/core';
import { getSystemCapability } from '@app/utils/getSystemCapability';
import { resolveWorkspaceMemoryBudget } from '@app/modules/workspace-shell/memory/workspaceMemoryBudget';
import { resolveWorkspaceResourcePressureLevel } from '@app/modules/workspace-shell/memory/resolveWorkspaceResourcePressureLevel';
import {
    workspaceSurfaceBudgetController,
    type TWorkspaceResourcePressureLevel,
} from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';
import type { TMemoryPressureLevel } from '@app/modules/document-viewer/public';
import { resolvePerformanceProfile } from '@app/utils/performanceProfile';

const MEMORY_SAMPLE_INTERVAL_MS = 2_000;

export function resolveWorkspaceMemoryPressureLevel(
    level: TWorkspaceResourcePressureLevel,
): TMemoryPressureLevel {
    switch (level) {
        case 'healthy':
            return 'none';
        case 'guarded':
        case 'moderate':
            return 'moderate';
        case 'critical':
        case 'emergency':
        case 'post-crash-safe-mode':
            return 'critical';
    }
}

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
            surfaces: workspaceSurfaceBudgetController.getSnapshot(),
            systemFreeReserveBytes: baseBudget.systemFreeReserveBytes,
        });
        workspaceSurfaceBudgetController.setPressureLevel(pressureLevel);
        currentBudget.value = resolveWorkspaceMemoryBudget({
            environment,
            performanceProfile,
            pressure: {level: resolveWorkspaceMemoryPressureLevel(pressureLevel)},
        });
    };

    sample();
    useIntervalFn(sample, MEMORY_SAMPLE_INTERVAL_MS);
    return readonly(currentBudget);
};
