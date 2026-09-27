import type { ISystemMemoryInfo } from '@contracts/systemPlatformFeature';
import type {
    IWorkspaceSurfaceBudgetSnapshot,
    TWorkspaceResourcePressureLevel,
} from '@app/modules/document-viewer/public';

export interface IWorkspaceMemoryPressureSample {
    memoryInfo: ISystemMemoryInfo | null;
    surfaces: Pick<IWorkspaceSurfaceBudgetSnapshot, 'maxBytes' | 'reservedBytes'>;
    systemFreeReserveBytes: number;
    postCrashSafeMode?: boolean | undefined;
}

export function resolveWorkspaceResourcePressureLevel(
    sample: IWorkspaceMemoryPressureSample,
): TWorkspaceResourcePressureLevel {
    if (sample.postCrashSafeMode) {
        return 'post-crash-safe-mode';
    }
    const reservationRatio = sample.surfaces.maxBytes > 0
        ? sample.surfaces.reservedBytes / sample.surfaces.maxBytes
        : 0;
    const availableRatio = sample.memoryInfo && sample.systemFreeReserveBytes > 0
        ? sample.memoryInfo.availableBytes / sample.systemFreeReserveBytes
        : Number.POSITIVE_INFINITY;

    if (availableRatio <= 0.25 || reservationRatio >= 1.2) {
        return 'emergency';
    }
    if (availableRatio <= 0.5 || reservationRatio >= 1) {
        return 'critical';
    }
    if (availableRatio <= 0.75 || reservationRatio >= 0.9) {
        return 'moderate';
    }
    if (availableRatio < 1 || reservationRatio >= 0.75) {
        return 'guarded';
    }
    return 'healthy';
}
