import { isRecord } from '@contracts/runtimeGuards';

export type THostResourceTier = 'low' | 'medium' | 'high';
export type TDocumentSavePerformanceTier = 'low' | 'balanced' | 'high';
export type TPerformanceMode = 'auto' | THostResourceTier;

export interface IHostGpuStatusSnapshot {readonly [featureName: string]: string;}

const CANVAS_GPU_FEATURES = [
    '2d_canvas',
    'gpu_compositing',
    'rasterization',
] as const;

export function usesSoftwareCanvasRendering(gpuStatus?: IHostGpuStatusSnapshot) {
    return CANVAS_GPU_FEATURES.some(feature => gpuStatus?.[feature]?.includes('software') === true);
}

export interface IHostResourceProfileSnapshot {
    readonly logicalCpus: number;
    readonly totalRamBytes: number;
    readonly safeMode: boolean;
    readonly gpuStatus?: IHostGpuStatusSnapshot;
    readonly detectedTier: THostResourceTier;
    readonly performanceMode: TPerformanceMode;
    readonly tier: THostResourceTier;
}

export interface IHostResourceTierInputs {
    logicalCpus: number;
    totalRamBytes: number;
}

export const HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX =
    '--evb-host-resource-profile=';

export const HOST_TIER_LOW_RAM_MAX_GIB = 8;
export const HOST_TIER_MODEST_RAM_MAX_GIB = 12;
export const HOST_TIER_HIGH_RAM_MIN_GIB = 16;
export const HOST_TIER_LOW_CPU_MAX = 2;
export const HOST_TIER_MODEST_CPU_MAX = 4;
export const HOST_TIER_HIGH_CPU_MIN = 8;

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

export const HOST_RASTER_POOL_RAM_FRACTION = 0.06;
export const HOST_RASTER_POOL_MIN_BYTES = 128 * MIB;
export const HOST_RASTER_POOL_MAX_BYTES = 1536 * MIB;
/**
 * Floor for a single window's raster share: matches one low-tier settled RGBA
 * canvas (2^24 * 4 = 64 MiB) and half of the minimum host raster pool (128 MiB),
 * so even a 2-window session on a minimal host splits the pool cleanly without
 * starving a visible page.
 */
export const HOST_WINDOW_RASTER_SHARE_MIN_BYTES = 64 * MIB;
export const HOST_RASTER_BUDGET_MAX_WINDOWS = 1_024;

export interface IHostWindowRasterShare {
    readonly maxRasterSurfaceBytes: number;
    readonly hostPoolBytes: number;
    readonly windowCount: number;
}

function clampHostBytes(value: number, minimum: number, maximum: number) {
    return Math.min(maximum, Math.max(minimum, value));
}

export function resolveHostRasterPoolBytes(totalRamBytes: number): number | null {
    if (typeof totalRamBytes !== 'number' || !Number.isFinite(totalRamBytes) || totalRamBytes <= 0) {
        return null;
    }
    return clampHostBytes(
        totalRamBytes * HOST_RASTER_POOL_RAM_FRACTION,
        HOST_RASTER_POOL_MIN_BYTES,
        HOST_RASTER_POOL_MAX_BYTES,
    );
}

/**
 * Splits the host raster pool equally across live registered windows.
 *
 * Invariants:
 * - `hostPoolBytes` is an integer in `[128 MiB, 1536 MiB]`.
 * - `windowCount` is an integer in `[1, 1024]`.
 * - `maxRasterSurfaceBytes` is an integer in `[64 MiB, 1536 MiB]`.
 * - When `windowCount * 64 MiB <= hostPoolBytes`, `windowCount * maxRasterSurfaceBytes <= hostPoolBytes`.
 * - Monotonically non-increasing as `windowCount` grows and non-decreasing as windows close.
 */
