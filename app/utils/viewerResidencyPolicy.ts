export type TMemoryPressureLevel = 'none' | 'moderate' | 'critical';
export type TViewerResidencyState = 'active' | 'warm' | 'hibernating' | 'hibernated';

export interface IRuntimeMemoryPressureSignal {
    level?: TMemoryPressureLevel | undefined;
    usedBytes?: number | undefined;
    limitBytes?: number | undefined;
    reclaimTargetBytes?: number | undefined;
}

export interface IResolveInactiveViewerResidencyStateOptions {
    previousState?: TViewerResidencyState | undefined;
    canReclaimNow: boolean;
    hasReclaimableState: boolean;
}

export interface IViewerReclaimCandidate {
    viewerId: string;
    residencyState: TViewerResidencyState;
    isActive: boolean;
    canReclaim: boolean;
    lastActiveAt: number;
    estimatedBytes?: number | undefined;
}

export interface ISelectViewerReclaimCandidatesOptions {
    pressure?: IRuntimeMemoryPressureSignal | undefined;
    budgetOverflowBytes?: number | undefined;
    minimumCandidates?: number | undefined;
    maxCandidates?: number | undefined;
    protectedViewerIds?: readonly string[] | undefined;
}

const RESIDENCY_RECLAIM_PRIORITY: Record<TViewerResidencyState, number> = {
    hibernating: 0,
    warm: 1,
    hibernated: 2,
    active: 3,
};

function normalizeNonNegative(value: number | undefined) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : 0;
}

function normalizeSortableTimestamp(value: number) {
    return Number.isFinite(value)
        ? value
        : Number.MAX_SAFE_INTEGER;
}

function normalizePositiveInteger(value: number | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return null;
    }

    return Math.max(1, Math.trunc(value));
}

export function normalizeMemoryPressureLevel(level: TMemoryPressureLevel | undefined) {
    return level ?? 'none';
}

export function resolveInactiveViewerResidencyState(
    options: IResolveInactiveViewerResidencyStateOptions,
) {
    if (!options.canReclaimNow) {
        return options.previousState === 'hibernated'
            ? 'hibernated'
            : 'warm';
    }

    return options.hasReclaimableState ? 'hibernating' : 'hibernated';
}

export function resolvePostReclaimResidencyState(state: TViewerResidencyState) {
    return state === 'hibernating' ? 'hibernated' : state;
}

export function shouldReclaimViewerResidencyState(state: TViewerResidencyState) {
    return state === 'hibernating';
}

function isViewerReclaimCandidate(candidate: IViewerReclaimCandidate) {
    return !candidate.isActive
        && candidate.residencyState !== 'active'
        && candidate.canReclaim;
}

function compareViewerReclaimCandidates(
    left: IViewerReclaimCandidate,
    right: IViewerReclaimCandidate,
) {
    const statePriority = RESIDENCY_RECLAIM_PRIORITY[left.residencyState]
        - RESIDENCY_RECLAIM_PRIORITY[right.residencyState];
    if (statePriority !== 0) {
        return statePriority;
    }

    const lastActiveDelta = normalizeSortableTimestamp(left.lastActiveAt)
        - normalizeSortableTimestamp(right.lastActiveAt);
    if (lastActiveDelta !== 0) {
        return lastActiveDelta;
    }

    const estimatedBytesDelta = normalizeNonNegative(right.estimatedBytes)
        - normalizeNonNegative(left.estimatedBytes);
    if (estimatedBytesDelta !== 0) {
        return estimatedBytesDelta;
    }

    return left.viewerId.localeCompare(right.viewerId);
}

function rankViewerReclaimCandidates(
    candidates: readonly IViewerReclaimCandidate[],
) {
    return candidates
        .filter(isViewerReclaimCandidate)
        .toSorted(compareViewerReclaimCandidates);
}

export function selectViewerReclaimCandidates(
    candidates: readonly IViewerReclaimCandidate[],
    options: ISelectViewerReclaimCandidatesOptions = {},
) {
    const pressureLevel = normalizeMemoryPressureLevel(options.pressure?.level);
    const budgetOverflowBytes = normalizeNonNegative(options.budgetOverflowBytes);
    const minimumCandidates = Math.max(
        0,
        Math.trunc(options.minimumCandidates ?? (pressureLevel === 'critical' ? 1 : 0)),
    );
    const maxCandidates = normalizePositiveInteger(options.maxCandidates);
    const protectedViewerIds = new Set(options.protectedViewerIds ?? []);

    if (pressureLevel === 'none' && budgetOverflowBytes === 0 && minimumCandidates === 0) {
        return [];
    }

    const selected: IViewerReclaimCandidate[] = [];
    let selectedBytes = 0;

    for (const candidate of rankViewerReclaimCandidates(candidates)) {
        if (protectedViewerIds.has(candidate.viewerId)) {
            continue;
        }

        const needsMoreCandidates = selected.length < minimumCandidates;
        const needsMoreBytes = budgetOverflowBytes > 0 && selectedBytes < budgetOverflowBytes;
        if (!needsMoreCandidates && !needsMoreBytes) {
            break;
        }

        selected.push(candidate);
        selectedBytes += normalizeNonNegative(candidate.estimatedBytes);

        if (maxCandidates !== null && selected.length >= maxCandidates) {
            break;
        }
    }

    return selected;
}
