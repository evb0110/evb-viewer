import type {
    IScanCleanupOptions,
    TScanCleanupOutputMode,
    TScanCleanupOutputModeSetting,
} from '@contracts/electronApiScanCleanup';
import type {IDetectedPageRaster} from '@evb/scan-cleanup/core/types';

/**
 * A compact MRC/JBIG2 scan is already an optimized representation. Automatic
 * cleanup may spend some bytes on pages it materially changes, but it must not
 * silently flatten the whole book into full-resolution continuous-tone images.
 */
export const SCAN_CLEANUP_COMPACT_SOURCE_MAX_BYTE_RATIO = 2.5;
export const SCAN_CLEANUP_COMPACT_SOURCE_FIXED_BYTE_ALLOWANCE = 8 * 1024 * 1024;
const COMPACT_SOURCE_PAGE_MAJORITY = 0.5;

/**
 * Reuse an MRC/JBIG2 source foreground only when the requested output is
 * allowed to remain bilevel. Explicit B/W needs the same contour-preserving
 * source ownership as Auto; tonal modes continue to render the composite.
 */
export function shouldExtractTrustedMrcForeground(
    documentOutputMode: TScanCleanupOutputModeSetting,
    pageOutputModeOverride: TScanCleanupOutputMode | undefined,
): boolean {
    if (pageOutputModeOverride !== undefined) {
        return pageOutputModeOverride === 'bw';
    }
    return documentOutputMode === 'auto' || documentOutputMode === 'bw';
}

export interface IScanCleanupCompactSourceBudget {
    compactLayeredPages: number;
    maxOutputBytes: number;
    sourceBytes: number;
}

function isCompactLayeredRaster(raster: IDetectedPageRaster | undefined) {
    return raster?.hasBilevelLayer === true
        && raster.backgroundDpi !== undefined
        && Number.isFinite(raster.backgroundDpi)
        && raster.backgroundDpi > 0;
}

export function resolveScanCleanupCompactSourceBudget(input: {
    documentPageCount: number;
    options: IScanCleanupOptions;
    pageRasterByNumber?: ReadonlyMap<number, IDetectedPageRaster>;
    compactLayeredPageCount?: number;
    partialRun: boolean;
    sourceBytes: number;
}): IScanCleanupCompactSourceBudget | null {
    if (
        input.partialRun
        || input.options.outputMode !== 'auto'
        || !Number.isFinite(input.sourceBytes)
        || input.sourceBytes <= 0
        || input.options.pageOverrideDefaults?.outputModeOverride !== undefined
        || Object.values(input.options.pageOverrides).some(
            pageOverride => pageOverride.outputModeOverride !== undefined,
        )
    ) {
        return null;
    }
    const compactLayeredPages = input.compactLayeredPageCount ?? (() => {
        let count = 0;
        for (const [
            pageNumber,
            raster,
        ] of input.pageRasterByNumber ?? []) {
            if (pageNumber >= 1 && pageNumber <= input.documentPageCount && isCompactLayeredRaster(raster)) {
                count += 1;
            }
        }
        return count;
    })();
    if (
        !Number.isSafeInteger(compactLayeredPages)
        || compactLayeredPages < 0
        || compactLayeredPages > input.documentPageCount
    ) {
        return null;
    }
    if (
        compactLayeredPages === 0
        || compactLayeredPages / input.documentPageCount < COMPACT_SOURCE_PAGE_MAJORITY
    ) {
        return null;
    }
    return {
        compactLayeredPages,
        sourceBytes: input.sourceBytes,
        maxOutputBytes: Math.ceil(Math.max(
            input.sourceBytes * SCAN_CLEANUP_COMPACT_SOURCE_MAX_BYTE_RATIO,
            input.sourceBytes + SCAN_CLEANUP_COMPACT_SOURCE_FIXED_BYTE_ALLOWANCE,
        )),
    };
}

export function assertScanCleanupCompactSourceBudget(
    outputBytes: number,
    budget: IScanCleanupCompactSourceBudget | null,
) {
    if (budget === null || outputBytes <= budget.maxOutputBytes) {
        return;
    }
    throw new Error(
        'Automatic scan cleanup refused to publish a compact layered source '
        + `that expanded from ${String(budget.sourceBytes)} to ${String(outputBytes)} bytes `
        + `(budget ${String(budget.maxOutputBytes)} bytes)`,
    );
}
