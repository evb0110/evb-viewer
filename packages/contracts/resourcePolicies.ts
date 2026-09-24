import { isRecord } from '@contracts/runtimeGuards';

export const SCAN_CLEANUP_MAX_RASTER_CONCURRENCY = 64;

export interface IScanCleanupRuntimePolicy {
    rasterConcurrency: number;
    rasterStreaming: boolean;
    logicalCpus: number;
    totalRamBytes: number;
    /** Optional for compatibility with callers predating low-memory raster admission. */
    rasterMaxPixels?: number;
}

export function parseBoundedEnvInt(
    value: string | undefined,
    {
        clampBelowMin = false,
        fallback,
        min,
        max,
        requireSafeInteger = false,
    }: {
        clampBelowMin?: boolean;
        fallback: number;
        min: number;
        max?: number;
        requireSafeInteger?: boolean;
    },
): number {
    const parsed = Number.parseInt(value ?? '', 10);
    if (
        !Number.isFinite(parsed)
        || (requireSafeInteger && !Number.isSafeInteger(parsed))
    ) {
        return fallback;
    }
    if (parsed < min) {
        return clampBelowMin ? min : fallback;
    }
    return max === undefined ? parsed : Math.min(parsed, max);
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0;
}

function isPositiveSafeIntegerAtMost(
    value: unknown,
    max: number,
): value is number {
    return isPositiveSafeInteger(value) && value <= max;
}

export function decodeScanCleanupRuntimePolicy(
    value: unknown,
): IScanCleanupRuntimePolicy | null {
    const rasterMaxPixels = isRecord(value) ? value.rasterMaxPixels : undefined;
    if (
        !isRecord(value)
        || !isPositiveSafeIntegerAtMost(
            value.rasterConcurrency,
            SCAN_CLEANUP_MAX_RASTER_CONCURRENCY,
        )
        || typeof value.rasterStreaming !== 'boolean'
        || !isNonNegativeSafeInteger(value.logicalCpus)
        || !isNonNegativeSafeInteger(value.totalRamBytes)
        || (rasterMaxPixels !== undefined && !isPositiveSafeInteger(rasterMaxPixels))
    ) {
        return null;
    }

    return {
        rasterConcurrency: value.rasterConcurrency,
        rasterStreaming: value.rasterStreaming,
        logicalCpus: value.logicalCpus,
        totalRamBytes: value.totalRamBytes,
        ...(rasterMaxPixels === undefined ? {} : {rasterMaxPixels}),
    };
}
