import { resolveWorkspaceMemoryBudget } from '@app/modules/document-viewer/runtime/workspaceMemoryBudget';
import type { TMemoryPressureLevel } from '@app/utils/viewerResidencyPolicy';

export const RGBA_BYTES_PER_PIXEL = 4;

export type TWorkspaceSurfaceCategory =
    | 'pdf-page-canvas'
    | 'pdf-annotation-canvas'
    | 'pdf-thumbnail-canvas'
    | 'djvu-preview';

export interface IWorkspaceSurfaceLease {
    readonly bytes: number;
    readonly category: TWorkspaceSurfaceCategory;
    readonly scopeId: string;
    promotePriority?: (priority: number) => void;
    setPriority?: (priority: number) => void;
    resize: (bytes: number) => boolean;
    release: () => void;
}

export interface IWorkspaceSurfaceBudgetSnapshot {
    maxBytes: number;
    reservedBytes: number;
    reservedBytesByCategory: Readonly<Record<TWorkspaceSurfaceCategory, number>>;
    leaseCount: number;
    pressureLevel: TMemoryPressureLevel;
    effectiveMaxBytes: number;
}

export interface IWorkspaceSurfaceBudgetController {
    reserve: (options: {
        scopeId: string;
        category: TWorkspaceSurfaceCategory;
        bytes: number;
        evict?: (() => void) | undefined;
        canEvict?: (() => boolean) | undefined;
        priority?: number | undefined;
    }) => IWorkspaceSurfaceLease;
    tryReserve: (options: {
        scopeId: string;
        category: TWorkspaceSurfaceCategory;
        bytes: number;
        evict?: (() => void) | undefined;
        canEvict?: (() => boolean) | undefined;
        priority?: number | undefined;
    }) => IWorkspaceSurfaceLease | null;
    releaseScope: (scopeId: string) => void;
    enforceBudget: () => boolean;
    getSnapshot: () => IWorkspaceSurfaceBudgetSnapshot;
    setPressureLevel: (level: TMemoryPressureLevel) => void;
    setBudget: (budget: {maxBytes: number; pressureLevel: TMemoryPressureLevel}) => void;
}

const SURFACE_CATEGORIES: readonly TWorkspaceSurfaceCategory[] = [
    'pdf-page-canvas',
    'pdf-annotation-canvas',
    'pdf-thumbnail-canvas',
    'djvu-preview',
];

function normalizeSurfaceBytes(bytes: number) {
    return Number.isFinite(bytes) && bytes > 0 ? Math.ceil(bytes) : 0;
}

