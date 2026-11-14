import {
    resolvePerformanceProfile,
    type IPerformanceProfile,
    type IPerformanceProfileEnvironment,
} from '@app/utils/performanceProfile';
import type { THostResourceTier } from '@contracts/hostResourceProfile';
import {
    normalizeMemoryPressureLevel,
    type IRuntimeMemoryPressureSignal,
    type TMemoryPressureLevel,
} from '@app/utils/viewerResidencyPolicy';

const MIB = 1024 ** 2;

interface IWorkspaceMemoryBudgetBase {
    maxWarmViewers: number;
    maxEstimatedWorkspaceBytes: number;
    reclaimTargetBytes: number;
}

const RASTER_BUDGET_MIN_BYTES = 128 * MIB;
const RASTER_BUDGET_MAX_BYTES = 1536 * MIB;
const SYSTEM_FREE_RESERVE_MIN_BYTES = 1024 * MIB;
const SYSTEM_FREE_RESERVE_MAX_BYTES = 4096 * MIB;

export interface IResolveWorkspaceMemoryBudgetOptions {
    environment?: IPerformanceProfileEnvironment | undefined;
    performanceProfile?: IPerformanceProfile | undefined;
    pressure?: IRuntimeMemoryPressureSignal | undefined;
}

export interface IWorkspaceMemoryBudget {
    deviceTier: THostResourceTier;
    pressureLevel: TMemoryPressureLevel;
    maxWarmViewers: number;
    targetWarmViewers: number;
    maxCachedPdfPagesPerViewer: number;
    maxEstimatedWorkspaceBytes: number;
    maxRasterSurfaceBytes: number;
    systemFreeReserveBytes: number;
    reclaimTargetBytes: number;
}

const BASE_BUDGETS: Record<THostResourceTier, IWorkspaceMemoryBudgetBase> = {
    low: {
        maxWarmViewers: 2,
        maxEstimatedWorkspaceBytes: 768 * MIB,
        reclaimTargetBytes: 128 * MIB,
    },
    medium: {
        maxWarmViewers: 3,
        maxEstimatedWorkspaceBytes: 1536 * MIB,
        reclaimTargetBytes: 256 * MIB,
    },
    high: {
        maxWarmViewers: 5,
        maxEstimatedWorkspaceBytes: 3072 * MIB,
        reclaimTargetBytes: 512 * MIB,
    },
};

function resolvePressureAdjustedWarmViewers(baseWarmViewers: number, pressureLevel: TMemoryPressureLevel) {
    if (pressureLevel === 'critical') {
        return 0;
    }

    if (pressureLevel === 'moderate') {
        return Math.max(0, baseWarmViewers - 1);
    }

    return baseWarmViewers;
}

function clamp(value: number, minimum: number, maximum: number) {
    return Math.min(maximum, Math.max(minimum, value));
}

function resolveTotalMemoryBytes(options: IResolveWorkspaceMemoryBudgetOptions) {
    const totalMemoryBytes = options.environment?.totalMemoryBytes;
    return typeof totalMemoryBytes === 'number' && Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0
        ? totalMemoryBytes
        : null;
}

export function resolveWorkspaceMemoryDeviceTier(
    performanceProfile: IPerformanceProfile,
): THostResourceTier {
    return performanceProfile.tier;
}

export function resolveWorkspaceMemoryBudget(
    options: IResolveWorkspaceMemoryBudgetOptions = {},
): IWorkspaceMemoryBudget {
    const performanceProfile = options.performanceProfile ?? resolvePerformanceProfile(options.environment);
    const deviceTier = resolveWorkspaceMemoryDeviceTier(performanceProfile);
    const pressureLevel = normalizeMemoryPressureLevel(options.pressure?.level);
    const base = BASE_BUDGETS[deviceTier];
    const totalMemoryBytes = resolveTotalMemoryBytes(options);
    const maxWarmViewers = resolvePressureAdjustedWarmViewers(base.maxWarmViewers, pressureLevel);

    return {
        deviceTier,
        pressureLevel,
        maxWarmViewers,
        targetWarmViewers: maxWarmViewers,
        maxCachedPdfPagesPerViewer: performanceProfile.maxCachedPdfPages,
        maxEstimatedWorkspaceBytes: base.maxEstimatedWorkspaceBytes,
        maxRasterSurfaceBytes: totalMemoryBytes === null
            ? Math.min(base.maxEstimatedWorkspaceBytes, RASTER_BUDGET_MAX_BYTES)
            : clamp(totalMemoryBytes * 0.06, RASTER_BUDGET_MIN_BYTES, RASTER_BUDGET_MAX_BYTES),
        systemFreeReserveBytes: totalMemoryBytes === null
            ? SYSTEM_FREE_RESERVE_MIN_BYTES
            : clamp(totalMemoryBytes * 0.15, SYSTEM_FREE_RESERVE_MIN_BYTES, SYSTEM_FREE_RESERVE_MAX_BYTES),
        reclaimTargetBytes: pressureLevel === 'critical'
            ? base.reclaimTargetBytes * 2
            : base.reclaimTargetBytes,
    };
}