export function resolveHostWindowRasterShare(options: {
    totalRamBytes: number;
    windowCount: number;
    fallbackPoolBytes?: number | undefined;
}): IHostWindowRasterShare {
    const windowCount = typeof options.windowCount === 'number' && Number.isFinite(options.windowCount)
        ? Math.min(HOST_RASTER_BUDGET_MAX_WINDOWS, Math.max(1, Math.floor(options.windowCount)))
        : 1;
    const detectedPoolBytes = resolveHostRasterPoolBytes(options.totalRamBytes);
    const fallbackPoolBytes = typeof options.fallbackPoolBytes === 'number'
        && Number.isFinite(options.fallbackPoolBytes)
        && options.fallbackPoolBytes > 0
        ? clampHostBytes(options.fallbackPoolBytes, HOST_RASTER_POOL_MIN_BYTES, HOST_RASTER_POOL_MAX_BYTES)
        : HOST_RASTER_POOL_MAX_BYTES;
    const hostPoolBytes = Math.floor(detectedPoolBytes ?? fallbackPoolBytes);
    const maxRasterSurfaceBytes = Math.max(
        HOST_WINDOW_RASTER_SHARE_MIN_BYTES,
        Math.floor(hostPoolBytes / windowCount),
    );
    return {
        maxRasterSurfaceBytes,
        hostPoolBytes,
        windowCount,
    };
}

function isHostResourceTier(value: unknown): value is THostResourceTier {
    return value === 'low' || value === 'medium' || value === 'high';
}

function isPerformanceMode(value: unknown): value is TPerformanceMode {
    return value === 'auto' || isHostResourceTier(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0;
}

function decodeHostGpuStatusSnapshot(value: unknown): IHostGpuStatusSnapshot | null {
    if (!isRecord(value)) {
        return null;
    }

    const snapshot: Record<string, string> = {};
    for (const [
        featureName,
        status,
    ] of Object.entries(value)) {
        if (typeof status !== 'string') {
            return null;
        }
        snapshot[featureName] = status;
    }
    return snapshot;
}

export function resolveDetectedHostResourceTier(
    inputs: IHostResourceTierInputs,
): THostResourceTier {
    const {
        logicalCpus,
        totalRamBytes,
    } = inputs;
    if (logicalCpus <= 0 || totalRamBytes <= 0) {
        return 'medium';
    }

    const ramGiB = totalRamBytes / GIB;
    if (
        ramGiB <= HOST_TIER_LOW_RAM_MAX_GIB
        || logicalCpus <= HOST_TIER_LOW_CPU_MAX
        || (ramGiB <= HOST_TIER_MODEST_RAM_MAX_GIB && logicalCpus <= HOST_TIER_MODEST_CPU_MAX)
    ) {
        return 'low';
    }
    if (ramGiB >= HOST_TIER_HIGH_RAM_MIN_GIB && logicalCpus >= HOST_TIER_HIGH_CPU_MIN) {
        return 'high';
    }
    return 'medium';
}

export function resolveEffectiveHostResourceTier(
    detectedTier: THostResourceTier,
    performanceMode: TPerformanceMode,
): THostResourceTier {
    return performanceMode === 'auto' ? detectedTier : performanceMode;
}

export function resolveDocumentSavePerformanceTier(
    tier: THostResourceTier,
): TDocumentSavePerformanceTier {
    return tier === 'medium' ? 'balanced' : tier;
}

export function decodeHostResourceProfileSnapshot(
    value: unknown,
): IHostResourceProfileSnapshot | null {
    if (
        !isRecord(value)
        || !isNonNegativeSafeInteger(value.logicalCpus)
        || !isNonNegativeSafeInteger(value.totalRamBytes)
        || typeof value.safeMode !== 'boolean'
        || !isHostResourceTier(value.detectedTier)
        || !isPerformanceMode(value.performanceMode)
        || !isHostResourceTier(value.tier)
    ) {
        return null;
    }

    const detectedTier = resolveDetectedHostResourceTier({
        logicalCpus: value.logicalCpus,
        totalRamBytes: value.totalRamBytes,
    });
    if (
        value.detectedTier !== detectedTier
        || value.tier !== resolveEffectiveHostResourceTier(
            value.detectedTier,
            value.performanceMode,
        )
    ) {
        return null;
    }

    const gpuStatus = value.gpuStatus === undefined
        ? undefined
        : decodeHostGpuStatusSnapshot(value.gpuStatus);
    if (gpuStatus === null) {
        return null;
    }

    return {
        logicalCpus: value.logicalCpus,
        totalRamBytes: value.totalRamBytes,
        safeMode: value.safeMode,
        ...(gpuStatus === undefined ? {} : {gpuStatus}),
        detectedTier: value.detectedTier,
        performanceMode: value.performanceMode,
        tier: value.tier,
    };
}
