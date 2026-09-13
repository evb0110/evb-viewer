import {
    resolvePerformanceProfile,
    type IPerformanceProfile,
    type IPerformanceProfileEnvironment,
} from '@app/utils/performanceProfile';
import type { THostResourceTier } from '@contracts/hostResourceProfile';
import {
    normalizeMemoryPressureLevel,
    selectViewerReclaimCandidates,
    type IRuntimeMemoryPressureSignal,
    type IViewerReclaimCandidate,
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

export interface IResolveWorkspaceMemoryReclaimPlanOptions {
    budget: IWorkspaceMemoryBudget;
    viewers: readonly IViewerReclaimCandidate[];
    protectedViewerIds?: readonly string[] | undefined;
}

export interface IWorkspaceMemoryReclaimPlan {
    totalEstimatedBytes: number;
    warmViewerCount: number;
    overBudgetBytes: number;
    overWarmViewerCount: number;
    candidates: IViewerReclaimCandidate[];
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

function sumEstimatedBytes(viewers: readonly IViewerReclaimCandidate[]) {
    return viewers.reduce((total, viewer) => {
        const estimatedBytes = typeof viewer.estimatedBytes === 'number' && Number.isFinite(viewer.estimatedBytes)
            ? Math.max(0, viewer.estimatedBytes)
            : 0;
        return total + estimatedBytes;
    }, 0);
}

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

export function resolveWorkspaceMemoryReclaimPlan(
    options: IResolveWorkspaceMemoryReclaimPlanOptions,
): IWorkspaceMemoryReclaimPlan {
    const totalEstimatedBytes = sumEstimatedBytes(options.viewers);
    const warmViewerCount = options.viewers.filter(viewer => viewer.residencyState === 'warm' && !viewer.isActive).length;
    const overBudgetBytes = Math.max(0, totalEstimatedBytes - options.budget.maxEstimatedWorkspaceBytes);
    const overWarmViewerCount = Math.max(0, warmViewerCount - options.budget.targetWarmViewers);
    const pressureMinimum = options.budget.pressureLevel === 'none' ? 0 : 1;
    const minimumCandidates = Math.max(overWarmViewerCount, pressureMinimum);
    const budgetOverflowBytes = overBudgetBytes > 0
        ? overBudgetBytes + options.budget.reclaimTargetBytes
        : options.budget.pressureLevel === 'critical'
            ? options.budget.reclaimTargetBytes
            : 0;

    return {
        totalEstimatedBytes,
        warmViewerCount,
        overBudgetBytes,
        overWarmViewerCount,
        candidates: selectViewerReclaimCandidates(options.viewers, {
            pressure: { level: options.budget.pressureLevel },
            minimumCandidates,
            budgetOverflowBytes,
            protectedViewerIds: options.protectedViewerIds,
        }),
    };
}
