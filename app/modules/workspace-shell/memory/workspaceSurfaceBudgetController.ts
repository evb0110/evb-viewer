import { resolveWorkspaceMemoryBudget } from '@app/modules/workspace-shell/memory/workspaceMemoryBudget';
import { registerWorkspaceSurfaceBudgetPort } from '@app/utils/workspaceSurfaceBudgetPort';

export type TWorkspaceSurfaceCategory =
    | 'pdf-page-canvas'
    | 'pdf-annotation-canvas'
    | 'pdf-thumbnail-canvas'
    | 'native-preview'
    | 'djvu-preview';

export type TWorkspaceResourcePressureLevel =
    | 'healthy'
    | 'guarded'
    | 'moderate'
    | 'critical'
    | 'emergency'
    | 'post-crash-safe-mode';

export interface IWorkspaceSurfaceLease {
    readonly bytes: number;
    readonly category: TWorkspaceSurfaceCategory;
    readonly scopeId: string;
    promotePriority?: (priority: number) => void;
    setPriority?: (priority: number) => void;
    release: () => void;
}

export interface IWorkspaceSurfaceBudgetSnapshot {
    maxBytes: number;
    reservedBytes: number;
    reservedBytesByCategory: Readonly<Record<TWorkspaceSurfaceCategory, number>>;
    leaseCount: number;
    pressureLevel: TWorkspaceResourcePressureLevel;
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
    setPressureLevel: (level: TWorkspaceResourcePressureLevel) => void;
}

const SURFACE_CATEGORIES: readonly TWorkspaceSurfaceCategory[] = [
    'pdf-page-canvas',
    'pdf-annotation-canvas',
    'pdf-thumbnail-canvas',
    'native-preview',
    'djvu-preview',
];

function normalizeSurfaceBytes(bytes: number) {
    return Number.isFinite(bytes) && bytes > 0 ? Math.ceil(bytes) : 0;
}

export function estimateCanvasSurfaceBytes(canvas: Pick<HTMLCanvasElement, 'width' | 'height'>) {
    return normalizeSurfaceBytes(canvas.width * canvas.height * 4);
}

export function createWorkspaceSurfaceBudgetController(
    configuredMaxBytes?: number,
): IWorkspaceSurfaceBudgetController {
    // The module singleton is created at import time, before the platform bridge exists.
    let resolvedMaxBytes = configuredMaxBytes;
    function getMaxBytes() {
        resolvedMaxBytes ??= resolveWorkspaceMemoryBudget().maxRasterSurfaceBytes;
        return resolvedMaxBytes;
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
    let pressureLevel: TWorkspaceResourcePressureLevel = 'healthy';
    let nextSequence = 0;

    const pressureBudgetScale: Record<TWorkspaceResourcePressureLevel, number> = {
        healthy: 1,
        guarded: 0.9,
        moderate: 0.75,
        critical: 0.5,
        emergency: 0.25,
        'post-crash-safe-mode': 0.2,
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

    function reserve(options: {
        scopeId: string;
        category: TWorkspaceSurfaceCategory;
        bytes: number;
        evict?: (() => void) | undefined;
        canEvict?: (() => boolean) | undefined;
        priority?: number | undefined;
    }): IWorkspaceSurfaceLease {
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
            bytes: entry.bytes,
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

    function setPressureLevel(level: TWorkspaceResourcePressureLevel) {
        pressureLevel = level;
        evictToBudget();
    }

    return {
        reserve,
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
            const lease = reserve(options);
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
    };
}

export const workspaceSurfaceBudgetController = createWorkspaceSurfaceBudgetController();
registerWorkspaceSurfaceBudgetPort(workspaceSurfaceBudgetController);