export function createWorkspaceSurfaceBudgetController(
    configuredMaxBytes?: number,
): IWorkspaceSurfaceBudgetController {
    // The module singleton is created at import time, before host memory is known;
    // the workspace memory monitor replaces this default through setBudget.
    let maxBytes = configuredMaxBytes;
    function getMaxBytes() {
        maxBytes ??= resolveWorkspaceMemoryBudget().maxRasterSurfaceBytes;
        return maxBytes;
    }
    interface ILeaseEntry {
        bytes: number;
        category: TWorkspaceSurfaceCategory;
        evict?: (() => void) | undefined;
        canEvict?: (() => boolean) | undefined;
        priority: number;
        sequence: number;
    }
    const leasesByScope = new Map<string, Set<ILeaseEntry>>();
    let reservedBytes = 0;
    let pressureLevel: TMemoryPressureLevel = 'none';
    let nextSequence = 0;

    const pressureBudgetScale: Record<TMemoryPressureLevel, number> = {
        none: 1,
        moderate: 0.75,
        critical: 0.5,
    };

    function getEffectiveMaxBytes() {
        return Math.floor(getMaxBytes() * pressureBudgetScale[pressureLevel]);
    }

    function getEvictionCandidates() {
        return [...leasesByScope.entries()]
            .flatMap(([
                scopeId,
                leases,
            ]) => [...leases].map(entry => ({
                scopeId,
                entry,
            })))
            .filter(({ entry }) => entry.evict && (entry.canEvict?.() ?? true))
            .sort((left, right) => left.entry.priority - right.entry.priority || left.entry.sequence - right.entry.sequence);
    }

    function evictToBudget() {
        const effectiveMaxBytes = getEffectiveMaxBytes();
        if (reservedBytes <= effectiveMaxBytes) {
            return;
        }
        const candidates = getEvictionCandidates();
        for (const {
            scopeId,
            entry,
        } of candidates) {
            if (reservedBytes <= effectiveMaxBytes) {
                break;
            }
            const leases = leasesByScope.get(scopeId);
            if (!leases?.delete(entry)) {
                continue;
            }
            reservedBytes -= entry.bytes;
            if (leases.size === 0) {
                leasesByScope.delete(scopeId);
            }
            entry.evict?.();
        }
    }

    /**
     * A lease keeps the admission rule it was created under. A required lease
     * (`reserve`) is admitted over the cap, so its growth is bounded by its own
     * size: the other required surfaces that hold the ledger above the cap are
     * not its to evict. A provisional lease (`tryReserve`) grows only into room
     * that exists or can be reclaimed.
     */
    function admit(options: Parameters<IWorkspaceSurfaceBudgetController['reserve']>[0], required: boolean): IWorkspaceSurfaceLease {
        const entry = {
            bytes: normalizeSurfaceBytes(options.bytes),
            category: options.category,
            evict: options.evict,
            canEvict: options.canEvict,
            priority: Number.isFinite(options.priority) ? options.priority ?? 0 : 0,
            sequence: nextSequence++,
        };
        const scopeLeases = leasesByScope.get(options.scopeId) ?? new Set();
        scopeLeases.add(entry);
        leasesByScope.set(options.scopeId, scopeLeases);
        reservedBytes += entry.bytes;
        let released = false;

        evictToBudget();

        return {
            get bytes() {return entry.bytes;},
            category: entry.category,
            scopeId: options.scopeId,
            promotePriority(priority) {
                if (released || !Number.isFinite(priority)) {
                    return;
                }
                entry.priority = Math.max(entry.priority, priority);
            },
            setPriority(priority) {
                if (released || !Number.isFinite(priority)) {
                    return;
                }
                entry.priority = priority;
            },
            resize(bytes) {
                if (released || !scopeLeases.has(entry)) return false;
                const nextBytes = normalizeSurfaceBytes(bytes);
                const increase = nextBytes - entry.bytes;
                const admittedBytes = required
                    ? nextBytes
                    : reservedBytes + increase - getEvictionCandidates()
                        .filter(candidate => candidate.entry !== entry)
                        .reduce((sum, candidate) => sum + candidate.entry.bytes, 0);
                if (increase > 0 && admittedBytes > getEffectiveMaxBytes()) return false;
                reservedBytes += increase;
                entry.bytes = nextBytes;
                evictToBudget();
                return scopeLeases.has(entry) && (required || increase <= 0 || reservedBytes <= getEffectiveMaxBytes());
            },
            release() {
                if (released) {
                    return;
                }
                released = true;
                if (scopeLeases.delete(entry)) {
                    reservedBytes -= entry.bytes;
                }
                if (scopeLeases.size === 0) {
                    leasesByScope.delete(options.scopeId);
                }
            },
        };
    }

    function releaseScope(scopeId: string) {
        const leases = leasesByScope.get(scopeId);
        if (!leases) {
            return;
        }
        for (const lease of leases) {
            reservedBytes -= lease.bytes;
        }
        leases.clear();
        leasesByScope.delete(scopeId);
    }

    function getSnapshot(): IWorkspaceSurfaceBudgetSnapshot {
        const reservedBytesByCategory = Object.fromEntries(
            SURFACE_CATEGORIES.map(category => [
                category,
                0,
            ]),
        ) as Record<TWorkspaceSurfaceCategory, number>;
        let leaseCount = 0;
        for (const leases of leasesByScope.values()) {
            for (const lease of leases) {
                reservedBytesByCategory[lease.category] += lease.bytes;
                leaseCount += 1;
            }
        }
        return {
            maxBytes: getMaxBytes(),
            effectiveMaxBytes: getEffectiveMaxBytes(),
            reservedBytes,
            reservedBytesByCategory,
            leaseCount,
            pressureLevel,
        };
    }

    function setPressureLevel(level: TMemoryPressureLevel) {
        pressureLevel = level;
        evictToBudget();
    }

    // One eviction pass against the final cap: applying the cap and the level
    // separately would evict against whichever intermediate product is lower.
    function setBudget(budget: {maxBytes: number; pressureLevel: TMemoryPressureLevel}) {
        maxBytes = normalizeSurfaceBytes(budget.maxBytes);
        pressureLevel = budget.pressureLevel;
        evictToBudget();
    }

    return {
        reserve: options => admit(options, true),
        tryReserve(options) {
            const requestedBytes = normalizeSurfaceBytes(options.bytes);
            const bytesToReclaim = Math.max(
                0,
                reservedBytes + requestedBytes - getEffectiveMaxBytes(),
            );
            if (bytesToReclaim > 0) {
                let reclaimableBytes = 0;
                for (const { entry } of getEvictionCandidates()) {
                    reclaimableBytes += entry.bytes;
                    if (reclaimableBytes >= bytesToReclaim) {
                        break;
                    }
                }
                if (reclaimableBytes < bytesToReclaim) {
                    return null;
                }
            }
            const lease = admit(options, false);
            if (reservedBytes <= getEffectiveMaxBytes()) {
                return lease;
            }
            lease.release();
            return null;
        },
        releaseScope,
        enforceBudget() {
            evictToBudget();
            return reservedBytes <= getEffectiveMaxBytes();
        },
        getSnapshot,
        setPressureLevel,
        setBudget,
    };
}

export const workspaceSurfaceBudgetController = createWorkspaceSurfaceBudgetController();
