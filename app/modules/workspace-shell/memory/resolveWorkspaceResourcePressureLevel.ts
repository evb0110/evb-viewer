import type { ISystemMemoryInfo } from '@contracts/systemPlatformFeature';
import type { TMemoryPressureLevel } from '@app/modules/document-viewer/public';

export interface IWorkspaceMemoryPressureSample {
    memoryInfo: ISystemMemoryInfo | null;
    systemFreeReserveBytes: number;
}

/**
 * Pressure follows host memory only. The raster ledger's own fill level is not
 * an input: shrinking the budget on a full ledger evicted surfaces, the emptier
 * ledger then read as healthy, and the next sample refilled it.
 */
export function resolveWorkspaceResourcePressureLevel(
    sample: IWorkspaceMemoryPressureSample,
): TMemoryPressureLevel {
    if (!sample.memoryInfo || sample.systemFreeReserveBytes <= 0) {
        return 'none';
    }
    const availableRatio = sample.memoryInfo.availableBytes / sample.systemFreeReserveBytes;
    if (availableRatio <= 0.5) {
        return 'critical';
    }
    return availableRatio < 1 ? 'moderate' : 'none';
}
